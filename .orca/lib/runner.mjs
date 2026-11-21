// Pipeline runner: spec rendering, dry-run plan printer, startup chooser,
// readiness gate, parallel/serial group execution, approval gate, and
// integration with isolated worktrees, hard gates, proven cross-family review
// isolation, strict dispatch fencing, absolute deadlines, health machine & ledger.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { materializeAgentConfig, restoreAgentConfig } from "../agent-config.mjs";
import { verifyStepArtifact, formatVerifySummary } from "../gate-verify.mjs";
import {
  WORKTREES_MANIFEST,
  recordVerifiedContractCommit,
  clearStaleStepArtifact,
  bindStepArtifactDispatchClaim,
  syncOutputsFromIsolatedWorktree,
  prepareStepWorktree,
  finalizeStepWorktree,
  renderIsolatedWorktreeNote,
} from "../worktree-isolation.mjs";
import { computeFileSha256 } from "../ledger.mjs";
import {
  classifyMergeDanger,
  snapshotTargetRefs,
  formatMergeDangerPromptBlock,
} from "../merge-danger.mjs";
import { initMemberHealth, evaluateMemberHealth } from "../health.mjs";
import { createWatchdogTracker, evaluateWatchdog } from "../watchdog.mjs";
import {
  classifyModelFamily,
  resolveEffectiveLaunchSpec,
  resolveEffectiveCandidateModel,
  isCrossFamilyReviewStep,
  resolveAuthorStepIds,
  buildCandidateChain,
  filterCrossFamilyCandidates,
  selectHealthyCandidate,
} from "../preflight.mjs";
import { formatIssuePrBlock } from "../issue-tracker.mjs";
import {
  pick, res, sleepMs, parkedPromptOf, outcomeOf, promptChoice,
  verifyStopAndReleaseReceipt, verifyManualStopAndReleaseReceipt, verifyManualTerminalClosed,
} from "./orca-cli.mjs";
import { createNudgeController } from "./nudge.mjs";
import { parseStatusJs } from "./status.mjs";
import { sanitizeText } from "./sanitize.mjs";

class FlowFatalError extends Error {
  constructor(message) {
    super(message);
    this.name = "FlowFatalError";
  }
}

const taskOfMsg = (m) => pick(m, ["taskId", "task_id", "task"]);

export function dispatchOfMsg(m) {
  if (!m || typeof m !== "object") return null;
  const direct = pick(m, ["dispatchId", "dispatch_id", "dispatch", "fromDispatchId", "contextId", "ctxId"]);
  if (direct && String(direct).trim()) return String(direct).trim();
  if (m.payload != null) {
    let p = m.payload;
    if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
    const nested = pick(p || {}, ["dispatchId", "dispatch_id", "dispatch", "contextId"]);
    if (nested && String(nested).trim()) return String(nested).trim();
  }
  return null;
}

export function promptReadiness(question) {
  return new Promise((resolveAns) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { rl.close(); } catch {} resolveAns(v); };
    rl.on("close", () => done(false));
    rl.question(question, (answer) => done(/^(y|yes)$/i.test(String(answer ?? "").trim())));
  });
}

export async function runEarlyChooser({ opt, cfg, artDir, getWtPath, archiveCurrentRun, copyRunFiles, listRuns, printRunList, log }) {
  if (opt.dryRun || opt.statusPreview || opt.from || opt.only || opt.newRun) return false;
  const entries = listRuns();
  if (!entries.length) return false;
  printRunList(entries);
  const answer = await promptChoice("Choose: <n> = resume that run, 0/Enter = start a new run: ");
  const t = answer.trim();
  const idx = /^\d+$/.test(t) ? Number(t) : NaN;
  const chosen = Number.isInteger(idx) && idx >= 1 && idx <= entries.length ? entries[idx - 1] : null;
  if (!chosen) return false;
  const order = (cfg.pipeline || []).filter((s) => s && s.id && s.enabled !== false).map((s) => s.id);
  const stOf = (id) => (chosen.S.steps || []).find((s) => s.id === id);
  const firstPending = order.find((id) => stOf(id)?.status !== "succeeded");
  if (!firstPending) { log(`[history] run ${chosen.label} already completed — starting a new run instead.`); return false; }
  if (chosen.dir) {
    archiveCurrentRun();
    const n = copyRunFiles(chosen.dir, join(getWtPath() || ".", artDir), "(restore)");
    log(`[history] restored run ${chosen.label} (${n} files) — resuming from "${firstPending}".`);
  } else {
    log(`[history] resuming the current run from "${firstPending}".`);
  }
  opt.from = firstPending;
  return true;
}

