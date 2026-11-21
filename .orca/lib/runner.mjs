// Pipeline runner: spec rendering, dry-run plan printer, startup chooser,
// readiness gate, parallel/serial group execution, approval gate, and
// integration with isolated worktrees, hard gates, health machine & ledger.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { materializeAgentConfig, restoreAgentConfig } from "../agent-config.mjs";
import { verifyStepArtifact, formatVerifySummary } from "../gate-verify.mjs";
import {
  WORKTREES_MANIFEST,
  recordVerifiedContractCommit,
  clearStaleStepArtifact,
  syncOutputsFromIsolatedWorktree,
  prepareStepWorktree,
  finalizeStepWorktree,
  renderIsolatedWorktreeNote,
} from "../worktree-isolation.mjs";
import {
  classifyMergeDanger,
  snapshotTargetRefs,
  formatMergeDangerPromptBlock,
} from "../merge-danger.mjs";
import { initMemberHealth, evaluateMemberHealth } from "../health.mjs";
import { pick, res, sleepMs, parkedPromptOf, outcomeOf, promptChoice } from "./orca-cli.mjs";
import { createNudgeController } from "./nudge.mjs";
import { parseStatusJs } from "./status.mjs";

const taskOfMsg = (m) => pick(m, ["taskId", "task_id", "task"]);

export function promptReadiness(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { rl.close(); } catch {} resolve(v); };
    rl.on("close", () => done(false));
    rl.question(question, (answer) => done(/^(y|yes)$/i.test(String(answer ?? "").trim())));
  });
}