export function createRunner({
  here, cfg, opt, objective, configFile, artDir, autoRun,
  targetBranch, defaultBranch = null, protectedBranches, mergeDangerThresholds,
  turnStartWindowMs, turnStartEscalateMs, readinessRetries, readinessMinBytes,
  allSteps, steps, byId, enabledIds, groups, isParallel,
  agentOf, modelOf: modelOfArg = null, effectiveModel, timeoutOf, nudgeRetriesOf, nudgeTimeoutOf, outPath,
  orcaClient, statusMgr, notifier, getLedger, getBoundPreviousLedger = () => null, getWtDir,
  getIssueState = () => null, getIssueProvider = () => null, issueTrackingCfg = null,
  isolatedState, preStepTargetRefs, setLastMergeDanger, log, warn, die,
}) {
  const modelOf = modelOfArg || ((s) => {
    const m = s.model !== undefined ? s.model : cfg.defaults?.model;
    const t = m == null ? "" : String(m).trim();
    return t && t !== "default" ? t : null;
  });
  const { orca, resolveWorktree, resolveWorktreePath, startWorker, workerVitals, wtSource, getRunId, getWt, getWtPin, getOrcaBin } = orcaClient;
  const { statusOf, statusSet, statusBegin, statusEnd, writeStatus, refreshProgress, writeArtifactSnapshot, listRuns, printRunList } = statusMgr;
  const taskIds = {};
  // P0-03: Accumulate ALL model families & contributions per step across retries/fallbacks
  const executedStepInfo = {}; // stepId -> { agent, model, family, executedFamilies: string[], contributions: Array<{agent,model,family}> }
  let attemptSeq = 0;

  // Synthetic mock bypass applies ONLY when every enabled step uses `stub` and no `crossFamilyWith` is configured (e.g. E31)
  const isPureStubPipeline = allSteps.every((s) => agentOf(s) === "stub" && !modelOf(s) && !s.crossFamilyWith);

  function recordExecutedStep(stepId, agent, model, worktreeDir = null) {
    const pDir = worktreeDir || getWtDir() || process.cwd();
    const launch = resolveEffectiveLaunchSpec(agent, model, null, { projectDir: pDir });
    const cleanModel = launch.effectiveModel;
    const family = classifyModelFamily(agent, model, { projectDir: pDir });

    // Seed from previous status ONLY if its provenance was verified against a bound ledger!
    const prevSt = statusOf ? statusOf(stepId) : null;
    const prevFamilies = (prevSt?.provenanceVerified === true && Array.isArray(prevSt?.executedFamilies))
      ? prevSt.executedFamilies
      : [];
    const prevInfo = executedStepInfo[stepId] || {
      executedFamilies: [...prevFamilies],
      contributions: prevFamilies.map((f) => ({ agent: prevSt?.agent || agent, model: prevSt?.model || "default", family: f })),
    };

    const famList = [...new Set([...prevInfo.executedFamilies, family].filter(Boolean))];
    const contributions = [...prevInfo.contributions, { agent, model: cleanModel || "default", family }];

    executedStepInfo[stepId] = {
      agent,
      model: cleanModel || "default",
      family,
      executedFamilies: famList,
      contributions,
    };
    statusSet(stepId, {
      agent,
      model: cleanModel || "default",
      family,
      executedFamilies: famList,
      provenanceVerified: true,
    });
    return executedStepInfo[stepId];
  }

  /**
   * Resolve ALL executed author families for `authorId`.
   * During real execution (`!dryRun`), NEVER trusts unverified `status.js` or static step config —
   * requires in-process execution OR a run/lineage-bound ledger record with dispatch + artifact SHA proof!
   */
  function getAuthorExecutionEvidence(authorId, { dryRun = false, projectDir = null } = {}) {
    const defStep = byId[authorId];
    if (defStep && defStep.enabled === false) {
      return { skippedDisabled: true, families: [], contributions: [] };
    }

    if (executedStepInfo[authorId]) {
      const info = executedStepInfo[authorId];
      const st = statusOf ? statusOf(authorId) : null;
      const settledOk = !st || st.status === "succeeded";
      const hasUnknown = info.executedFamilies.length === 0 || info.executedFamilies.includes("unknown");
      if (!settledOk) {
        return { ok: false, reason: `author step "${authorId}" has not succeeded (status=${st?.status || "pending"})` };
      }
      if (hasUnknown && !isPureStubPipeline) {
        return { ok: false, reason: `author step "${authorId}" executed with unproven/unknown model family (${info.agent}:${info.model})` };
      }
      return { ok: true, families: info.executedFamilies, contributions: info.contributions };
    }

    // P0-03: Strictly require BOTH a succeeded status entry AND a verified run-bound ledger record!
    // Never trust a bare/unbound `status.js` lacking a matching ledger run record!
    const st = statusOf ? statusOf(authorId) : null;
    const boundLedger = getBoundPreviousLedger ? getBoundPreviousLedger() : null;
    const ls = boundLedger?.steps?.[authorId] || null;

    if (st && st.status === "succeeded") {
      if (isPureStubPipeline) {
        return { ok: true, families: ["stub"], contributions: [{ agent: "stub", model: "default", family: "stub" }] };
      }
      if (!boundLedger || !ls) {
        return {
          ok: false,
          reason: `no verified execution record for upstream author step "${authorId}" in bound run ledger (unbound status.js is not trusted)`,
        };
      }
      if (ls.outcome !== "succeeded" || (!ls.dispatchId && !ls.terminal)) {
        return {
          ok: false,
          reason: `ledger record for upstream author step "${authorId}" is incomplete or not succeeded (outcome=${ls.outcome || "unknown"})`,
        };
      }
      if (defStep?.writes) {
        const expectedAuthorSha = typeof ls.artifactSha256 === "string" && /^[0-9a-f]{64}$/i.test(ls.artifactSha256.trim())
          ? ls.artifactSha256.trim().toLowerCase()
          : null;
        if (!expectedAuthorSha) {
          return {
            ok: false,
            reason: `ledger record for upstream author step "${authorId}" lacks mandatory artifactSha256 digest`,
          };
        }
        const curArtPath = join(getWtDir() || ".", artDir, defStep.writes);
        const curArtSha = computeFileSha256(curArtPath);
        if (!curArtSha || curArtSha.toLowerCase() !== expectedAuthorSha) {
          return {
            ok: false,
            reason: `artifact "${defStep.writes}" for author step "${authorId}" no longer matches its ledger-recorded SHA-256`,
          };
        }
      }
      const fams = Array.isArray(ls.executedFamilies) && ls.executedFamilies.length
        ? ls.executedFamilies
        : (ls.family ? [ls.family] : []);
      if (fams.length > 0 && !fams.includes("unknown")) {
        return {
          ok: true,
          families: [...new Set(fams)],
          contributions: fams.map((f) => ({ agent: ls.agent || st.agent || "unknown", model: ls.model || st.model || "default", family: f })),
        };
      }
      return { ok: false, reason: `resumed author step "${authorId}" lacks proven model family in bound run ledger` };
    }

    if (dryRun && defStep) {
      const ag = agentOf(defStep);
      const md = modelOf(defStep);
      const fam = classifyModelFamily(ag, md, { projectDir: projectDir || process.cwd() });
      if (fam && fam !== "unknown") {
        return { ok: true, families: [fam], contributions: [{ agent: ag, model: md || "default", family: fam }] };
      }
      return { ok: true, families: [], contributions: [] };
    }

    return { ok: false, reason: `no verified execution record for upstream author step "${authorId}" in current/resumed run` };
  }

  function verifySkippedReviewProvenance(reviewStep, wtDir) {
    const boundLedger = getBoundPreviousLedger ? getBoundPreviousLedger() : null;
    const ls = boundLedger?.steps?.[reviewStep.id] || null;
    if (!boundLedger || !ls) {
      return { ok: false, reason: `skipped review step "${reviewStep.id}" lacks a verified run-bound ledger record` };
    }
    if (boundLedger.configFile && configFile && boundLedger.configFile !== configFile) {
      return { ok: false, reason: `skipped review step "${reviewStep.id}" ledger belongs to config "${boundLedger.configFile}" (expected "${configFile}")` };
    }
    if (ls.outcome !== "succeeded" || ls.verifyOk === false || (!ls.dispatchId && !ls.terminal)) {
      return { ok: false, reason: `skipped review step "${reviewStep.id}" is not verified succeeded in bound ledger` };
    }
    // P0-03: Mandatory SHA-256 review digest — missing digest MUST fail closed!
    if (!reviewStep.writes) {
      return { ok: false, reason: `skipped review step "${reviewStep.id}" has no declared writes artifact` };
    }
    const expectedSha = typeof ls.artifactSha256 === "string" && /^[0-9a-f]{64}$/i.test(ls.artifactSha256.trim())
      ? ls.artifactSha256.trim().toLowerCase()
      : null;
    if (!expectedSha) {
      return { ok: false, reason: `skipped review step "${reviewStep.id}" lacks mandatory artifactSha256 digest in bound ledger` };
    }
    const curSha = computeFileSha256(join(wtDir, artDir, reviewStep.writes));
    if (!curSha || curSha.toLowerCase() !== expectedSha) {
      return { ok: false, reason: `artifact "${reviewStep.writes}" for skipped review "${reviewStep.id}" was modified outside bound ledger` };
    }
    const revFams = Array.isArray(ls.executedFamilies) && ls.executedFamilies.length
      ? ls.executedFamilies
      : (ls.family ? [ls.family] : []);
    if (!revFams.length || revFams.includes("unknown")) {
      return { ok: false, reason: `skipped review step "${reviewStep.id}" has unproven model family in ledger` };
    }
    for (const authorId of resolveAuthorStepIds(reviewStep, byId)) {
      const ev = getAuthorExecutionEvidence(authorId, { dryRun: false, projectDir: wtDir });
      if (ev.skippedDisabled) continue;
      if (!ev.ok) {
        return { ok: false, reason: `skipped review step "${reviewStep.id}" upstream author "${authorId}" unverified: ${ev.reason}` };
      }
      const overlap = ev.families.find((f) => revFams.includes(f));
      if (overlap) {
        return { ok: false, reason: `skipped review step "${reviewStep.id}" family "${overlap}" conflicts with upstream author "${authorId}"` };
      }
    }
    return { ok: true, reason: null };
  }

  function computeReviewIsolationContext(step, { dryRun = false, projectDir = null } = {}) {
    const forbiddenByFamily = new Map(); // family -> Array<{ stepId, agent, model }>
    const unprovenAuthors = [];
    if (!isCrossFamilyReviewStep(step)) return { forbiddenByFamily, unprovenAuthors };

    for (const authorId of resolveAuthorStepIds(step, byId)) {
      const ev = getAuthorExecutionEvidence(authorId, { dryRun, projectDir });
      if (ev.skippedDisabled) continue;
      if (!ev.ok) {
        unprovenAuthors.push({ stepId: authorId, reason: ev.reason });
        continue;
      }
      for (const c of ev.contributions) {
        if (!c.family) continue;
        if (!forbiddenByFamily.has(c.family)) forbiddenByFamily.set(c.family, []);
        forbiddenByFamily.get(c.family).push({ stepId: authorId, agent: c.agent, model: c.model });
      }
    }
    return { forbiddenByFamily, unprovenAuthors };
  }

  function effectiveReads(step) {
    return (step.reads || []).filter((id) => {
      if (!byId[id]) return false;
      if (enabledIds.has(id)) return true;
      const p = resolveWorktreePath(true);
      return p ? existsSync(join(p, artDir, byId[id].writes)) : false;
    });
  }

  function renderSpec(step, stepCtx = null) {
    const reads = effectiveReads(step);
    const readList = reads.length
      ? reads.map((id) => `${byId[id].title} (${outPath(byId[id].writes)})`).join(", ")
      : "(no prior input — start from the objective)";
    const objectiveLine = `OVERALL OBJECTIVE: ${objective}\n\n`;
    const autonomy = (autoRun && step.id !== "grill")
      ? "\n\nAUTONOMY: this pipeline runs unattended — do NOT ask the user questions and do NOT wait for confirmation. When something is ambiguous, decide with your best judgment and record it in {out} under an 'Assumptions & decisions' section."
      : "";
    const interview = (!autoRun && step.interactive)
      ? "\n\nINTERACTIVE SESSION (manual mode): this pipeline runs with user oversight — ALIGN WITH THE USER before finalizing. Interview protocol, follow exactly: (1) Ask ONE question at a time in this terminal and WAIT for the answer; never batch questions. (2) Cover, roughly in order: alignment with the functional requirements and scope; non-functional requirements; performance targets and expected load; security and compliance constraints; scalability and growth expectations; database and persistence choices; technology constraints and team preferences; deployment and operations. (3) Prefer multiple choice; open-ended only when options would bias the answer. (4) After each answer, restate your understanding in one short line so the user can correct you early. (5) Finish with a numbered DECISIONS list (decision + rationale) and get the user's confirmation on each before writing {out}. Include the confirmed decisions and any remaining open points in {out}."
      : "";
    const wtNote = renderIsolatedWorktreeNote(stepCtx, outPath(step.writes));
    let mergeDangerBlock = "";
    if (step.verify?.mergeDangerCheck) {
      const mdDir = stepCtx?.isolated ? stepCtx.dir : (resolveWorktreePath(true) || ".");
      const pinnedBase = preStepTargetRefs[step.id]?.localSha || preStepTargetRefs[step.id]?.originSha || targetBranch;
      const cls = classifyMergeDanger(mdDir, pinnedBase, { thresholds: mergeDangerThresholds });
      if (!opt.dryRun) setLastMergeDanger(cls);
      mergeDangerBlock = formatMergeDangerPromptBlock(cls, targetBranch, opt.allowOneWayMerge);
    }
    const hasPlaceholder = (step.spec || "").includes("{mergeDangerReport}");
    const mdSuffix = (!hasPlaceholder && mergeDangerBlock) ? `\n\nMERGE DANGER PRE-CHECK:\n${mergeDangerBlock}` : "";

    const issuesDisabled = issueTrackingCfg?.mode === false || opt.noIssues;
    const issueState = issuesDisabled ? null : (getIssueState ? getIssueState() : null);
    const provInfo = issuesDisabled ? null : (getIssueProvider ? getIssueProvider() : null);
    // P1-08: Never blindly guess "main" when defaultBranch is unknown; pass actual host & repo!
    const effDefaultBranch = defaultBranch || provInfo?.defaultBranch || issueState?.defaultBranch || null;
    const closeOnPr = issueTrackingCfg?.closeOnPr ?? true;
    const issueFmt = formatIssuePrBlock(issueState, {
      closeOnPr,
      targetBranch,
      defaultBranch: effDefaultBranch,
      provider: provInfo?.provider || issueState?.provider || null,
      host: provInfo?.host || issueState?.host || null,
      repo: provInfo?.repo || issueState?.repo || null,
      teaLogin: provInfo?.teaLogin || issueState?.teaLogin || null,
    });
    const prStepIds = new Set(issueTrackingCfg?.prSteps || ["pr-submit", "pr-release-dev"]);
    const isPrStep = Boolean(step.linkIssues || prStepIds.has(step.id));
    const hasTraceTok = (step.spec || "").includes("{issueTraceability}");
    const hasAnyIssueTok = /\{(?:issueRefs|issueCloses|issueTraceability)\}/.test(step.spec || "");
    let issueSuffix = "";
    if (isPrStep && issueFmt.block) {
      if (!hasAnyIssueTok) issueSuffix = `\n\n${issueFmt.block}`;
      else if (!hasTraceTok && issueFmt.nonDefaultBranchGuidance) issueSuffix = `\n\n${issueFmt.nonDefaultBranchGuidance}`;
    }

    const gateAttestationNote = (step.verify && step.writes)
      ? `\n\nGATE PROVENANCE (MANDATORY): Include your exact active Orca dispatch ID (from your dispatch preamble's \`--dispatch-id <id>\`) near the top of {out} as \`Dispatch-ID: <id>\` (or \`<!-- orca-dispatch: <id> -->\`), or write to \`${artDir}/.dispatch-<id>/${step.writes}\`. Gate artifacts lacking active dispatch provenance are rejected.`
      : "";

    const rep = (str, tok, val) => str.replaceAll(tok, () => val);
    let rendered = objectiveLine + (step.spec || "") + autonomy + interview + wtNote + gateAttestationNote + mdSuffix + issueSuffix;
    rendered = rep(rendered, "{mergeDangerReport}", mergeDangerBlock || "(no merge-danger check configured)");
    rendered = rep(rendered, "{epicIssue}", issueFmt.epicIssue || "(none)");
    rendered = rep(rendered, "{issueRefs}", issueFmt.issueRefs || "(no linked issues)");
    rendered = rep(rendered, "{issueCloses}", issueFmt.issueCloses || "(no linked issues)");
    rendered = rep(rendered, "{issueTraceability}", issueFmt.block || "(no linked issues)");
    rendered = rep(rendered, "{out}", outPath(step.writes));
    rendered = rep(rendered, "{tasks}", step.progress ? outPath(step.progress) : "{tasks}");
    rendered = rep(rendered, "{reads}", readList);
    rendered = rep(rendered, "{targetBranch}", targetBranch);
    rendered = rep(rendered, "{protectedBranches}", protectedBranches.join(", "));
    rendered = rep(rendered, "{worktreesManifest}", outPath(WORKTREES_MANIFEST));
    return rendered;
  }

  function printPlan() {
    const previewDir = resolveWorktreePath(true) || process.cwd();
    log(`Config: ${configFile}${opt.config ? "" : " (default)"}`);
    log(`Worktree: ${getWt() || getWtPin() || "(auto-detect, unresolved in dry-run)"}  (${wtSource()})`);
    log(`Target branch: ${targetBranch} (protected: ${protectedBranches.join(", ")})`);
    log(`Auto-run: ${autoRun ? "on — agents run unattended, gates ignored" : "off — steps with 'gate' block for approval"}`);
    log(`Notifications: ${notifier.state.on ? `on (${notifier.state.cfg.provider}, events: ${[...notifier.state.events].join(",")})` : "off"}`);
    if (opt.dryRun) {
      const prev = listRuns();
      if (prev.length) { log(""); printRunList(prev); }
    }
    log("Pipeline to run (in order):");
    steps.forEach((s, i) => {
      const reads = effectiveReads(s);
      const model = effectiveModel(s);
      const flags = [];
      if (s.onFailGoto && enabledIds.has(s.onFailGoto))
        flags.push(`onFail->${s.onFailGoto}${s.maxRetries != null ? ` x${s.maxRetries}` : ""}`);
      if (s.gate && !autoRun) flags.push("gate");
      if (s.interactive && !autoRun) flags.push("interactive");
      if (s.parallelWith) flags.push(`parallel-with ${s.parallelWith}`);
      else if (isParallel.has(s.id)) flags.push("parallel-group");
      if ((s.skills || []).length) flags.push(`skills=${s.skills.join(",")}`);
      if ((s.mcp || []).length) flags.push(`mcp=${s.mcp.join(",")}`);
      if (s.isolatedWorktree) flags.push("isolated-wt");
      const vSum = formatVerifySummary(s.verify);
      if (vSum) flags.push(`verify=${vSum}`);
      const { forbiddenByFamily } = computeReviewIsolationContext(s, { dryRun: true, projectDir: previewDir });
      const cands = buildCandidateChain(s, cfg, { agentOf, modelOf, forbiddenFamilies: new Set(forbiddenByFamily.keys()), projectDir: previewDir });
      if (isCrossFamilyReviewStep(s)) flags.push("cross-family");
      if (cands.length > 1) {
        flags.push(`fallback=${cands.slice(1).map((c) => c.model ? `${c.agent}(${c.model})` : c.agent).join("->")}`);
      }
      console.log(
        `  ${i + 1}. ${s.title.padEnd(26)} agent=${agentOf(s).padEnd(9)}` +
        `${model ? ` model=${model}` : ""} ` +
        `reads=[${reads.join(", ") || "-"}] writes=${s.writes}` +
        (flags.length ? `  {${flags.join(", ")}}` : "")
      );
    });
    const pg = groups.filter((g) => g.length > 1);
    if (pg.length)
      log(`Parallel groups: ${pg.map((g) => g.map((m) => m.id).join(" ∥ ")).join("; ")} — each group starts together; the next step waits for all of them.`);
    const skipped = allSteps.filter((s) => !enabledIds.has(s.id)).map((s) => s.id);
    if (skipped.length) log(`Skipped: ${skipped.join(", ")}`);
  }

  function ensureTask(step, stepCtx = null, { skipReopenReady = false, deadlineAt = null } = {}) {
    if (taskIds[step.id]) {
      if (!skipReopenReady) {
        const u = orca(["orchestration", "task-update", "--id", taskIds[step.id], "--status", "ready"], { deadlineAt });
        if (u.deadlineExceeded) return null;
        if (!u.ok) {
          throw new FlowFatalError(`reopen of task '${step.title}' (${taskIds[step.id]}) failed: ${sanitizeText(u.stderr || u.raw, { maxLen: 240 })}`);
        }
      }
      return taskIds[step.id];
    }
    const spec = `# ${step.title}\n\n${renderSpec(step, stepCtx)}`;
    const r = orca(["orchestration", "task-create", "--run", getRunId(), "--spec", spec], { deadlineAt });
    if (r.deadlineExceeded) return null;
    const id = pick(res(r.json).task || {}, ["id"]) || pick(res(r.json), ["taskId", "task_id", "id"]);
    if (!id) throw new FlowFatalError(`task-create '${step.title}' returned no taskId. Output: ${sanitizeText(r.raw || r.stderr, { maxLen: 240 })}`);
    taskIds[step.id] = id;
    return id;
  }

  function artifactReady(id) {
    try { return statSync(join(getWtDir() || ".", artDir, byId[id].writes)).size >= readinessMinBytes; }
    catch { return false; }
  }

  function settleMember(m, outcome, done) {
    m.settled = true;
    m.outcome = outcome;
    m.done = done || null;
    if (m.ctx?.isolated)
      syncOutputsFromIsolatedWorktree({ step: m.step, stepWtDir: m.ctx.dir, wtDir: getWtDir() || ".", artDirRel: artDir, minSourceMtimeMs: m.fsEpochMtimeMs ?? m.clearedAtMs, dispatchId: m.dispatchId || null });
    refreshProgress(m.step);
    writeArtifactSnapshot(m.step);
    statusEnd(m.step.id, outcome, m.note);
    notifier.notifyStep(m);
    if (!m.done) return;
    // P0-01: Select manual vs supervised cleanup STRICTLY by launcher-assigned `m.startMode`,
    // NEVER by whether `m.terminal` / `m.nudgeTerminal` was populated later!
    if (m.startMode === "manual") {
      const mr = verifyManualStopAndReleaseReceipt(orca, m.dispatchId || null, m.terminal);
      if (!mr.ok) warn(`manual terminal close/release '${m.step.title}' did not confirm: ${mr.reason}`);
    } else if (m.dispatchId) {
      const rel = orca(["orchestration", "worker-release", "--dispatch", m.dispatchId], { allowPostDeadlineCleanup: true, timeoutMs: 3000 });
      const relJson = res(rel.json);
      const relDispId = pick(relJson, ["dispatchId", "dispatch_id", "id"]) || pick(relJson.dispatch || {}, ["id", "dispatchId"]) || null;
      const relAction = String(pick(relJson, ["action", "status", "releaseStatus", "state"]) || "").trim().toLowerCase();
      const keptOpen = Boolean(
        relJson?.keptOpen === true ||
        relJson?.kept_open === true ||
        relJson?.retained === true ||
        relAction === "retained" ||
        relAction === "kept_open" ||
        relAction === "release_unknown" ||
        relAction === "release_pending"
      );
      if (!rel.ok || relAction === "release_unknown" || relAction === "release_pending") {
        warn(`worker-release '${m.step.title}' (${m.dispatchId}) returned ${relAction || sanitizeText(rel.stderr || rel.raw, { maxLen: 200 })}`);
      }
      // P0-01: Respect Orca's supervised release retention decision — ONLY close `m.nudgeTerminal`
      // when `nudgeTerminal` was positively attributed to `m.dispatchId` AND `worker-release`
      // positively released `m.dispatchId` without `retained` / `keptOpen`!
      if (
        m.nudgeTerminal &&
        m.nudgeTerminalDispatchId === m.dispatchId &&
        rel.ok &&
        relDispId === m.dispatchId &&
        !keptOpen &&
        (relAction === "released" || relAction === "already_released" || relAction === "closed")
      ) {
        orca(["terminal", "close", "--terminal", m.nudgeTerminal], { allowPostDeadlineCleanup: true, timeoutMs: 3000 });
      }
    }
  }

  const nudgeCtrl = createNudgeController({
    orca, pick, res, sleepMs, parkedPromptOf,
    nudgeRetriesOf, nudgeTimeoutOf, outPath, artifactReady,
    statusSet, writeStatus, warn, settleMember,
    syncOutputsFromIsolatedWorktree, getWtDir, artDir,
  });

  /**
   * P0-01: Require POSITIVE stop & release confirmation before reusing any Task or Worktree.
   * Splits manual (`m.startMode === "manual"`) vs supervised (`cold`) dispatch stop/release verification cleanly!
   */
  function stopAndIsolateWorker(m, reason = "watchdog") {
    const LEDGER = getLedger();
    if (m.startMode === "manual") {
      const mr = verifyManualStopAndReleaseReceipt(orca, m.dispatchId || null, m.terminal);
      if (!mr.ok) {
        return { ok: false, reason: mr.reason };
      }
      LEDGER?.recordWorkerStopped?.({
        stepId: m.step.id,
        dispatchId: m.dispatchId || null,
        terminal: m.terminal,
        agent: m.activeCandidate?.agent || agentOf(m.step),
        reason,
      });
      return { ok: true };
    }

    if (m.dispatchId) {
      const sr = verifyStopAndReleaseReceipt(orca, m.dispatchId);
      if (!sr.ok) {
        return { ok: false, reason: sr.reason };
      }
      LEDGER?.recordWorkerStopped?.({
        stepId: m.step.id,
        dispatchId: m.dispatchId,
        terminal: null,
        agent: m.activeCandidate?.agent || agentOf(m.step),
        reason,
      });
      return { ok: true };
    }
    return { ok: false, reason: "missing dispatchId and manual startMode — cannot prove worker stopped" };
  }

  /**
   * P0-01: Strictly bind `worker_done` messages to the member's active `dispatchId`.
   * Never accept bare taskId-only or sole-open-member `worker_done` when `m.dispatchId` is set!
   */
  function matchesMemberDone(msg, m) {
    if (pick(msg, ["type"]) !== "worker_done") return false;
    const msgDisp = dispatchOfMsg(msg);
    const msgTask = taskOfMsg(msg);
    if (m.dispatchId) {
      if (!msgDisp) {
        if (msgTask === m.taskId) {
          warn(`[stale-dispatch] ignoring unattributed worker_done missing dispatchId on "${m.step.title}" (active dispatch="${m.dispatchId}").`);
        }
        return false;
      }
      if (msgDisp !== m.dispatchId) {
        if (msgTask === m.taskId || m.supersededDispatches?.has(msgDisp)) {
          warn(`[stale-dispatch] ignoring late worker_done from superseded dispatch "${msgDisp}" on "${m.step.title}" (active dispatch="${m.dispatchId}").`);
        }
        return false;
      }
      return true;
    }
    return false;
  }

  function rematerializeForCandidate(step, activeAgent, worktreeDir, sharedPrepared, materializedDirs) {
    const hasRefs = Boolean((step.skills || []).length || (step.mcp || []).length);
    if (!hasRefs && !sharedPrepared?.some((p) => (p.step.skills || []).length || (p.step.mcp || []).length)) return;
    const mountDie = (msg) => { throw new FlowFatalError(msg); };
    // P1-04: Register worktree in materializedDirs BEFORE mutating files and enable immediate rollback on partial error!
    if (!materializedDirs.includes(worktreeDir)) materializedDirs.push(worktreeDir);
    if (sharedPrepared && sharedPrepared.length > 0) {
      const membersSpec = sharedPrepared.map((p) => ({
        ...p.step,
        agent: p.step.id === step.id ? activeAgent : (executedStepInfo[p.step.id]?.agent || agentOf(p.step)),
      }));
      materializeAgentConfig({ worktree: worktreeDir, members: membersSpec, cfg, configDir: here, die: mountDie, warn, quietRestore: true, rollbackOnError: true });
    } else {
      materializeAgentConfig({ worktree: worktreeDir, members: [{ ...step, agent: activeAgent }], cfg, configDir: here, die: mountDie, warn, quietRestore: true, rollbackOnError: true });
    }
  }

  function clearStepArtifactStrict(step, wtRootDir, worktreeDir) {
    try {
      return clearStaleStepArtifact(step, wtRootDir, worktreeDir, artDir);
    } catch (e) {
      throw new FlowFatalError(e.message || String(e));
    }
  }

  async function launchMember(step, stepCtx = null, {
    startCandidateIndex = 0,
    fallbackReason = null,
    fallbackPhase = null,
    prevCandidate = null,
    retryOfDispatchId = null,
    supersededDispatches = null,
    sharedWorktree = false,
    sharedPrepared = null,
    materializedDirs = [],
    slotStartedAt = null,
    slotDeadlineAt = null,
    slotMaxDeadlineAt = null,
  } = {}) {
    if (step.verify?.mergeDangerCheck && !preStepTargetRefs[step.id]) {
      preStepTargetRefs[step.id] = snapshotTargetRefs(stepCtx?.isolated ? stepCtx.dir : (getWtDir() || "."), targetBranch);
    }
    const preRefs = preStepTargetRefs[step.id] || { localSha: null, originSha: null, remoteSha: null, remoteError: null, hasOrigin: false, headSha: null };
    const worktreeDir = stepCtx?.isolated ? stepCtx.dir : (getWtDir() || ".");
    const wtRootDir = getWtDir() || ".";
    const LEDGER = getLedger();

    // P1-02: Establish single absolute `effectiveStepStart`, `maxDeadlineAt`, and `deadlineAt`
    // at the VERY START of the step BEFORE task creation and candidate preflight!
    const effectiveStepStart = slotStartedAt ?? Date.now();
    const interactiveNow = !autoRun && step.interactive;
    const baseIdleMs = timeoutOf(step);
    const baseHardMs = step.hardTimeoutMs ?? cfg.defaults?.hardTimeoutMs ?? 4 * baseIdleMs;
    const maxIdleMs = interactiveNow ? Math.max(baseIdleMs, 3600000) : baseIdleMs;
    const rawHardCapMs = interactiveNow ? Math.max(baseHardMs, 14400000) : baseHardMs;
    const stepMaxRtRaw = step.watchdog?.maxRuntimeMs ?? cfg.defaults?.watchdog?.maxRuntimeMs ?? 0;
    const stepMaxRtMs = Number.isFinite(stepMaxRtRaw) && stepMaxRtRaw > 0 ? stepMaxRtRaw : 0;
    const maxDeadlineAt = slotMaxDeadlineAt ?? (stepMaxRtMs > 0 ? effectiveStepStart + stepMaxRtMs : Infinity);
    const hardCapMs = stepMaxRtMs > 0 ? Math.min(rawHardCapMs, stepMaxRtMs) : rawHardCapMs;
    const deadlineAt = slotDeadlineAt ? Math.min(slotDeadlineAt, maxDeadlineAt) : Math.min(effectiveStepStart + hardCapMs, maxDeadlineAt);

    const buildDeadlineSettledMember = ({ taskIdVal = null, dispatchIdVal = null, terminalVal = null, reqIdVal = null, candIdxVal = startCandidateIndex, activeCandVal = null, clearedVal = { cleared: true, clearedAtMs: effectiveStepStart, fsEpochMtimeMs: effectiveStepStart }, supersededVal = new Set(supersededDispatches || []), crossRejVal = [], fullChainVal = [] } = {}) => {
      const elapsedMs = Date.now() - effectiveStepStart;
      const mins = Math.round(elapsedMs / 60000);
      const secs = Math.round(elapsedMs / 1000);
      const hitCeil = maxDeadlineAt < Infinity && Date.now() >= maxDeadlineAt;
      log(`[warn] "${step.title}" not settled after ${mins}min; leaving its terminal open and stopping the pipeline.${hitCeil ? ` [reached maxRuntimeMs ceiling at ${secs}s]` : ""}`);
      const note = hitCeil ? `reached maxRuntimeMs ceiling (${secs}s) — not settled after ${mins}min` : `not settled after ${mins}min`;
      statusEnd(step.id, "still-running", note);
      LEDGER?.recordWatchdogEvent?.({
        stepId: step.id,
        kind: "deadline_exceeded",
        action: "pause_cleanup_recorded",
        diagnosis: note,
        evidence: { cleanupState: (dispatchIdVal || terminalVal) ? "retained_open_on_deadline" : "aborted_before_dispatch" },
      });
      return {
        step, ctx: stepCtx, taskId: taskIdVal, dispatchId: dispatchIdVal, terminal: terminalVal, requestId: reqIdVal,
        clearedAtMs: clearedVal.clearedAtMs, fsEpochMtimeMs: clearedVal.fsEpochMtimeMs, clearedBeforeDispatch: Boolean(clearedVal.cleared),
        supersededDispatches: supersededVal, crossRejected: crossRejVal, sharedWorktree,
        candidateChain: fullChainVal, candidateIndex: candIdxVal, activeCandidate: activeCandVal,
        preStepTargetSha: preRefs.localSha, preStepOriginTargetSha: preRefs.originSha,
        preStepRemoteTargetSha: preRefs.remoteSha, preStepRemoteError: preRefs.remoteError,
        preStepHasOrigin: preRefs.hasOrigin, preStepHeadSha: preRefs.headSha,
        health: null, watchdog: null, maxIdleMs, hardCapMs: Math.max(0, deadlineAt - effectiveStepStart),
        deadlineAt, maxDeadlineAt, sliceMs: 250, stepStartedAt: effectiveStepStart, startedAt: effectiveStepStart,
        lastBusy: effectiveStepStart, lastPreview: undefined, quietWarned: false, parkedSeen: new Set(), parkedLabel: null,
        settled: true, done: null, note, outcome: "still-running",
        nudge: { left: 0, phase: null, sentAt: 0, count: 0, outcome: null, done: null },
      };
    };

    // P0-03: Proven Cross-Family Review enforcement against ALL accumulated upstream author families
    const isReview = isCrossFamilyReviewStep(step);
    const { forbiddenByFamily, unprovenAuthors } = computeReviewIsolationContext(step, { dryRun: false, projectDir: worktreeDir });
    const rawChain = buildCandidateChain(step, cfg, { agentOf, modelOf, projectDir: worktreeDir });
    const { allowed: fullChain, rejected: crossRejected } = isReview
      ? filterCrossFamilyCandidates(rawChain, forbiddenByFamily, {
        unprovenAuthors,
        projectDir: worktreeDir,
        allowSyntheticStub: isPureStubPipeline,
      })
      : { allowed: rawChain, rejected: [] };

    for (const rej of crossRejected) {
      warn(`[cross-family] "${step.title}": ${rej.reason}`);
    }

    if (fullChain.length === 0 || startCandidateIndex >= fullChain.length) {
      const violationMsg = crossRejected.length
        ? `[cross-family] BLOCKED "${step.title}": no eligible cross-family reviewer candidate remains (${crossRejected.map((r) => r.reason).join("; ")}). Refusing self-review.`
        : `No healthy worker candidate remains for "${step.title}".`;
      statusSet(step.id, { status: "failed", health: "blocked", note: violationMsg });
      writeStatus();
      LEDGER?.recordHealth({ stepId: step.id, state: "blocked", turnStart: "unobserved", signals: [{ name: "cross_family_violation", state: "blocked", detail: violationMsg }], note: violationMsg });
      LEDGER?.recordStepSettled({ stepId: step.id, outcome: "blocked", note: violationMsg, verifyOk: false, verifyReason: violationMsg });
      throw new FlowFatalError(violationMsg);
    }

    if (Date.now() >= deadlineAt) {
      return buildDeadlineSettledMember({ crossRejVal: crossRejected, fullChainVal: fullChain, activeCandVal: fullChain[startCandidateIndex] });
    }

    const taskId = ensureTask(step, stepCtx, { skipReopenReady: Boolean(retryOfDispatchId), deadlineAt });
    if (!taskId) {
      return buildDeadlineSettledMember({ crossRejVal: crossRejected, fullChainVal: fullChain, activeCandVal: fullChain[startCandidateIndex] });
    }

    const remainingChain = fullChain.slice(startCandidateIndex);
    const preflightRes = await selectHealthyCandidate(remainingChain, { cfg, projectDir: worktreeDir, deadlineAt });
    if (preflightRes.deadlineExceeded || Date.now() >= deadlineAt) {
      return buildDeadlineSettledMember({ taskIdVal: taskId, crossRejVal: crossRejected, fullChainVal: fullChain, activeCandVal: fullChain[startCandidateIndex] });
    }

    if (preflightRes.allConfigErrors) {
      const cfgErrMsg = `[preflight] "${step.title}" invalid preflight endpoint configuration: ${preflightRes.failures.map((f) => `${f.agent}: ${f.reason}`).join("; ")}`;
      statusSet(step.id, { status: "failed", health: "blocked", note: cfgErrMsg });
      writeStatus();
      throw new FlowFatalError(cfgErrMsg);
    }
    if (isReview && preflightRes.allFailed && crossRejected.length > 0) {
      const blockMsg = `[cross-family] BLOCKED "${step.title}": cross-family candidate(s) failed preflight (${preflightRes.failures.map((f) => `${f.agent}: ${f.reason}`).join("; ")}) and fallback into upstream author family was rejected (${crossRejected.map((r) => r.reason).join("; ")}).`;
      statusSet(step.id, { status: "failed", health: "blocked", note: blockMsg });
      writeStatus();
      LEDGER?.recordStepSettled({ stepId: step.id, outcome: "blocked", note: blockMsg, verifyOk: false, verifyReason: blockMsg });
      throw new FlowFatalError(blockMsg);
    }

    let candIndex = startCandidateIndex + Math.max(0, preflightRes.index);
    let activeCand = fullChain[candIndex] || fullChain[startCandidateIndex];

    if (fallbackReason && prevCandidate) {
      const firstRemaining = remainingChain[0] || activeCand;
      warn(`[fallback] "${step.title}" downgrading from "${prevCandidate.agent}" to "${firstRemaining.agent}"${firstRemaining.model ? ` (model=${firstRemaining.model}${firstRemaining.effort ? `, effort=${firstRemaining.effort}` : ""})` : ""} (${fallbackPhase || "runtime"}: ${sanitizeText(fallbackReason, { maxLen: 220 })}).`);
      LEDGER?.recordFallback({
        stepId: step.id,
        fromAgent: prevCandidate.agent,
        fromModel: prevCandidate.model,
        toAgent: firstRemaining.agent,
        toModel: firstRemaining.model,
        toEffort: firstRemaining.effort,
        toFamily: firstRemaining.family,
        reason: fallbackReason,
        phase: fallbackPhase || "runtime",
      });
    }
    if (preflightRes.downgraded && preflightRes.failures.length) {
      for (let fi = 0; fi < preflightRes.failures.length; fi++) {
        const failItem = preflightRes.failures[fi];
        const targetCand = remainingChain[fi + 1] || activeCand;
        warn(`[preflight] "${step.title}" candidate "${failItem.agent}" failed pre-check (${failItem.reason}); auto-downgrading to fallback "${targetCand.agent}"${targetCand.model ? ` (model=${targetCand.model}${targetCand.effort ? `, effort=${targetCand.effort}` : ""})` : ""}.`);
        LEDGER?.recordFallback({
          stepId: step.id,
          fromAgent: failItem.agent,
          fromModel: failItem.model,
          toAgent: targetCand.agent,
          toModel: targetCand.model,
          toEffort: targetCand.effort,
          toFamily: targetCand.family,
          reason: failItem.reason,
          phase: "preflight",
        });
      }
    } else if (!fallbackReason && preflightRes.allFailed && preflightRes.failures.length) {
      warn(`[preflight] "${step.title}" all candidate pre-checks failed (${preflightRes.failures.map((f) => `${f.agent}: ${f.reason}`).join("; ")}); attempting primary anyway.`);
    }

    let started = null;
    let launchedAt = Date.now();
    let clearedInfo = { cleared: true, clearedAtMs: launchedAt, fsEpochMtimeMs: launchedAt };
    let requestId = null;
    let currentRetryOf = retryOfDispatchId;
    const superseded = new Set(supersededDispatches || []);
    if (retryOfDispatchId) superseded.add(retryOfDispatchId);

    while (candIndex < fullChain.length) {
      if (Date.now() >= deadlineAt) {
        return buildDeadlineSettledMember({ taskIdVal: taskId, reqIdVal: requestId, candIdxVal: candIndex, activeCandVal: activeCand, clearedVal: clearedInfo, supersededVal: superseded, crossRejVal: crossRejected, fullChainVal: fullChain });
      }
      activeCand = fullChain[candIndex];
      if (activeCand.agent !== agentOf(step)) {
        rematerializeForCandidate(step, activeCand.agent, worktreeDir, sharedPrepared, materializedDirs);
      }

      const launchSpec = resolveEffectiveLaunchSpec(
        activeCand.agent,
        activeCand.isPrimary ? (activeCand.requestedModel ?? modelOf(step)) : (activeCand.requestedModel ?? activeCand.model),
        activeCand.isPrimary ? (activeCand.requestedEffort ?? step.effort ?? null) : (activeCand.requestedEffort ?? activeCand.effort),
        { projectDir: worktreeDir }
      );
      const wtTag = stepCtx?.isolated ? `, worktree=${stepCtx.wtName}, branch=${stepCtx.branch}` : "";
      const modelTag = launchSpec.passedModel ? `, model=${launchSpec.passedModel}` : "";
      const effortTag = launchSpec.effectiveEffort ? `, effort=${launchSpec.effectiveEffort}` : "";
      log(`> ${step.title}  (agent=${activeCand.agent}${modelTag}${effortTag}, task=${taskId}${wtTag})`);
      requestId = `req-${++attemptSeq}-${step.id}`;
      const requestedModel = activeCand.isPrimary ? (modelOf(step) || null) : (activeCand.requestedModel || activeCand.model || null);
      const requestedEffort = activeCand.isPrimary ? (step.effort || cfg?.defaults?.effort || null) : (activeCand.requestedEffort || activeCand.effort || null);
      const recordedFamily = classifyModelFamily(activeCand.agent, requestedModel, { projectDir: worktreeDir });
      if (LEDGER) {
        LEDGER.recordIntent({
          requestId,
          stepId: step.id,
          title: step.title,
          agent: activeCand.agent,
          model: launchSpec.effectiveModel,
          requestedModel: requestedModel || "default",
          requestedEffort: requestedEffort || null,
          effort: launchSpec.effectiveEffort,
          family: recordedFamily,
          attempt: attemptSeq,
          worktree: stepCtx?.isolated ? stepCtx.wtName : (getWt() || "integration"),
          branch: stepCtx?.isolated ? stepCtx.branch : null,
        });
      }
      launchedAt = Date.now();
      started = startWorker(step, taskId, stepCtx?.selector || null, {
        agentOverride: activeCand.agent,
        modelOverride: launchSpec.passedModel,
        effortOverride: launchSpec.effectiveEffort,
        worktreePath: worktreeDir,
        retryOfDispatchId: currentRetryOf,
        deadlineAt,
        beforeEachStartAttempt: () => {
          clearedInfo = clearStepArtifactStrict(step, wtRootDir, worktreeDir);
          return clearedInfo;
        },
        allowError: true,
        onBeforeManualDispatch: currentRetryOf ? () => {
          const u = orca(["orchestration", "task-update", "--id", taskId, "--status", "ready"], { deadlineAt });
          if (!u.ok) warn(`task-update to ready before manual dispatch failed: ${sanitizeText(u.stderr || u.raw, { maxLen: 200 })}`);
          return u.ok;
        } : null,
      });
      if (started?.lastClearedInfo) {
        clearedInfo = started.lastClearedInfo;
      }

      if (started?.attempts?.length && LEDGER?.recordStartAttempts) {
        LEDGER.recordStartAttempts({ requestId, stepId: step.id, attempts: started.attempts });
      }

      if (started?.dispatchId) {
        const interimModel = started.effectiveModelResolved === true
          ? (started.effectiveModel || null)
          : (started.effectiveModel ?? launchSpec.effectiveModel ?? null);
        recordExecutedStep(step.id, activeCand.agent, interimModel, worktreeDir);
      }

      if (started?.deadlineExceeded) {
        return buildDeadlineSettledMember({ taskIdVal: taskId, dispatchIdVal: started.dispatchId || null, terminalVal: started.terminal || null, reqIdVal: requestId, candIdxVal: candIndex, activeCandVal: activeCand, clearedVal: clearedInfo, supersededVal: superseded, crossRejVal: crossRejected, fullChainVal: fullChain });
      }

      if (started && started.ok !== false) break;

      const errReason = sanitizeText(started?.error || "worker-start failed", { maxLen: 240 });
      if (started?.dispatchId) superseded.add(started.dispatchId);

      if (started?.ambiguous) {
        const ambMsg = `worker-start '${step.title}' left an unconfirmed/ambiguous state (${errReason}) — refusing blind fallback on the same worktree.`;
        statusSet(step.id, { status: "unknown", health: "unknown", note: ambMsg });
        writeStatus();
        throw new FlowFatalError(ambMsg);
      }

      const nextIdx = candIndex + 1;
      if (nextIdx >= fullChain.length) {
        const crossSuffix = (isReview && crossRejected.length)
          ? ` (cross-family guard also blocked author-family fallback: ${crossRejected.map((r) => r.reason).join("; ")})`
          : "";
        throw new FlowFatalError(`worker-start '${step.title}' failed: ${errReason}${crossSuffix}`);
      }
      const nextCand = fullChain[nextIdx];
      warn(`[fallback] worker-start "${step.title}" failed on "${activeCand.agent}" (${errReason}); auto-downgrading to "${nextCand.agent}"${nextCand.model ? ` (model=${nextCand.model}${nextCand.effort ? `, effort=${nextCand.effort}` : ""})` : ""}.`);
      LEDGER?.recordFallback({
        stepId: step.id,
        fromAgent: activeCand.agent,
        fromModel: activeCand.model,
        toAgent: nextCand.agent,
        toModel: nextCand.model,
        toEffort: nextCand.effort,
        toFamily: nextCand.family,
        reason: errReason,
        phase: "worker_start",
      });
      if (Date.now() >= deadlineAt) {
        return buildDeadlineSettledMember({ taskIdVal: taskId, dispatchIdVal: started?.dispatchId || null, terminalVal: started?.terminal || null, reqIdVal: requestId, candIdxVal: candIndex, activeCandVal: activeCand, clearedVal: clearedInfo, supersededVal: superseded, crossRejVal: crossRejected, fullChainVal: fullChain });
      }
      if (started?.dispatchId) {
        const tu = orca(["orchestration", "task-update", "--id", taskId, "--status", "failed", "--result", `worker-start failed: ${errReason}`], { deadlineAt });
        if (tu.deadlineExceeded) {
          return buildDeadlineSettledMember({ taskIdVal: taskId, dispatchIdVal: started.dispatchId, reqIdVal: requestId, candIdxVal: candIndex, activeCandVal: activeCand, clearedVal: clearedInfo, supersededVal: superseded, crossRejVal: crossRejected, fullChainVal: fullChain });
        }
        if (!tu.ok) {
          throw new FlowFatalError(`task-update '${step.title}' (${taskId}) failed before fallback: ${sanitizeText(tu.stderr || tu.raw, { maxLen: 200 })}`);
        }
        currentRetryOf = started.dispatchId;
      } else {
        const tu = orca(["orchestration", "task-update", "--id", taskId, "--status", "ready"], { deadlineAt });
        if (tu.deadlineExceeded) {
          return buildDeadlineSettledMember({ taskIdVal: taskId, reqIdVal: requestId, candIdxVal: candIndex, activeCandVal: activeCand, clearedVal: clearedInfo, supersededVal: superseded, crossRejVal: crossRejected, fullChainVal: fullChain });
        }
        if (!tu.ok) {
          throw new FlowFatalError(`task-update '${step.title}' (${taskId}) failed before fallback: ${sanitizeText(tu.stderr || tu.raw, { maxLen: 200 })}`);
        }
        currentRetryOf = null;
      }
      candIndex = nextIdx;
    }

    const finalLaunchSpec = resolveEffectiveLaunchSpec(
      activeCand.agent,
      activeCand.isPrimary ? (activeCand.requestedModel ?? modelOf(step)) : (activeCand.requestedModel ?? activeCand.model),
      activeCand.isPrimary ? (activeCand.requestedEffort ?? step.effort ?? null) : (activeCand.requestedEffort ?? activeCand.effort),
      { projectDir: worktreeDir }
    );
    // P2-01: Distinguish an explicitly resolved `null` model/effort from `undefined` (not yet resolved),
    // NEVER falling back via `??` to a pre-estimated model/effort that was NOT present in the launched argv!
    const finalModel = started.effectiveModelResolved === true
      ? (started.effectiveModel || null)
      : (started.effectiveModel !== undefined ? (started.effectiveModel || null) : (finalLaunchSpec.effectiveModel || null));
    const finalEffort = started.effectiveEffortResolved === true
      ? (started.effectiveEffort || null)
      : (started.effectiveEffort !== undefined ? (started.effectiveEffort || null) : null);
    const execRec = recordExecutedStep(step.id, activeCand.agent, finalModel, worktreeDir);

    const dispatchedAt = Date.now();
    const { dispatchId, terminal } = started;
    const startMode = started.startMode || (terminal ? "manual" : "cold");
    if (dispatchId) {
      bindStepArtifactDispatchClaim(wtRootDir, artDir, step, {
        dispatchId,
        taskId,
        fsEpochMtimeMs: clearedInfo.fsEpochMtimeMs,
        clearedAtMs: clearedInfo.clearedAtMs,
      });
    }
    const receiptTurnStart = started.receiptTurnStart || (terminal ? "observed" : null);
    const health = initMemberHealth({
      startedAt: launchedAt, dispatchedAt, receiptTurnStart,
      turnStartWindowMs: step.turnStartWindowMs ?? turnStartWindowMs,
      turnStartEscalateMs: step.turnStartEscalateMs ?? turnStartEscalateMs,
    });
    const artDirPath = join(worktreeDir, artDir);
    const artifactPath = step.writes ? join(artDirPath, step.writes) : null;
    const progressPath = step.progress ? join(artDirPath, step.progress) : null;

    const watchdog = createWatchdogTracker({
      step, cfg, startedAt: effectiveStepStart, worktreeDir, artifactPath, progressPath, artDirPath, sharedWorktree,
    });
    if (LEDGER) {
      LEDGER.recordDispatchResult({
        requestId,
        stepId: step.id,
        dispatchId,
        terminal,
        turnStart: health.turnStart,
        state: started.dispatchState || (terminal ? "manual" : "ready"),
        effectiveAgent: started.effectiveAgent || activeCand.agent,
        effectiveModel: finalModel || "default",
        effectiveEffort: finalEffort,
        executedFamilies: execRec.executedFamilies,
      });
    }
    statusSet(step.id, {
      agent: activeCand.agent,
      model: finalModel || "default",
      family: execRec.family,
      executedFamilies: execRec.executedFamilies,
      provenanceVerified: true,
      health: health.state,
      turnStart: health.turnStart,
      ...(candIndex > 0 ? { note: `fallback active: ${activeCand.agent}${activeCand.model ? ` (${activeCand.model})` : ""}` } : {}),
    });

    const maxRtMs = watchdog.config.maxRuntimeMs > 0 ? watchdog.config.maxRuntimeMs : 0;
    const wdSliceCap = watchdog.config.stallTimeoutMs > 0 ? Math.max(1000, Math.floor(watchdog.config.stallTimeoutMs / 2)) : 120000;
    const sliceCandidates = [120000, maxIdleMs, hardCapMs, health.turnStartWindowMs, health.turnStartEscalateMs, wdSliceCap];
    if (maxRtMs > 0) sliceCandidates.push(maxRtMs);

    return {
      step, ctx: stepCtx, taskId, dispatchId, terminal, startMode, requestId,
      clearedAtMs: clearedInfo.clearedAtMs,
      fsEpochMtimeMs: clearedInfo.fsEpochMtimeMs,
      clearedBeforeDispatch: Boolean(clearedInfo.cleared),
      supersededDispatches: superseded,
      crossRejected,
      sharedWorktree,
      candidateChain: fullChain, candidateIndex: candIndex, activeCandidate: activeCand,
      preStepTargetSha: preRefs.localSha, preStepOriginTargetSha: preRefs.originSha,
      preStepRemoteTargetSha: preRefs.remoteSha, preStepRemoteError: preRefs.remoteError,
      preStepHasOrigin: preRefs.hasOrigin, preStepHeadSha: preRefs.headSha, health, watchdog,
      maxIdleMs,
      hardCapMs: Math.max(0, deadlineAt - effectiveStepStart),
      deadlineAt,
      maxDeadlineAt,
      sliceMs: Math.max(250, Math.min(...sliceCandidates)),
      stepStartedAt: effectiveStepStart,
      startedAt: launchedAt,
      lastBusy: launchedAt,
      lastPreview: undefined,
      quietWarned: false, parkedSeen: new Set(), parkedLabel: null, settled: false, done: null, note: "", outcome: null,
      nudge: { left: nudgeRetriesOf(step), phase: null, sentAt: 0, count: 0, outcome: null, done: null },
    };
  }

  async function runGroup(members) {
    const materializedDirs = [];
    let M = [];
    let fatalErr = null;
    const wtDir = getWtDir() || ".";
    const runId = getRunId();
    const LEDGER = getLedger();
    try {
      const prepared = members.map((s) => ({
        step: s,
        ctx: prepareStepWorktree({
          step: s, objective, runId, wtSelector: resolveWorktree(), wtDir,
          artDirRel: artDir, orca, pick, res, byId, effectiveReads, allSteps,
          isolatedState, log, warn, die: (msg) => { throw new FlowFatalError(msg); },
        }),
      }));
      for (const p of prepared) {
        clearStepArtifactStrict(p.step, wtDir, p.ctx.dir);
      }
      const sharedPrepared = prepared.filter((p) => !p.ctx.isolated);
      const sharedMembers = sharedPrepared.map((p) => ({ ...p.step, agent: agentOf(p.step) }));
      const mountDie = (msg) => { throw new FlowFatalError(msg); };
      if (sharedMembers.length) {
        // P1-04: Register worktree BEFORE mutating any MCP/skill file and roll back immediately on partial error!
        materializedDirs.push(wtDir);
        materializeAgentConfig({
          worktree: wtDir,
          members: sharedMembers,
          cfg,
          configDir: here,
          die: mountDie,
          warn,
          rollbackOnError: true,
        });
      }
      for (const p of prepared.filter((x) => x.ctx.isolated)) {
        materializedDirs.push(p.ctx.dir);
        materializeAgentConfig({
          worktree: p.ctx.dir,
          members: [{ ...p.step, agent: agentOf(p.step) }],
          cfg,
          configDir: here,
          die: mountDie,
          warn,
          rollbackOnError: true,
        });
      }
      for (const s of members) statusBegin(s.id);
      M = [];
      const isSharedGroup = sharedPrepared.length > 1;
      for (const p of prepared) {
        M.push(await launchMember(p.step, p.ctx, {
          sharedWorktree: !p.ctx.isolated && isSharedGroup,
          sharedPrepared: !p.ctx.isolated ? sharedPrepared : null,
          materializedDirs,
          slotStartedAt: Date.now(),
        }));
      }
      while (true) {
        const open = M.filter((m) => !m.settled);
        if (!open.length) break;
        const activeSharedCount = M.filter((m) => !m.ctx?.isolated && (!m.settled || m.outcome === "still-running")).length;
        // P1-02: Strict zero-overshoot remaining budget on `check --wait` AND all follow-up RPCs!
        const nowBeforeWait = Date.now();
        const minRemDeadlineMs = Math.min(...open.map((m) => m.deadlineAt - nowBeforeWait));
        for (const m of open) {
          if (m.ctx?.isolated) syncOutputsFromIsolatedWorktree({ step: m.step, stepWtDir: m.ctx.dir, wtDir, artDirRel: artDir, minSourceMtimeMs: m.fsEpochMtimeMs ?? m.clearedAtMs, dispatchId: m.dispatchId || null });
          refreshProgress(m.step); writeArtifactSnapshot(m.step);
        }
        writeStatus();
        let msgs = [];
        if (minRemDeadlineMs > 0) {
          const slice = Math.max(1, Math.floor(Math.min(...open.map((m) => Math.min(m.sliceMs, Math.max(1, m.deadlineAt - nowBeforeWait))))));
          const checkProcTimeoutMs = Number.isFinite(minRemDeadlineMs)
            ? Math.max(1, Math.floor(Math.min(slice + 5000, minRemDeadlineMs)))
            : (slice + 5000);
          const minDeadlineAt = Math.min(...open.map((m) => m.deadlineAt));
          const wait = orca(["orchestration", "check", "--run", runId, "--wait", "--types", "worker_done,escalation,question", "--timeout-ms", String(slice)], {
            timeoutMs: checkProcTimeoutMs,
            deadlineAt: Number.isFinite(minDeadlineAt) ? minDeadlineAt : null,
          });
          const d = res(wait.json);
          const did = pick(d, ["deliveryId", "delivery_id"]) ?? pick(d.delivery || {}, ["id"]);
          msgs = pick(d, ["messages", "msgs"]) || [];
          if (did) orca(["orchestration", "check", "--run", runId, "--ack", did], { allowPostDeadlineCleanup: true, timeoutMs: 2000 });
        }
        for (const msg of msgs) {
          const ty = pick(msg, ["type"]);
          if (ty === "question" || ty === "escalation") log(`  [${ty}] ${sanitizeText(pick(msg, ["subject"]) || "", { maxLen: 200 })}`);
        }
        for (const m of open) {
          // P1-02: Enforce strict absolute maxDeadlineAt ceiling BEFORE processing post-done nudges or vitals!
          const nowSlice = Date.now();
          if (m.maxDeadlineAt < Infinity && nowSlice >= m.maxDeadlineAt) {
            const elapsedTotalMs = nowSlice - m.stepStartedAt;
            const mins = Math.round(elapsedTotalMs / 60000);
            const secs = Math.round(elapsedTotalMs / 1000);
            log(`[warn] "${m.step.title}" not settled after ${mins}min; leaving its terminal open and stopping the pipeline. [reached maxRuntimeMs ceiling at ${secs}s]`);
            m.note = m.parkedLabel
              ? `parked on ${m.parkedLabel} — not settled after ${mins}min`
              : `reached maxRuntimeMs ceiling (${secs}s) — not settled after ${mins}min`;
            LEDGER?.recordWatchdogEvent?.({
              stepId: m.step.id,
              kind: "deadline_exceeded",
              action: "pause_cleanup_recorded",
              diagnosis: m.note,
              evidence: { cleanupState: "retained_open_on_deadline", dispatchId: m.dispatchId || null, terminal: m.terminal || null },
            });
            settleMember(m, "still-running", null);
            continue;
          }

          if (m.nudge.phase === "post-done") { nudgeCtrl.nudgePoll(m); continue; }
          const wd = msgs.find((msg) => matchesMemberDone(msg, m));
          if (wd) {
            if (m.ctx?.isolated) syncOutputsFromIsolatedWorktree({ step: m.step, stepWtDir: m.ctx.dir, wtDir, artDirRel: artDir, minSourceMtimeMs: m.fsEpochMtimeMs ?? m.clearedAtMs, dispatchId: m.dispatchId || null });
            if (m.health) {
              evaluateMemberHealth(m.health, { startedAt: m.startedAt, workerDone: true });
              statusSet(m.step.id, { health: m.health.state, turnStart: m.health.turnStart });
            }
            const out = outcomeOf(wd) || "unknown";
            if (!nudgeCtrl.holdForNudge(m, out, wd)) settleMember(m, m.outcome || out, wd);
            continue;
          }
          // P1-02: Enforce CURRENT approved `m.deadlineAt` on `workerVitals` and `drain`
          // (NEVER pass an unapproved `m.maxDeadlineAt` before extension is confirmed!).
          const vitalsBudgetCap = m.deadlineAt;
          const v = (Date.now() < vitalsBudgetCap)
            ? workerVitals(m.taskId, m.terminal, m.dispatchId, { deadlineAt: vitalsBudgetCap })
            : { status: null, settled: false, outcome: null, lastBusyMs: 0, heartbeatMs: 0, preview: null, agentWait: null, dispatchMismatch: false, deadlineExceeded: true };
          if (v.settled) {
            const drain = Date.now() < vitalsBudgetCap
              ? orca(["orchestration", "check", "--run", runId, "--types", "worker_done"], { deadlineAt: vitalsBudgetCap })
              : { ok: false, json: null };
            const dr = res(drain.json);
            const drid = pick(dr, ["deliveryId", "delivery_id"]) ?? pick(dr.delivery || {}, ["id"]);
            const drained = (pick(dr, ["messages", "msgs"]) || []).find((msg) => matchesMemberDone(msg, m)) || null;
            if (drid) orca(["orchestration", "check", "--run", runId, "--ack", drid], { allowPostDeadlineCleanup: true, timeoutMs: 2000 });
            if (m.ctx?.isolated) syncOutputsFromIsolatedWorktree({ step: m.step, stepWtDir: m.ctx.dir, wtDir, artDirRel: artDir, minSourceMtimeMs: m.fsEpochMtimeMs ?? m.clearedAtMs, dispatchId: m.dispatchId || null });
            const vout = (drained && outcomeOf(drained)) || v.outcome || "unknown";
            const vdone = drained || { dispatchId: m.dispatchId, payload: JSON.stringify({ outcome: vout, dispatchId: m.dispatchId }) };
            if (!nudgeCtrl.holdForNudge(m, vout, vdone)) settleMember(m, m.outcome || vout, vdone);
            continue;
          }
          const previewSeenBefore = m.lastPreview !== undefined;
          let previewChanged = false;
          if (v.preview != null) {
            previewChanged = !previewSeenBefore || v.preview !== m.lastPreview;
            if (previewChanged) { m.lastPreview = v.preview; m.lastBusy = Date.now(); }
          } else if (v.lastBusyMs > 0 && Date.now() - v.lastBusyMs < m.maxIdleMs) {
            m.lastBusy = Date.now();
          }

          const sharedNow = !m.ctx?.isolated && activeSharedCount > 1;
          const hasFallback = (m.candidateIndex + 1) < (m.candidateChain?.length || 1);
          const wres = m.watchdog ? evaluateWatchdog(m.watchdog, {
            preview: v.preview,
            previewChanged,
            previewSeenBefore,
            agentWait: v.agentWait,
            fallbackAvailable: hasFallback,
            sharedWorktree: sharedNow,
          }) : null;
          if (wres && (wres.gitChanged || wres.artifactChanged)) {
            m.lastBusy = Date.now();
          }
          if (wres && wres.status === "anomaly") {
            if (!wres.deduplicated) {
              LEDGER?.recordWatchdogEvent({
                stepId: m.step.id,
                kind: wres.kind,
                action: wres.action,
                diagnosis: wres.diagnosis,
                evidence: wres.evidence,
              });
            }
            if (wres.action === "fallback" && hasFallback) {
              warn(`[watchdog:${wres.kind}] "${m.step.title}" — ${wres.diagnosis}. Stopping broken worker and downgrading to fallback...`);
              const stopCheck = stopAndIsolateWorker(m, `watchdog:${wres.kind}`);
              if (!stopCheck.ok) {
                const pauseNote = `[watchdog:${wres.kind}] could not prove old worker stopped (${stopCheck.reason}) — pausing without reusing worktree`;
                warn(`"${m.step.title}" ${pauseNote}`);
                m.note = pauseNote;
                statusSet(m.step.id, { health: "unknown", note: m.note });
                settleMember(m, "still-running", null);
                continue;
              }
              if (m.dispatchId) {
                const tu = orca(["orchestration", "task-update", "--id", m.taskId, "--status", "failed", "--result", `stopped for fallback: ${wres.kind}`], { deadlineAt: m.deadlineAt });
                if (!tu.ok) {
                  const tuNote = `[watchdog:${wres.kind}] task-update failed (${sanitizeText(tu.stderr || tu.raw, { maxLen: 180 })}) — pausing cleanly`;
                  warn(`"${m.step.title}" ${tuNote}`);
                  m.note = tuNote;
                  statusSet(m.step.id, { health: "unknown", note: m.note });
                  settleMember(m, "still-running", null);
                  continue;
                }
              } else {
                const tu = orca(["orchestration", "task-update", "--id", m.taskId, "--status", "ready"], { deadlineAt: m.deadlineAt });
                if (!tu.ok) {
                  const tuNote = `[watchdog:${wres.kind}] task-update failed (${sanitizeText(tu.stderr || tu.raw, { maxLen: 180 })}) — pausing cleanly`;
                  warn(`"${m.step.title}" ${tuNote}`);
                  m.note = tuNote;
                  statusSet(m.step.id, { health: "unknown", note: m.note });
                  settleMember(m, "still-running", null);
                  continue;
                }
              }
              const replacement = await launchMember(m.step, m.ctx, {
                startCandidateIndex: m.candidateIndex + 1,
                fallbackReason: `watchdog:${wres.kind} — ${wres.diagnosis}`,
                fallbackPhase: "watchdog",
                prevCandidate: m.activeCandidate,
                retryOfDispatchId: m.dispatchId || null,
                supersededDispatches: m.supersededDispatches,
                sharedWorktree: sharedNow,
                sharedPrepared: !m.ctx?.isolated ? sharedPrepared : null,
                materializedDirs,
                slotStartedAt: m.stepStartedAt,
                slotDeadlineAt: m.deadlineAt,
                slotMaxDeadlineAt: m.maxDeadlineAt,
              });
              const idx = M.indexOf(m);
              if (idx >= 0) M[idx] = replacement;
              continue;
            }
            if (wres.kind === "gateway_disconnect" || wres.kind === "output_loop") {
              const crossBlockHint = (isCrossFamilyReviewStep(m.step) && m.crossRejected?.length)
                ? ` [cross-family isolation blocked fallback into author family: ${m.crossRejected.map((r) => r.reason).join("; ")}]`
                : "";
              warn(`[watchdog:${wres.kind}] "${m.step.title}" — ${wres.diagnosis}${crossBlockHint}`);
              const stopCheck = stopAndIsolateWorker(m, `watchdog:${wres.kind}`);
              if (!stopCheck.ok) {
                // P0-01: NEVER settle as ordinary "failed" (which triggers onFailGoto) when stop failed!
                const ambNote = `[watchdog:${wres.kind}] ${wres.diagnosis}; could not confirm worker stop (${stopCheck.reason}) — refusing retry/onFailGoto`;
                warn(`"${m.step.title}" ${ambNote}`);
                m.note = ambNote;
                statusSet(m.step.id, { health: "unknown", note: m.note });
                settleMember(m, "still-running", null);
                continue;
              }
              m.note = `[watchdog:${wres.kind}] ${wres.diagnosis}${crossBlockHint}`;
              statusSet(m.step.id, { health: "blocked", note: m.note });
              settleMember(m, m.crossRejected?.length ? "blocked" : "failed", null);
              continue;
            }
            if (wres.kind === "stalled_hang") {
              warn(`[watchdog:stalled_hang] "${m.step.title}" — ${wres.diagnosis}`);
              m.note = `[watchdog:stalled_hang] ${wres.diagnosis}`;
              statusSet(m.step.id, { health: "degraded", note: m.note });
              settleMember(m, "still-running", null);
              continue;
            }
          }

          if (!previewChanged && v.preview != null) {
            const parked = parkedPromptOf(v.preview);
            if (parked && !m.parkedSeen.has(parked.sig)) {
              m.parkedSeen.add(parked.sig);
              m.parkedLabel = parked.label;
              warn(`"${m.step.title}" is PARKED on ${parked.label} (terminal shows "${parked.sig}") — answer it in that terminal; waiting up to the ${Math.round(m.hardCapMs / 60000)}min hard cap.`);
              statusSet(m.step.id, { note: `parked on ${parked.label} — answer it in the terminal` });
            }
          } else if (v.agentWait && !m.parkedSeen.has(`wait:${v.agentWait.kind || "approval"}`)) {
            const wk = String(v.agentWait.kind || v.agentWait.reason || "user_approval");
            m.parkedSeen.add(`wait:${wk}`);
            m.parkedLabel = `human approval (${wk})`;
            warn(`"${m.step.title}" is WAITING on ${m.parkedLabel} — approve in Orca/terminal; waiting up to the ${Math.round(m.hardCapMs / 60000)}min hard cap.`);
            statusSet(m.step.id, { note: `waiting on ${m.parkedLabel}` });
          }

          const silenceMs = Date.now() - m.lastBusy;
          if (m.health) {
            const stepArtPath = join(m.ctx?.isolated ? m.ctx.dir : wtDir, artDir, m.step.writes || "");
            let artSize = 0;
            if (m.step.writes && existsSync(stepArtPath)) { try { artSize = statSync(stepArtPath).size; } catch {} }
            const hres = evaluateMemberHealth(m.health, {
              startedAt: m.startedAt, dispatchStatus: v.status, heartbeatMs: v.heartbeatMs,
              previewChanged, previewSeenBefore, parkedLabel: m.parkedLabel, agentWait: v.agentWait,
              artifactSize: artSize,
              gitChanged: !sharedNow && Boolean(wres?.gitChanged),
              silenceMs, maxIdleMs: m.maxIdleMs,
            });
            statusSet(m.step.id, { health: hres.state, turnStart: hres.turnStart });
            if (hres.changed && LEDGER) {
              LEDGER.recordHealth({ stepId: m.step.id, state: hres.state, turnStart: hres.turnStart, signals: hres.signals, note: hres.note });
            }
            if (hres.turnStartWarnDue) {
              warn(`[health:unknown] "${m.step.title}" has turnStart=unobserved after ${Math.round((Date.now() - m.startedAt) / 1000)}s (state=ready is not start proof).`);
              if (!m.parkedSeen.size) statusSet(m.step.id, { note: hres.note });
            }
            if (hres.state === "lost") {
              const drainLost = orca(["orchestration", "check", "--run", runId, "--types", "worker_done"]);
              const dl = res(drainLost.json);
              const dlid = pick(dl, ["deliveryId", "delivery_id"]) ?? pick(dl.delivery || {}, ["id"]);
              const dlMsgs = pick(dl, ["messages", "msgs"]) || [];
              const lostDone = dlMsgs.find((msg) => matchesMemberDone(msg, m)) || null;
              const hasSiblingMsg = dlMsgs.some((msg) => taskOfMsg(msg) && taskOfMsg(msg) !== m.taskId);
              if (dlid && !hasSiblingMsg) orca(["orchestration", "check", "--run", runId, "--ack", dlid]);
              if (lostDone) {
                evaluateMemberHealth(m.health, { startedAt: m.startedAt, workerDone: true });
                statusSet(m.step.id, { health: m.health.state, turnStart: m.health.turnStart });
                const out = outcomeOf(lostDone) || "unknown";
                if (!nudgeCtrl.holdForNudge(m, out, lostDone)) settleMember(m, m.outcome || out, lostDone);
                continue;
              }
              warn(`[health:lost] "${m.step.title}" dispatch terminated (${v.status}) without worker_done — stopping without blind retry.`);
              m.note = hres.note || `dispatch lost (${v.status})`;
              settleMember(m, "unknown", null);
              continue;
            }
            if (hres.turnStartEscalateDue) {
              warn(`[health:unknown] "${m.step.title}" never proved turnStart=observed within ${Math.round(m.health.turnStartEscalateMs / 1000)}s — stopping cleanly instead of waiting to hard cap.`);
              m.note = hres.note || `turnStart unobserved after ${Math.round((Date.now() - m.startedAt) / 1000)}s`;
              settleMember(m, "still-running", null);
              continue;
            }
          }

          // P1-02: Check absolute `deadlineAt` BEFORE sending mid-run nudges!
          const nowAfterHealth = Date.now();
          const elapsedMs = nowAfterHealth - m.stepStartedAt;
          if (nowAfterHealth >= m.deadlineAt) {
            if (wres?.extendDeadline && m.deadlineAt < m.maxDeadlineAt && nowAfterHealth < m.maxDeadlineAt) {
              const stepExt = Math.max(m.watchdog?.config?.extendStepMs || 300000, m.maxIdleMs || 60000);
              const nextDeadline = Math.min(m.deadlineAt + stepExt, m.maxDeadlineAt);
              const actualExt = nextDeadline - m.deadlineAt;
              if (actualExt > 0) {
                m.deadlineAt = nextDeadline;
                m.hardCapMs = m.deadlineAt - m.stepStartedAt;
                if (m.maxDeadlineAt < Infinity) m.sliceMs = Math.max(250, Math.min(m.sliceMs, m.maxDeadlineAt - nowAfterHealth));
                m.watchdog.extensionsCount += 1;
                const elapsedSec = Math.round(elapsedMs / 1000);
                const maxRtMs = m.watchdog?.config?.maxRuntimeMs || 0;
                log(`[watchdog] "${m.step.title}" is actively progressing after ${elapsedSec}s — extending deadline by ${Math.round(actualExt / 1000)}s (extension #${m.watchdog.extensionsCount}${maxRtMs > 0 ? `, ceiling=${Math.round(maxRtMs / 1000)}s` : ""}) instead of fixed-timeout kill.`);
                LEDGER?.recordWatchdogEvent({
                  stepId: m.step.id,
                  kind: "deadline_extended",
                  action: "extend",
                  diagnosis: `Active progress observed at ${elapsedSec}s; extended deadline by ${Math.round(actualExt / 1000)}s`,
                  evidence: wres.evidence,
                });
                continue;
              }
            }
            const mins = Math.round(elapsedMs / 60000);
            const secs = Math.round(elapsedMs / 1000);
            const hitCeiling = m.maxDeadlineAt < Infinity && nowAfterHealth >= m.maxDeadlineAt;
            const ceilSuffix = hitCeiling ? ` [reached maxRuntimeMs ceiling at ${secs}s]` : "";
            log(`[warn] "${m.step.title}" not settled after ${mins}min; leaving its terminal open and stopping the pipeline.${ceilSuffix}`);
            m.note = m.parkedLabel
              ? `parked on ${m.parkedLabel} — not settled after ${mins}min`
              : (hitCeiling ? `reached maxRuntimeMs ceiling (${secs}s) — not settled after ${mins}min` : `not settled after ${mins}min`);
            LEDGER?.recordWatchdogEvent?.({
              stepId: m.step.id,
              kind: "deadline_exceeded",
              action: "pause_cleanup_recorded",
              diagnosis: m.note,
              evidence: { cleanupState: "retained_open_on_deadline", dispatchId: m.dispatchId || null, terminal: m.terminal || null },
            });
            settleMember(m, "still-running", null);
            continue;
          }

          nudgeCtrl.maybeNudgeMidRun(m, v);

          if (silenceMs >= m.maxIdleMs && !m.quietWarned) {
            m.quietWarned = true;
            warn(`"${m.step.title}" quiet for ${Math.round(silenceMs / 60000)}min but its dispatch is alive (status=${v.status}) — waiting up to the ${Math.round(m.hardCapMs / 60000)}min hard cap before giving up.`);
            if (!m.parkedSeen.size) statusSet(m.step.id, { note: `quiet ${Math.round(silenceMs / 60000)}min but alive — waiting to the hard cap` });
          }
        }
      }
      writeStatus();
      return M;
    } catch (err) {
      // P1-04: Stop ALL live unsettled sibling workers on ANY exception before finally cleanup!
      for (const live of M.filter((x) => !x.settled)) {
        try { stopAndIsolateWorker(live, "group_exception_abort"); } catch {}
      }
      if (err instanceof FlowFatalError) {
        fatalErr = err;
      } else {
        throw err;
      }
    } finally {
      for (const d of new Set(materializedDirs)) restoreAgentConfig({ worktree: d, warn });
      for (const m of M) {
        if (m.ctx?.isolated) finalizeStepWorktree({ step: m.step, stepCtx: m.ctx, outcome: m.outcome, wtDir, artDirRel: artDir, isolatedState, minSourceMtimeMs: m.fsEpochMtimeMs ?? m.clearedAtMs, dispatchId: m.dispatchId || null });
      }
    }
    if (fatalErr) {
      die(fatalErr.message);
    }
    return M;
  }

  function runGate(step) {
    const runId = getRunId();
    const g = orca(["orchestration", "gate-create", "--task", taskIds[step.id], "--question", `Approve the result of step "${step.title}"?`, "--options", '["yes","no"]']);
    const gateId = pick(res(g.json).gate || {}, ["id"]) || pick(res(g.json), ["gateId", "gate_id", "id"]);
    log(`  [gate] for "${step.title}". Approve to continue:`);
    log(`     ${getOrcaBin()} orchestration gate-resolve --id ${gateId} --resolution yes --json`);
    log(`  (Waiting — resolve the gate in Orca or with the command above.)`);
    statusSet(step.id, { status: "waiting-approval", note: "gate open — approve to continue" });
    writeStatus();
    const GATE_TIMEOUT_MS = cfg.defaults?.gateTimeoutMs ?? 3600000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < GATE_TIMEOUT_MS) {
      sleepMs(5000);
      writeStatus();
      const l = orca(["orchestration", "gate-list", "--run", runId]);
      const gates = pick(res(l.json), ["gates"]) || [];
      const gate = gates.find((x) => pick(x, ["id"]) === gateId || pick(x, ["gateId", "gate_id"]) === gateId);
      if (!gate) continue;
      const status = String(pick(gate, ["status", "state"]) ?? "");
      const resolution = pick(gate, ["resolution", "answer", "result"]);
      if (resolution == null && /^(pending|open|waiting|created)$/i.test(status)) continue;
      const verdict = String(resolution ?? status).toLowerCase();
      if (verdict === "yes" || verdict === "approved" || verdict === "resolved") {
        statusSet(step.id, { status: "succeeded", note: null });
        writeStatus();
        return;
      }
      statusSet(step.id, { note: "gate rejected" });
      die(`Gate for "${step.title}" was resolved with "${resolution ?? status}" — stopping the pipeline.`);
    }
    warn(`gate for "${step.title}" not resolved within ${Math.round(GATE_TIMEOUT_MS / 60000)}min; continuing anyway.`);
    statusSet(step.id, { status: "succeeded", note: "gate timeout — continued anyway" });
    writeStatus();
  }

  function readinessOf(step) {
    const missing = [];
    const wtDir = getWtDir() || ".";
    for (const id of (step.reads || [])) {
      if (!byId[id] || byId[id].enabled === false) continue;
      const prodStep = byId[id];
      const v = verifyStepArtifact(prodStep, join(wtDir, artDir), wtDir, readinessMinBytes, { mode: "readiness" });
      if (!v.ok) {
        missing.push({ id, title: prodStep.title, path: outPath(prodStep.writes), reason: v.reason });
        continue;
      }
      // P0-03: When resuming past a skipped cross-family review step, verify that its PASS verdict
      // is backed by a verified run-bound ledger record proving cross-family independence!
      if (!enabledIds.has(id) && !executedStepInfo[id] && isCrossFamilyReviewStep(prodStep) && !isPureStubPipeline) {
        const revProv = verifySkippedReviewProvenance(prodStep, wtDir);
        if (!revProv.ok) {
          missing.push({ id, title: prodStep.title, path: outPath(prodStep.writes), reason: revProv.reason });
        }
      }
    }
    return missing;
  }

  async function readinessGate(members) {
    const missing = [];
    for (const s of members) for (const x of readinessOf(s)) missing.push({ ...x, consumer: s });
    if (!missing.length) return;
    warn("Missing or incomplete input artifact(s):\n" +
      missing.map((x) => `  - ${x.title} (\`${x.path}\`) — ${x.reason} — needed by "${x.consumer.title}"`).join("\n"));
    for (const s of members) {
      const n = missing.filter((x) => x.consumer === s).length;
      if (n) statusSet(s.id, { note: `waiting: ${n} unready input(s)` });
    }
    writeStatus();
    const yes = await promptReadiness("Run the producing step(s) now to (re)generate missing inputs? [y/N] ");
    const ids = new Set(missing.map((x) => x.id));
    const queue = [...ids];
    while (queue.length) {
      const p = byId[queue.shift()];
      for (const x of readinessOf(p)) if (!ids.has(x.id)) { ids.add(x.id); queue.push(x.id); }
    }
    const producers = [...ids].map((id) => byId[id]).sort((a, b) => allSteps.indexOf(a) - allSteps.indexOf(b));
    if (!yes)
      die(`Missing inputs for "${[...new Set(missing.map((x) => x.consumer.title))].join('", "')}" were not (re)generated. Generate them first, then resume, e.g.:\n  node .orca/flow.mjs --from ${producers[0].id} "${objective}"`);
    const wtDir = getWtDir() || ".";
    for (const step of producers) {
      for (let attempt = 1; ; attempt++) {
        log(`[readiness] re-running "${step.title}" (attempt ${attempt}/${readinessRetries})`);
        const [r] = await runGroup([step]);
        if (r.outcome === "still-running") {
          statusMgr.STATUS.overall = "still-running";
          writeStatus();
          die(`"${step.title}" ${r.note}. Its terminal ${r.terminal || "(dispatch-owned)"} was left OPEN to finish. Watch it; once it writes ${outPath(step.writes)}, continue with:\n  node .orca/flow.mjs --from ${members[0].id} "${objective}"`);
        }
        const repairedCheck = verifyStepArtifact(step, join(wtDir, artDir), wtDir, readinessMinBytes, {
          mode: "settlement",
          dispatchId: r.dispatchId || null,
          fsEpochMtimeMs: r.fsEpochMtimeMs,
          minMtimeMs: r.clearedAtMs,
          clearedBeforeDispatch: r.clearedBeforeDispatch,
        });
        if (repairedCheck.ok) {
          if (step.verify?.requireContractCommit && repairedCheck.contractCommit)
            recordVerifiedContractCommit(join(wtDir, artDir), repairedCheck.contractCommit, wtDir);
          const LEDGER = getLedger();
          if (LEDGER) {
            const artSha = step.writes ? computeFileSha256(join(wtDir, artDir, step.writes)) : null;
            LEDGER.recordStepSettled({ stepId: step.id, outcome: r.outcome, note: r.note || null, verifyOk: true, contractCommit: repairedCheck.contractCommit || null, artifactSha256: artSha });
          }
          if (r.outcome === "succeeded" && step.gate && !autoRun) runGate(step);
          log(`[readiness] "${step.title}" artifact ready -> ${outPath(step.writes)}`);
          break;
        }
        warn(`[readiness] "${step.title}" attempt ${attempt} ended outcome=${r.outcome} without a usable artifact.`);
        if (attempt >= readinessRetries)
          die(`"${step.title}" still has no usable artifact after ${readinessRetries} readiness retries (needs ${outPath(step.writes)} with at least ${readinessMinBytes} bytes).`);
        if (r.outcome !== "succeeded" && r.outcome !== "failed")
          die(`"${step.title}" returned outcome=${r.outcome} without producing ${outPath(step.writes)} — not retrying without a definite outcome. Inspect its terminal, then re-run with --from ${step.id}.`);
      }
    }
    const still = members.flatMap((s) => readinessOf(s));
    if (still.length) die(`Inputs still unready after repair: ${still.map((x) => x.path).join(", ")}.`);
  }

  return { printPlan, runGroup, runGate, readinessGate, taskIds, executedStepInfo, parseStatusJs };
}