// Standalone pre-slice startup chooser (may set opt.from before pipeline slicing).
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
  targetBranch, protectedBranches, mergeDangerThresholds,
  turnStartWindowMs, turnStartEscalateMs, readinessRetries, readinessMinBytes,
  allSteps, steps, byId, enabledIds, groups, isParallel,
  agentOf, effectiveModel, timeoutOf, nudgeRetriesOf, nudgeTimeoutOf, outPath,
  orcaClient, statusMgr, notifier, getLedger, getWtDir,
  isolatedState, preStepTargetRefs, setLastMergeDanger, log, warn, die,
}) {
  const { orca, resolveWorktree, resolveWorktreePath, startWorker, workerVitals, wtSource, getRunId, getWt, getWtPin, getOrcaBin } = orcaClient;
  const { statusSet, statusBegin, statusEnd, writeStatus, refreshProgress, writeArtifactSnapshot, listRuns, printRunList } = statusMgr;
  const taskIds = {};
  let attemptSeq = 0;

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
    const rep = (str, tok, val) => str.replaceAll(tok, () => val);
    let rendered = objectiveLine + (step.spec || "") + autonomy + interview + wtNote + mdSuffix;
    rendered = rep(rendered, "{mergeDangerReport}", mergeDangerBlock || "(no merge-danger check configured)");
    rendered = rep(rendered, "{out}", outPath(step.writes));
    rendered = rep(rendered, "{tasks}", step.progress ? outPath(step.progress) : "{tasks}");
    rendered = rep(rendered, "{reads}", readList);
    rendered = rep(rendered, "{targetBranch}", targetBranch);
    rendered = rep(rendered, "{protectedBranches}", protectedBranches.join(", "));
    rendered = rep(rendered, "{worktreesManifest}", outPath(WORKTREES_MANIFEST));
    return rendered;
  }

  function printPlan() {
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

  function ensureTask(step, stepCtx = null) {
    if (taskIds[step.id]) {
      const u = orca(["orchestration", "task-update", "--id", taskIds[step.id], "--status", "ready"]);
      if (!u.ok) warn(`reopen of task '${step.title}' (${taskIds[step.id]}) did not confirm: ${u.stderr || u.raw}`);
      return taskIds[step.id];
    }
    const spec = `# ${step.title}\n\n${renderSpec(step, stepCtx)}`;
    const r = orca(["orchestration", "task-create", "--run", getRunId(), "--spec", spec]);
    const id = pick(res(r.json).task || {}, ["id"]) || pick(res(r.json), ["taskId", "task_id", "id"]);
    if (!id) die(`task-create '${step.title}' returned no taskId. Output: ${r.raw || r.stderr}`);
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
      syncOutputsFromIsolatedWorktree({ step: m.step, stepWtDir: m.ctx.dir, wtDir: getWtDir() || ".", artDirRel: artDir });
    refreshProgress(m.step);
    writeArtifactSnapshot(m.step);
    statusEnd(m.step.id, outcome, m.note);
    notifier.notifyStep(m);
    if (!m.done) return;
    if (m.terminal) {
      const c = orca(["terminal", "close", "--terminal", m.terminal]);
      if (!c.ok) warn(`terminal close '${m.step.title}' did not confirm: ${c.stderr || c.raw}`);
    } else if (m.dispatchId) {
      const rel = orca(["orchestration", "worker-release", "--dispatch", m.dispatchId]);
      if (!rel.ok) warn(`worker-release '${m.step.title}' did not confirm: ${rel.stderr || rel.raw}`);
    }
  }

  const nudgeCtrl = createNudgeController({
    orca, pick, res, sleepMs, parkedPromptOf,
    nudgeRetriesOf, nudgeTimeoutOf, outPath, artifactReady,
    statusSet, writeStatus, warn, settleMember,
    syncOutputsFromIsolatedWorktree, getWtDir, artDir,
  });

  function launchMember(step, stepCtx = null) {
    if (step.verify?.mergeDangerCheck && !preStepTargetRefs[step.id]) {
      preStepTargetRefs[step.id] = snapshotTargetRefs(stepCtx?.isolated ? stepCtx.dir : (getWtDir() || "."), targetBranch);
    }
    const preRefs = preStepTargetRefs[step.id] || { localSha: null, originSha: null, remoteSha: null, remoteError: null, hasOrigin: false, headSha: null };
    const taskId = ensureTask(step, stepCtx);
    const wtTag = stepCtx?.isolated ? `, worktree=${stepCtx.wtName}, branch=${stepCtx.branch}` : "";
    log(`> ${step.title}  (agent=${agentOf(step)}, task=${taskId}${wtTag})`);
    const requestId = `req-${++attemptSeq}-${step.id}`;
    const LEDGER = getLedger();
    if (LEDGER) {
      LEDGER.recordIntent({
        requestId, stepId: step.id, title: step.title, agent: agentOf(step),
        model: effectiveModel(step), attempt: attemptSeq,
        worktree: stepCtx?.isolated ? stepCtx.wtName : (getWt() || "integration"),
        branch: stepCtx?.isolated ? stepCtx.branch : null,
      });
    }
    const launchedAt = Date.now();
    const started = startWorker(step, taskId, stepCtx?.selector || null);
    const dispatchedAt = Date.now();
    const { dispatchId, terminal } = started;
    const receiptTurnStart = started.receiptTurnStart || (terminal ? "observed" : null);
    const health = initMemberHealth({
      startedAt: launchedAt, dispatchedAt, receiptTurnStart,
      turnStartWindowMs: step.turnStartWindowMs ?? turnStartWindowMs,
      turnStartEscalateMs: step.turnStartEscalateMs ?? turnStartEscalateMs,
    });
    if (LEDGER) {
      LEDGER.recordDispatchResult({
        requestId, stepId: step.id, dispatchId, terminal,
        turnStart: health.turnStart, state: started.dispatchState || (terminal ? "manual" : "ready"),
      });
    }
    statusSet(step.id, { health: health.state, turnStart: health.turnStart });
    const interactiveNow = !autoRun && step.interactive;
    const baseIdleMs = timeoutOf(step);
    const baseHardMs = step.hardTimeoutMs ?? cfg.defaults?.hardTimeoutMs ?? 4 * baseIdleMs;
    const maxIdleMs = interactiveNow ? Math.max(baseIdleMs, 3600000) : baseIdleMs;
    return {
      step, ctx: stepCtx, taskId, dispatchId, terminal, requestId,
      preStepTargetSha: preRefs.localSha, preStepOriginTargetSha: preRefs.originSha,
      preStepRemoteTargetSha: preRefs.remoteSha, preStepRemoteError: preRefs.remoteError,
      preStepHasOrigin: preRefs.hasOrigin, preStepHeadSha: preRefs.headSha, health,
      maxIdleMs,
      hardCapMs: interactiveNow ? Math.max(baseHardMs, 14400000) : baseHardMs,
      sliceMs: Math.min(120000, maxIdleMs, health.turnStartWindowMs, health.turnStartEscalateMs),
      startedAt: launchedAt, lastBusy: launchedAt, lastPreview: undefined,
      quietWarned: false, parkedSeen: new Set(), parkedLabel: null, settled: false, done: null, note: "", outcome: null,
      nudge: { left: nudgeRetriesOf(step), phase: null, sentAt: 0, count: 0, outcome: null, done: null },
    };
  }

  function runGroup(members) {
    const materializedDirs = [];
    let M = [];
    const wtDir = getWtDir() || ".";
    const runId = getRunId();
    const LEDGER = getLedger();
    try {
      const prepared = members.map((s) => ({
        step: s,
        ctx: prepareStepWorktree({
          step: s, objective, runId, wtSelector: resolveWorktree(), wtDir,
          artDirRel: artDir, orca, pick, res, byId, effectiveReads, allSteps,
          isolatedState, log, warn, die,
        }),
      }));
      for (const p of prepared) {
        if (p.step.verify || p.ctx.isolated) clearStaleStepArtifact(p.step, wtDir, p.ctx.dir, artDir);
      }
      const sharedMembers = prepared.filter((p) => !p.ctx.isolated).map((p) => ({ ...p.step, agent: agentOf(p.step) }));
      if (sharedMembers.length) {
        materializedDirs.push(wtDir);
        materializeAgentConfig({ worktree: wtDir, members: sharedMembers, cfg, configDir: here, die, warn });
      }
      for (const p of prepared.filter((x) => x.ctx.isolated)) {
        materializedDirs.push(p.ctx.dir);
        materializeAgentConfig({ worktree: p.ctx.dir, members: [{ ...p.step, agent: agentOf(p.step) }], cfg, configDir: here, die, warn });
      }
      for (const s of members) statusBegin(s.id);
      M = prepared.map((p) => launchMember(p.step, p.ctx));
      while (true) {
        const open = M.filter((m) => !m.settled);
        if (!open.length) break;
        const slice = Math.min(...open.map((m) => m.sliceMs));
        for (const m of open) {
          if (m.ctx?.isolated) syncOutputsFromIsolatedWorktree({ step: m.step, stepWtDir: m.ctx.dir, wtDir, artDirRel: artDir });
          refreshProgress(m.step); writeArtifactSnapshot(m.step);
        }
        writeStatus();
        const wait = orca(["orchestration", "check", "--run", runId, "--wait", "--types", "worker_done,escalation,question", "--timeout-ms", String(slice)], { timeoutMs: slice + 60000 });
        const d = res(wait.json);
        const did = pick(d, ["deliveryId", "delivery_id"]) ?? pick(d.delivery || {}, ["id"]);
        const msgs = pick(d, ["messages", "msgs"]) || [];
        if (did) orca(["orchestration", "check", "--run", runId, "--ack", did]);
        for (const msg of msgs) {
          const ty = pick(msg, ["type"]);
          if (ty === "question" || ty === "escalation") log(`  [${ty}] ${pick(msg, ["subject"]) || ""}`);
        }
        for (const m of open) {
          if (m.nudge.phase === "post-done") { nudgeCtrl.nudgePoll(m); continue; }
          const wd = msgs.find((msg) => {
            if (pick(msg, ["type"]) !== "worker_done") return false;
            const mt = taskOfMsg(msg);
            return mt === m.taskId || (mt == null && open.length === 1);
          });
          if (wd) {
            if (m.ctx?.isolated) syncOutputsFromIsolatedWorktree({ step: m.step, stepWtDir: m.ctx.dir, wtDir, artDirRel: artDir });
            if (m.health) {
              evaluateMemberHealth(m.health, { startedAt: m.startedAt, workerDone: true });
              statusSet(m.step.id, { health: m.health.state, turnStart: m.health.turnStart });
            }
            const out = outcomeOf(wd) || "unknown";
            if (!nudgeCtrl.holdForNudge(m, out, wd)) settleMember(m, m.outcome || out, wd);
            continue;
          }
          const v = workerVitals(m.taskId, m.terminal, m.dispatchId);
          if (v.settled) {
            const drain = orca(["orchestration", "check", "--run", runId, "--types", "worker_done"]);
            const dr = res(drain.json);
            const drid = pick(dr, ["deliveryId", "delivery_id"]) ?? pick(dr.delivery || {}, ["id"]);
            const drained = (pick(dr, ["messages", "msgs"]) || []).find((msg) => pick(msg, ["type"]) === "worker_done" && taskOfMsg(msg) === m.taskId) || null;
            if (drid) orca(["orchestration", "check", "--run", runId, "--ack", drid]);
            if (m.ctx?.isolated) syncOutputsFromIsolatedWorktree({ step: m.step, stepWtDir: m.ctx.dir, wtDir, artDirRel: artDir });
            const vout = (drained && outcomeOf(drained)) || v.outcome || "unknown";
            const vdone = drained || { payload: JSON.stringify({ outcome: v.outcome }) };
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
          if (!previewChanged && v.preview != null) {
            const parked = parkedPromptOf(v.preview);
            if (parked && !m.parkedSeen.has(parked.sig)) {
              m.parkedSeen.add(parked.sig);
              m.parkedLabel = parked.label;
              warn(`"${m.step.title}" is PARKED on ${parked.label} (terminal shows "${parked.sig}") — answer it in that terminal; waiting up to the ${Math.round(m.hardCapMs / 60000)}min hard cap.`);
              statusSet(m.step.id, { note: `parked on ${parked.label} — answer it in the terminal` });
            }
          }
          nudgeCtrl.maybeNudgeMidRun(m, v);
          const silenceMs = Date.now() - m.lastBusy;
          if (m.health) {
            const stepArtPath = join(m.ctx?.isolated ? m.ctx.dir : wtDir, artDir, m.step.writes || "");
            let artSize = 0;
            if (m.step.writes && existsSync(stepArtPath)) { try { artSize = statSync(stepArtPath).size; } catch {} }
            const hres = evaluateMemberHealth(m.health, {
              startedAt: m.startedAt, dispatchStatus: v.status, heartbeatMs: v.heartbeatMs,
              previewChanged, previewSeenBefore, parkedLabel: m.parkedLabel, agentWait: v.agentWait,
              artifactSize: artSize, silenceMs, maxIdleMs: m.maxIdleMs,
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
              const lostDone = dlMsgs.find((msg) => pick(msg, ["type"]) === "worker_done" && taskOfMsg(msg) === m.taskId) || null;
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
          if (Date.now() - m.startedAt >= m.hardCapMs) {
            const mins = Math.round((Date.now() - m.startedAt) / 60000);
            log(`[warn] "${m.step.title}" not settled after ${mins}min; leaving its terminal open and stopping the pipeline.`);
            m.note = m.parkedLabel ? `parked on ${m.parkedLabel} — not settled after ${mins}min` : `not settled after ${mins}min`;
            settleMember(m, "still-running", null);
            continue;
          }
          if (silenceMs >= m.maxIdleMs && !m.quietWarned) {
            m.quietWarned = true;
            warn(`"${m.step.title}" quiet for ${Math.round(silenceMs / 60000)}min but its dispatch is alive (status=${v.status}) — waiting up to the ${Math.round(m.hardCapMs / 60000)}min hard cap before giving up.`);
            if (!m.parkedSeen.size) statusSet(m.step.id, { note: `quiet ${Math.round(silenceMs / 60000)}min but alive — waiting to the hard cap` });
          }
        }
      }
      writeStatus();
      return M;
    } finally {
      for (const d of new Set(materializedDirs)) restoreAgentConfig({ worktree: d, warn });
      for (const m of M) {
        if (m.ctx?.isolated) finalizeStepWorktree({ step: m.step, stepCtx: m.ctx, outcome: m.outcome, wtDir, artDirRel: artDir, isolatedState });
      }
    }
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
      const v = verifyStepArtifact(byId[id], join(wtDir, artDir), wtDir, readinessMinBytes, { mode: "readiness" });
      if (!v.ok) missing.push({ id, title: byId[id].title, path: outPath(byId[id].writes), reason: v.reason });
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
        const [r] = runGroup([step]);
        if (r.outcome === "still-running") {
          statusMgr.STATUS.overall = "still-running";
          writeStatus();
          die(`"${step.title}" ${r.note}. Its terminal ${r.terminal || "(dispatch-owned)"} was left OPEN to finish. Watch it; once it writes ${outPath(step.writes)}, continue with:\n  node .orca/flow.mjs --from ${members[0].id} "${objective}"`);
        }
        const repairedCheck = verifyStepArtifact(step, join(wtDir, artDir), wtDir, readinessMinBytes, { mode: "settlement" });
        if (repairedCheck.ok) {
          if (step.verify?.requireContractCommit && repairedCheck.contractCommit)
            recordVerifiedContractCommit(join(wtDir, artDir), repairedCheck.contractCommit, wtDir);
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

  return { printPlan, runGroup, runGate, readinessGate, taskIds, parseStatusJs };
}
