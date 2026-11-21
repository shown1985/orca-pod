#!/usr/bin/env node
// Out-of-Repo Run Ledger + 4-Level Independent Acceptance + Durable Closeout + Bot Anti-Collision Lock (v0.3.0).
// Zero external dependencies: Node builtins + git CLI only.
//
// Standalone CLI:
//   node .orca/ledger.mjs status [--run <runKey>] [--repo <dir>] [--ledger-home <dir>] [--json]
//   node .orca/ledger.mjs pending [--repo <dir>] [--ledger-home <dir>] [--json]
//   node .orca/ledger.mjs check-lock --dedup-key <key> [--repo <dir>] [--ledger-home <dir>] [--json]
//   node .orca/ledger.mjs closeout --run <runKey> --repo <dir> [--target-branch dev] [--ledger-home <dir>] [--json]

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  rmdirSync,
  statSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyMergeDanger } from "./merge-danger.mjs";
import { sanitizeText, sanitizeValue } from "./lib/sanitize.mjs";

export function computeFileSha256(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const SAFE_RUN_KEY_RE = /^[a-zA-Z0-9._-]+$/;

function git(dir, args) {
  return spawnSync("git", ["-C", dir || ".", ...args], { encoding: "utf8" });
}

function safeRealpath(p) {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch {
    const tail = [];
    let cur = abs;
    while (true) {
      const parent = resolve(cur, "..");
      if (parent === cur) return abs;
      tail.unshift(cur.slice(parent.length).replace(/^[/\\]+/, ""));
      cur = parent;
      try { return join(realpathSync(cur), ...tail); } catch { /* keep walking */ }
    }
  }
}

function isInsideDir(child, parent) {
  if (!child || !parent) return false;
  const rel = relative(safeRealpath(parent), safeRealpath(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel));
}

export function resolveRepoRoot(dir) {
  const r = git(dir || ".", ["rev-parse", "--show-toplevel"]);
  if (!r.error && r.status === 0 && (r.stdout || "").trim()) {
    return safeRealpath((r.stdout || "").trim());
  }
  return safeRealpath(dir || ".");
}

/**
 * M3 FIX: Enumerate EVERY forbidden git directory for a repo:
 * current toplevel, git common-dir (main checkout's .git & its parent), AND all linked worktrees.
 */
function resolveAllRepoBoundaries(repoDir) {
  const boundaries = new Set();
  if (!repoDir) return [];
  boundaries.add(resolveRepoRoot(repoDir));

  const common = git(repoDir, ["rev-parse", "--git-common-dir"]);
  if (!common.error && common.status === 0 && (common.stdout || "").trim()) {
    const rawCommon = (common.stdout || "").trim();
    const absCommon = rawCommon.startsWith("/") ? rawCommon : resolve(repoDir, rawCommon);
    boundaries.add(safeRealpath(absCommon));
    // Parent of `.git` is the main checkout root
    if (absCommon.endsWith(".git") || absCommon.endsWith(".git/")) {
      boundaries.add(safeRealpath(resolve(absCommon, "..")));
    }
  }

  const wtList = git(repoDir, ["worktree", "list", "--porcelain"]);
  if (!wtList.error && wtList.status === 0) {
    for (const line of (wtList.stdout || "").split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        boundaries.add(safeRealpath(line.slice("worktree ".length).trim()));
      }
    }
  }
  return [...boundaries];
}

export function resolveLedgerHome(override = null) {
  const raw = override || process.env.ORCA_POD_LEDGER_HOME || join(homedir(), ".orca", "pod-ledger");
  return resolve(raw);
}

/**
 * Guardrail: ledger home AND its `runs/` + `locks/` subdirs MUST live strictly outside
 * every checkout/worktree/git-dir belonging to the target repository (blocks symlink tricks too).
 */
export function assertOutOfRepoPath(ledgerHome, repoDir) {
  const resolvedLedger = resolve(ledgerHome);
  const boundaries = resolveAllRepoBoundaries(repoDir);
  const pathsToCheck = [resolvedLedger, join(resolvedLedger, "runs"), join(resolvedLedger, "locks")];
  for (const candidate of pathsToCheck) {
    for (const b of boundaries) {
      if (isInsideDir(candidate, b)) {
        throw new Error(
          `ledger path "${candidate}" resolves inside repository boundary "${b}" — ledger & locks MUST stay strictly outside every git checkout/worktree.`
        );
      }
    }
  }
  return resolvedLedger;
}

function assertSafeRunKey(runKey) {
  const k = String(runKey || "");
  if (!k || k === "." || k === ".." || k.includes("..") || !SAFE_RUN_KEY_RE.test(k)) {
    throw new Error(`invalid runKey "${k}" (must match ${SAFE_RUN_KEY_RE} with no traversal).`);
  }
  return k;
}

function atomicWriteJson(filePath, obj) {
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, JSON.stringify(obj, null, 2) + "\n", "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
}

function appendJsonl(filePath, rec) {
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  appendFileSync(filePath, JSON.stringify(rec) + "\n", "utf8");
}

function hashKey(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

/**
 * M2 FIX: Snapshot BOTH local `<branch>` AND `origin/<branch>` refs (when present)
 * so branch creations (null -> sha), deletions (sha -> null), and remote pushes are visible.
 */
export function snapshotBranchShas(gitDir, branches) {
  const out = {};
  for (const b of branches || []) {
    const r = git(gitDir, ["rev-parse", "--verify", "--quiet", `${b}^{commit}`]);
    out[b] = (!r.error && r.status === 0) ? (r.stdout || "").trim() : null;
    const ro = git(gitDir, ["rev-parse", "--verify", "--quiet", `origin/${b}^{commit}`]);
    if (!ro.error && ro.status === 0) {
      out[`origin/${b}`] = (ro.stdout || "").trim();
    } else if (Object.prototype.hasOwnProperty.call(out, `origin/${b}`)) {
      out[`origin/${b}`] = null;
    }
  }
  return out;
}

export function buildInitialAcceptance() {
  return {
    implemented: { status: false, evidenceRef: null, updatedAt: null },
    integrated: { status: false, evidenceRef: null, updatedAt: null },
    merged: { status: false, evidenceRef: null, updatedAt: null },
    synced: { status: false, evidenceRef: null, updatedAt: null },
  };
}

/**
 * Create a durable out-of-repo Run Ledger handle for a pipeline invocation.
 */
export function createRunLedger({
  runKey,
  repoDir,
  ledgerHome = null,
  objective = "",
  configFile = "",
  parentRunKey = null,
  targetBranch = "dev",
  protectedBranches = ["main", "master"],
  dedupKey = null,
  initialProtectedShas = null,
  warn = console.warn,
} = {}) {
  const home = assertOutOfRepoPath(resolveLedgerHome(ledgerHome), repoDir);
  const runsDir = join(home, "runs");
  mkdirSync(runsDir, { recursive: true });
  // Re-verify after mkdir in case runsDir was pre-created as a symlink into the repo
  assertOutOfRepoPath(home, repoDir);

  const safeKey = assertSafeRunKey(String(runKey || `run-${Date.now()}`).replace(/[^a-zA-Z0-9._-]+/g, "_"));
  const jsonlPath = join(runsDir, `${safeKey}.jsonl`);
  const summaryPath = join(runsDir, `${safeKey}.summary.json`);
  const repoRoot = resolveRepoRoot(repoDir);
  const protectedSnap = initialProtectedShas || snapshotBranchShas(repoDir, protectedBranches);
  const headRes = git(repoDir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const brRes = git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const startHeadSha = (!headRes.error && headRes.status === 0) ? (headRes.stdout || "").trim() : null;
  const startBranch = (!brRes.error && brRes.status === 0) ? (brRes.stdout || "").trim() : null;

  const summary = {
    schemaVersion: 1,
    runKey: safeKey,
    parentRunKey: parentRunKey || null,
    orcaRunId: null,
    repoRoot,
    worktreeDir: safeRealpath(repoDir),
    objective,
    configFile,
    targetBranch,
    protectedBranches,
    dedupKey: dedupKey || null,
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt: null,
    health: "healthy",
    initialProtectedShas: protectedSnap,
    integrationBranch: startBranch,
    integrationHeadSha: startHeadSha,
    verifiedContractCommit: null,
    acceptance: buildInitialAcceptance(),
    pending: null,
    closeout: null,
    steps: {},
    gaps: [],
    fallbacks: [],
    watchdogEvents: [],
    issues: null,
  };

  function persistSummary(soft = true) {
    summary.updatedAt = new Date().toISOString();
    try {
      atomicWriteJson(summaryPath, summary);
      return true;
    } catch (e) {
      if (!soft) throw e;
      warn(`[ledger] summary write failed (continuing): ${e.message}`);
      return false;
    }
  }

  function append(kind, data, { critical = false } = {}) {
    const rec = {
      ts: new Date().toISOString(),
      runKey: safeKey,
      kind,
      ...data,
    };
    try {
      appendJsonl(jsonlPath, rec);
    } catch (e) {
      if (critical) throw e;
      summary.gaps.push({ ts: rec.ts, kind, error: e.message });
      warn(`[ledger] append "${kind}" failed (recorded gap): ${e.message}`);
      return null;
    }
    persistSummary(!critical);
    return rec;
  }

  append("run_start", {
    repoRoot,
    worktreeDir: summary.worktreeDir,
    objective,
    configFile,
    targetBranch,
    protectedBranches,
    dedupKey: summary.dedupKey,
    initialProtectedShas: protectedSnap,
    integrationBranch: startBranch,
    integrationHeadSha: startHeadSha,
  }, { critical: false });

  return {
    runKey: safeKey,
    ledgerHome: home,
    jsonlPath,
    summaryPath,
    summary,

    setOrcaRunId(orcaRunId) {
      summary.orcaRunId = orcaRunId;
      append("run_bound", { orcaRunId });
    },

    setParentRunKey(nextParentKey) {
      summary.parentRunKey = nextParentKey || null;
      append("lineage", { parentRunKey: summary.parentRunKey }, { critical: false });
      persistSummary(false);
    },

    updateIntegrationHead(gitDir) {
      const h = git(gitDir || repoDir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
      const b = git(gitDir || repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (!h.error && h.status === 0 && FULL_SHA_RE.test((h.stdout || "").trim())) {
        summary.integrationHeadSha = (h.stdout || "").trim();
      }
      if (!b.error && b.status === 0 && (b.stdout || "").trim()) {
        summary.integrationBranch = (b.stdout || "").trim();
      }
    },

    recordIntent({ requestId, stepId, title, agent, model, requestedModel = null, requestedEffort = null, effort = null, family = null, attempt = 1, worktree = null, branch = null }) {
      const normModel = model && model !== "default" ? model : "default";
      const prev = summary.steps[stepId] || {};
      const prevFams = Array.isArray(prev.executedFamilies) ? prev.executedFamilies : [];
      summary.steps[stepId] = {
        ...prev,
        title,
        requestedAgent: agent,
        requestedModel: requestedModel || normModel,
        requestedEffort: requestedEffort || effort || null,
        agent,
        model: normModel,
        effort: null, // Effective effort is populated by recordDispatchResult once actual CLI argv/receipt is confirmed!
        family: family || prev.family || null,
        executedFamilies: prevFams,
        attempt,
        worktree,
        branch,
        requestId,
        lifecycle: "intent_recorded",
        turnStart: "unobserved",
        health: "healthy",
      };
      return append("intent", {
        requestId, stepId, title,
        requestedAgent: agent,
        requestedModel: requestedModel || normModel,
        requestedEffort: requestedEffort || effort || null,
        family: family || null,
        attempt, worktree, branch,
      }, { critical: false });
    },

    recordStartAttempts({ requestId, stepId, attempts = [] }) {
      const safeAttempts = sanitizeValue(attempts, { maxStringLen: 240 });
      const cur = summary.steps[stepId] || {};
      summary.steps[stepId] = {
        ...cur,
        startAttempts: [...(Array.isArray(cur.startAttempts) ? cur.startAttempts : []), ...safeAttempts],
      };
      return append("start_attempts", { requestId, stepId, attempts: safeAttempts }, { critical: false });
    },

    recordDispatchResult({
      requestId, stepId, dispatchId = null, terminal = null, turnStart = "unobserved", state = null,
      effectiveAgent = null, effectiveModel = null, effectiveEffort = null, executedFamilies = null,
    }) {
      const cur = summary.steps[stepId] || {};
      const mergedFams = Array.isArray(executedFamilies)
        ? [...new Set([...(cur.executedFamilies || []), ...executedFamilies])]
        : (cur.executedFamilies || []);
      const resolvedEffModel = effectiveModel || cur.model || "default";
      const resolvedEffEffort = effectiveEffort !== undefined ? effectiveEffort : (cur.effort || null);
      summary.steps[stepId] = {
        ...cur,
        agent: effectiveAgent || cur.agent,
        model: resolvedEffModel,
        effectiveModel: resolvedEffModel,
        effort: resolvedEffEffort,
        effectiveEffort: resolvedEffEffort,
        executedFamilies: mergedFams,
        dispatchId,
        terminal,
        turnStart,
        dispatchState: state,
        lifecycle: "dispatched",
      };
      return append("result", {
        requestId, stepId, dispatchId, terminal, turnStart, state,
        effectiveAgent: effectiveAgent || cur.agent,
        effectiveModel: effectiveModel || cur.model || "default",
        effectiveEffort: effectiveEffort ?? null,
        executedFamilies: mergedFams,
      }, { critical: false });
    },

    recordWorkerStopped({ stepId, dispatchId = null, terminal = null, agent = null, reason = null }) {
      const safeReason = reason ? sanitizeText(reason, { maxLen: 240 }) : null;
      const cur = summary.steps[stepId] || {};
      summary.steps[stepId] = {
        ...cur,
        lastStoppedDispatchId: dispatchId || cur.lastStoppedDispatchId || null,
      };
      return append("worker_stopped", { stepId, dispatchId, terminal, agent, reason: safeReason }, { critical: false });
    },

    recordHealth({ stepId, state, turnStart, signals = [], note = null }) {
      const safeNote = note ? sanitizeText(note, { maxLen: 260 }) : null;
      const safeSignals = sanitizeValue(signals, { maxStringLen: 240 });
      const cur = summary.steps[stepId] || {};
      summary.steps[stepId] = { ...cur, health: state, turnStart: turnStart || cur.turnStart, healthNote: safeNote };
      summary.health = state;
      return append("health", { stepId, state, turnStart, signals: safeSignals, note: safeNote }, { critical: false });
    },

    recordFallback({ stepId, fromAgent, fromModel = null, toAgent, toModel = null, toEffort = null, toFamily = null, reason = null, phase = "preflight" }) {
      const safeReason = reason ? sanitizeText(reason, { maxLen: 280 }) : null;
      const entry = {
        ts: new Date().toISOString(),
        stepId,
        phase,
        fromAgent,
        fromModel: (fromModel && fromModel !== "default") ? fromModel : "default",
        toAgent,
        toModel: (toModel && toModel !== "default") ? toModel : "default",
        toEffort: toEffort || null,
        toFamily: toFamily || null,
        reason: safeReason,
      };
      summary.fallbacks.push(entry);
      const cur = summary.steps[stepId] || {};
      summary.steps[stepId] = {
        ...cur,
        agent: toAgent,
        model: entry.toModel,
        effort: toEffort || null,
        family: toFamily || cur.family || null,
        fallback: entry,
      };
      return append("fallback", entry, { critical: false });
    },

    recordWatchdogEvent({ stepId, kind, action, diagnosis = null, evidence = null }) {
      const safeDiag = diagnosis ? sanitizeText(diagnosis, { maxLen: 280 }) : null;
      const safeEv = sanitizeValue(evidence, { maxStringLen: 240 });
      const entry = {
        ts: new Date().toISOString(),
        stepId,
        kind,
        action,
        diagnosis: safeDiag,
        evidence: safeEv,
      };
      summary.watchdogEvents.push(entry);
      if (summary.watchdogEvents.length > 50) summary.watchdogEvents.shift();
      const cur = summary.steps[stepId] || {};
      summary.steps[stepId] = { ...cur, lastWatchdog: entry };
      return append("watchdog", entry, { critical: false });
    },

    recordIssueLinks({ provider = null, repo = null, defaultBranch = null, epic = null, tasks = [] }) {
      summary.issues = {
        provider,
        repo,
        defaultBranch: defaultBranch || null,
        epic: epic ? { number: epic.number, url: epic.url || null, title: sanitizeText(epic.title || "", { maxLen: 160 }) || null } : null,
        tasks: (tasks || []).map((t) => ({ id: t.id, number: t.number || null, url: t.url || null, title: sanitizeText(t.title || "", { maxLen: 160 }) || null })),
        updatedAt: new Date().toISOString(),
      };
      return append("issue_links", summary.issues, { critical: false });
    },

    recordStepSettled({ stepId, outcome, note = null, verifyOk = null, verifyReason = null, contractCommit = null, artifactSha256 = null, stepHeadSha = null }) {
      const safeNote = note ? sanitizeText(note, { maxLen: 280 }) : null;
      const safeVerify = verifyReason ? sanitizeText(verifyReason, { maxLen: 280 }) : null;
      const cur = summary.steps[stepId] || {};
      summary.steps[stepId] = {
        ...cur,
        lifecycle: "settled",
        outcome,
        note: safeNote,
        verifyOk,
        verifyReason: safeVerify,
        artifactSha256: artifactSha256 || cur.artifactSha256 || null,
        stepHeadSha: stepHeadSha || cur.stepHeadSha || null,
      };
      if (contractCommit && FULL_SHA_RE.test(contractCommit)) {
        summary.verifiedContractCommit = contractCommit;
      }
      return append("step_settled", { stepId, outcome, note: safeNote, verifyOk, verifyReason: safeVerify, contractCommit, artifactSha256: summary.steps[stepId].artifactSha256, stepHeadSha: summary.steps[stepId].stepHeadSha }, { critical: false });
    },

    recordAcceptanceLevel(level, { status, evidenceRef, detail = null }) {
      if (!Object.prototype.hasOwnProperty.call(summary.acceptance, level)) {
        throw new Error(`unknown acceptance level "${level}"`);
      }
      if (status === true && (!evidenceRef || !String(evidenceRef).trim())) {
        throw new Error(`acceptance level "${level}" cannot be set to true without an explicit evidenceRef`);
      }
      summary.acceptance[level] = {
        status: Boolean(status),
        evidenceRef: evidenceRef || null,
        detail: detail || null,
        updatedAt: new Date().toISOString(),
      };
      return append("acceptance", { level, status: Boolean(status), evidenceRef: evidenceRef || null, detail }, { critical: false });
    },

    recordPendingHumanMerge({ targetBranch: tb, door = "one-way", triggers = [], artifact = null, headSha = null }) {
      const effectiveHead = headSha || summary.integrationHeadSha || null;
      if (effectiveHead && FULL_SHA_RE.test(effectiveHead)) {
        summary.integrationHeadSha = effectiveHead;
      }
      summary.pending = {
        pendingType: "human_merge",
        targetBranch: tb || summary.targetBranch,
        door,
        triggers,
        artifact,
        headSha: effectiveHead,
        recordedAt: new Date().toISOString(),
        resolvedAt: null,
      };
      summary.status = "pending-human-merge";
      return append("pending", summary.pending, { critical: false });
    },

    reconcileCloseout({ wtDir, artDirRel = ".orca/artifacts", overall = "succeeded", mergeDanger = null } = {}) {
      const closeout = computeCloseout({
        summary,
        wtDir: wtDir || summary.worktreeDir,
        artDirRel,
        overall,
        mergeDanger,
      });
      summary.closeout = closeout;
      summary.status = closeout.overall;
      summary.endedAt = closeout.closedAt;
      if (closeout.acceptance) summary.acceptance = closeout.acceptance;
      if (closeout.pendingResolved && summary.pending) {
        summary.pending.resolvedAt = closeout.closedAt;
      }
      if (closeout.issueVerification && summary.issues) {
        summary.issues.closeoutVerification = closeout.issueVerification;
      }
      append("closeout", closeout, { critical: false });
      return closeout;
    },
  };
}

function isCommitContainedInTarget(dir, commitSha, targetBranch) {
  if (!commitSha || !FULL_SHA_RE.test(commitSha)) return { contained: false, method: null };
  // 1) Normal / fast-forward merge: commitSha is an ancestor of targetBranch
  const anc = git(dir, ["merge-base", "--is-ancestor", commitSha, targetBranch]);
  if (!anc.error && anc.status === 0) return { contained: true, method: "is-ancestor" };
  // 2) Squash / rebase merge equivalence: `git cherry <targetBranch> <commitSha>`
  //    returns non-empty lines all prefixed with `-` when every patch is equivalent in targetBranch.
  const cherry = git(dir, ["cherry", targetBranch, commitSha]);
  if (!cherry.error && cherry.status === 0) {
    const lines = (cherry.stdout || "").split(/\r?\n/).filter(Boolean);
    if (lines.length > 0 && lines.every((l) => l.startsWith("-"))) {
      return { contained: true, method: "cherry-equivalent" };
    }
  }
  return { contained: false, method: null };
}

/**
 * Authoritative 8-row Closeout reconciliation (callable at run end AND standalone after human merge).
 */
export function computeCloseout({ summary, wtDir, artDirRel = ".orca/artifacts", overall = "succeeded", mergeDanger = null }) {
  const dir = wtDir || summary.worktreeDir || ".";
  const inGit = !git(dir, ["rev-parse", "--is-inside-work-tree"]).error && git(dir, ["rev-parse", "--is-inside-work-tree"]).status === 0;
  const headRes = inGit ? git(dir, ["rev-parse", "HEAD"]) : { status: 1 };
  const headSha = (!headRes.error && headRes.status === 0) ? (headRes.stdout || "").trim() : null;
  const branchRes = inGit ? git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) : { status: 1 };
  const headBranch = (!branchRes.error && branchRes.status === 0) ? (branchRes.stdout || "").trim() : null;
  const dirtyRes = inGit ? git(dir, ["status", "--porcelain"]) : { status: 1 };
  let dirty = null;
  if (!dirtyRes.error && dirtyRes.status === 0) {
    // Ignore local .orca/artifacts/ runtime files when assessing working tree cleanliness
    const normArt = String(artDirRel || ".orca/artifacts").replace(/^\/+|\/+$/g, "") + "/";
    const dirtyLines = (dirtyRes.stdout || "").split(/\r?\n/).filter(Boolean).filter((l) => {
      const fp = l.slice(3).trim();
      return !fp.startsWith(normArt) && fp !== normArt.slice(0, -1);
    });
    dirty = dirtyLines.length > 0;
  }

  // Row 1 & 2: Manifest & isolated task branch ancestry
  const mfPath = join(dir, artDirRel, "WORKTREES.json");
  let manifest = null;
  if (existsSync(mfPath)) {
    try { manifest = JSON.parse(readFileSync(mfPath, "utf8")); } catch { manifest = null; }
  }
  const verifiedContractCommit = summary.verifiedContractCommit || manifest?.verifiedContractCommit || null;
  const taskBranches = [];
  let allTasksIntegrated = null;
  if (manifest && manifest.tasks && Object.keys(manifest.tasks).length > 0) {
    allTasksIntegrated = true;
    for (const [stepId, info] of Object.entries(manifest.tasks)) {
      const sha = info.headCommit || info.headSha || null;
      let ancestor = null;
      if (inGit && sha && FULL_SHA_RE.test(sha)) {
        const a = git(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]);
        ancestor = !a.error && a.status === 0;
        if (!ancestor) allTasksIntegrated = false;
      } else {
        allTasksIntegrated = false;
      }
      taskBranches.push({ stepId, branch: info.branch || null, wtName: info.wtName || null, headSha: sha, dirty: info.dirty ?? null, integratedIntoHead: ancestor });
    }
  }

  // Row 4 & 5: Merge Danger & target branch containment
  // M7 FIX: Always verify the PINNED integration commit (summary.pending.headSha || summary.integrationHeadSha),
  // NEVER fall back to current HEAD if the repo is currently checked out ON targetBranch!
  const targetBranch = summary.targetBranch || "dev";
  const candidateCommit = summary.pending?.headSha
    || summary.integrationHeadSha
    || (headBranch && headBranch !== targetBranch ? headSha : null);

  const doorInfo = mergeDanger || (inGit && candidateCommit ? classifyMergeDanger(dir, targetBranch, { headRef: candidateCommit }) : null);
  let targetBranchSha = null;
  let headInTarget = false;
  let mergeMethod = null;
  if (inGit && candidateCommit) {
    const tRes = git(dir, ["rev-parse", "--verify", "--quiet", `${targetBranch}^{commit}`]);
    if (!tRes.error && tRes.status === 0) {
      targetBranchSha = (tRes.stdout || "").trim();
      const chk = isCommitContainedInTarget(dir, candidateCommit, targetBranch);
      headInTarget = chk.contained;
      mergeMethod = chk.method;
    }
  }

  // Row 6: Protected branches untouched verification (M2 FIX: local + origin, includes null<->sha creation/deletion)
  const protectedBranches = summary.protectedBranches || ["main", "master"];
  const currentProtectedShas = inGit ? snapshotBranchShas(dir, protectedBranches) : {};
  const initialProtectedShas = summary.initialProtectedShas || {};
  const protectedViolations = [];
  const allWatchedKeys = new Set([...Object.keys(initialProtectedShas), ...Object.keys(currentProtectedShas)]);
  for (const key of allWatchedKeys) {
    const before = initialProtectedShas[key] ?? null;
    const after = currentProtectedShas[key] ?? null;
    if (before !== after) {
      protectedViolations.push({ branch: key, before, after });
    }
  }

  // 4-Level Independent Acceptance projection
  const acceptance = JSON.parse(JSON.stringify(summary.acceptance || buildInitialAcceptance()));
  if (allTasksIntegrated === true && headSha && !acceptance.integrated.status) {
    acceptance.integrated = {
      status: true,
      evidenceRef: `git:is-ancestor(${taskBranches.map((t) => `${t.stepId}@${(t.headSha || "").slice(0, 8)}`).join(",")})->${headSha.slice(0, 8)}`,
      detail: `${taskBranches.length} isolated task branch(es) verified as ancestor of HEAD`,
      updatedAt: new Date().toISOString(),
    };
  }
  if (headInTarget && targetBranchSha && candidateCommit && !acceptance.merged.status) {
    acceptance.merged = {
      status: true,
      evidenceRef: `git:${mergeMethod}(${candidateCommit.slice(0, 8)},${targetBranch}@${targetBranchSha.slice(0, 8)})`,
      detail: `targetBranch "${targetBranch}" contains integration commit ${candidateCommit.slice(0, 8)} (${mergeMethod})`,
      updatedAt: new Date().toISOString(),
    };
  }
  if (acceptance.merged.status && protectedViolations.length === 0 && dirty === false && !acceptance.synced.status) {
    acceptance.synced = {
      status: true,
      evidenceRef: `git:clean-target(${targetBranch}@${(targetBranchSha || "").slice(0, 8)})+protected-untouched`,
      detail: `local targetBranch "${targetBranch}" verified and protected branches untouched`,
      updatedAt: new Date().toISOString(),
    };
  }

  const pendingHumanMerge = Boolean(summary.pending && !summary.pending.resolvedAt && !headInTarget);
  const finalOverall = pendingHumanMerge && overall === "succeeded" ? "pending-human-merge" : overall;

  // P1-08: Reconcile PR artifact <-> linked Issue traceability & merge state in closeout
  let issueVerification = null;
  if (summary.issues) {
    const prCandidates = ["EPIC_RELEASE_GATE.md", "PR_SUMMARY.md", "HOTFIX_PR.md"];
    let prText = "";
    let prArtifact = null;
    for (const f of prCandidates) {
      const fp = join(dir, artDirRel, f);
      if (existsSync(fp)) {
        try { prText = readFileSync(fp, "utf8"); prArtifact = f; break; } catch {}
      }
    }
    const prUrlMatch = prText.match(/https?:\/\/[^\s"'<>]+\/(?:pull|pulls)\/(\d+)/i);
    const mergeStatusMatch = prText.match(/Merge-Status\s*:\s*(\S+)/i);
    issueVerification = {
      prArtifact,
      prUrl: prUrlMatch ? sanitizeText(prUrlMatch[0], { maxLen: 180 }) : null,
      prNumber: prUrlMatch ? Number(prUrlMatch[1]) : null,
      mergeStatus: mergeStatusMatch ? mergeStatusMatch[1] : null,
      targetBranchMerged: Boolean(headInTarget),
      verifiedAt: new Date().toISOString(),
    };
  }

  const rows = [
    { row: 1, fact: "accepted_contract_sha", value: verifiedContractCommit, ok: verifiedContractCommit ? true : null },
    { row: 2, fact: "task_branches_integrated", value: taskBranches, ok: allTasksIntegrated },
    { row: 3, fact: "integration_head", value: { branch: headBranch, sha: candidateCommit || headSha, dirty }, ok: Boolean(candidateCommit || headSha) },
    { row: 4, fact: "merge_danger_door", value: doorInfo ? { door: doorInfo.door, triggers: doorInfo.triggers } : null, ok: doorInfo ? true : null },
    { row: 5, fact: "target_branch_merged", value: { targetBranch, targetBranchSha, candidateCommit, headInTarget, mergeMethod, pendingHumanMerge }, ok: headInTarget || pendingHumanMerge },
    { row: 6, fact: "protected_branches_untouched", value: { protectedBranches, violations: protectedViolations }, ok: protectedViolations.length === 0 },
    { row: 7, fact: "isolated_worktrees_accounted", value: taskBranches.length, ok: true },
    { row: 8, fact: "acceptance_levels", value: acceptance, ok: acceptance.implemented.status },
  ];

  return {
    closedAt: new Date().toISOString(),
    overall: finalOverall,
    pendingHumanMerge,
    pendingResolved: Boolean(summary.pending && headInTarget),
    protectedViolations,
    acceptance,
    issueVerification,
    rows,
  };
}

// =============================================================================
// Bot Anti-Collision Dedup Lock (B3 FIX: atomic O_CREAT|O_EXCL via openSync("wx"))
// =============================================================================

function lockFilePath(ledgerHome, dedupKey) {
  return join(ledgerHome, "locks", `${hashKey(dedupKey)}.lock.json`);
}

const UNPARSEABLE_LOCK_GRACE_MS = 5000;

function inspectLockFile(file) {
  if (!existsSync(file)) return { exists: false, locked: false, stale: false, lock: null };
  let raw = "";
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { exists: false, locked: false, stale: false, lock: null };
    return { exists: true, locked: true, stale: false, lock: null };
  }
  try {
    const lock = JSON.parse(raw);
    const alive = isPidAlive(lock?.pid);
    return { exists: true, locked: alive, stale: !alive, lock };
  } catch {
    // R2-B2 / m8 FIX: Treat unparseable lock as LIVE unless older than grace period (never steal in-flight lock).
    const ageMs = Date.now() - mtimeMs;
    const stale = ageMs >= UNPARSEABLE_LOCK_GRACE_MS;
    return { exists: true, locked: !stale, stale, lock: null };
  }
}

export function checkRunLock({ dedupKey, repoDir, ledgerHome = null }) {
  const home = assertOutOfRepoPath(resolveLedgerHome(ledgerHome), repoDir);
  const file = lockFilePath(home, dedupKey);
  const info = inspectLockFile(file);
  return { locked: info.locked, stale: info.stale, lock: info.lock, file };
}

export function acquireRunLock({ dedupKey, runKey, repoDir, objective = "", ledgerHome = null }) {
  const home = assertOutOfRepoPath(resolveLedgerHome(ledgerHome), repoDir);
  const locksDir = join(home, "locks");
  mkdirSync(locksDir, { recursive: true });
  assertOutOfRepoPath(home, repoDir);

  const file = lockFilePath(home, dedupKey);
  const reclaimMutex = `${file}.reclaim.d`;
  let reclaimedStaleFromPid = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    const lockObj = {
      dedupKey,
      runKey,
      pid: process.pid,
      repoRoot: resolveRepoRoot(repoDir),
      objective,
      startedAt: new Date().toISOString(),
      reclaimedStaleFromPid,
    };
    // R2-B2 FIX: Write complete fsynced payload to a private tmp file, then POSIX-atomic linkSync(tmp, file).
    // Lock file is NEVER half-written and linkSync fails with EEXIST if any contender already linked it.
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${attempt}`;
    const fd = openSync(tmp, "wx");
    try {
      writeFileSync(fd, JSON.stringify(lockObj, null, 2) + "\n", "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, file);
      try { unlinkSync(tmp); } catch { /* ignore */ }
      return {
        acquired: true,
        reclaimedStale: reclaimedStaleFromPid !== null,
        holder: lockObj,
        file,
      };
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      if (!e || e.code !== "EEXIST") throw e;

      const cur = inspectLockFile(file);
      if (cur.locked) {
        return { acquired: false, reclaimedStale: false, holder: cur.lock, file };
      }
      if (!cur.exists) continue;

      // R2-B2 FIX: Serialize stale-lock reclamation with an atomic mkdir mutex,
      // re-verify the lock inside the mutex so we can NEVER unlink a newly-acquired live lock!
      let gotMutex = false;
      try {
        mkdirSync(reclaimMutex);
        gotMutex = true;
      } catch (me) {
        if (me && me.code === "EEXIST") {
          // Clean up an abandoned reclaim mutex older than 30s
          try {
            if (Date.now() - statSync(reclaimMutex).mtimeMs > 30000) rmdirSync(reclaimMutex);
          } catch { /* ignore */ }
          continue;
        }
        throw me;
      }
      try {
        const recheck = inspectLockFile(file);
        if (recheck.locked) {
          return { acquired: false, reclaimedStale: false, holder: recheck.lock, file };
        }
        if (recheck.exists && recheck.stale) {
          reclaimedStaleFromPid = recheck.lock?.pid ?? -1;
          try { unlinkSync(file); } catch { /* ignore */ }
        }
      } finally {
        if (gotMutex) { try { rmdirSync(reclaimMutex); } catch { /* ignore */ } }
      }
    }
  }

  const finalCheck = checkRunLock({ dedupKey, repoDir, ledgerHome: home });
  return {
    acquired: false,
    reclaimedStale: false,
    holder: finalCheck.lock,
    file,
  };
}

export function releaseRunLock({ dedupKey, runKey, repoDir, ledgerHome = null }) {
  if (!dedupKey) return false;
  try {
    const home = assertOutOfRepoPath(resolveLedgerHome(ledgerHome), repoDir);
    const file = lockFilePath(home, dedupKey);
    if (!existsSync(file)) return false;
    const cur = JSON.parse(readFileSync(file, "utf8"));
    if (cur.pid === process.pid && (!runKey || cur.runKey === runKey)) {
      unlinkSync(file);
      return true;
    }
  } catch {
    // best effort cleanup
  }
  return false;
}

export function listLedgerSummaries({ ledgerHome = null, repoDir = null } = {}) {
  const home = repoDir
    ? assertOutOfRepoPath(resolveLedgerHome(ledgerHome), repoDir)
    : resolveLedgerHome(ledgerHome);
  const runsDir = join(home, "runs");
  if (!existsSync(runsDir)) return [];
  const filterRepo = repoDir ? resolveRepoRoot(repoDir) : null;
  const out = [];
  for (const f of readdirSync(runsDir)) {
    if (!f.endsWith(".summary.json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(runsDir, f), "utf8"));
      if (filterRepo && s.repoRoot && safeRealpath(s.repoRoot) !== filterRepo) continue;
      out.push(s);
    } catch { /* ignore unreadable */ }
  }
  return out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

// --- Standalone CLI ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const cmd = args[0] || "status";
  const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const ledgerHome = get("--ledger-home");
  const repoDir = get("--repo");
  const runKey = get("--run");
  const asJson = args.includes("--json");

  if (cmd === "check-lock") {
    const dk = get("--dedup-key");
    if (!dk) { console.error("[ledger] --dedup-key is required"); process.exit(1); }
    const res = checkRunLock({ dedupKey: dk, repoDir: repoDir || process.cwd(), ledgerHome });
    console.log(asJson ? JSON.stringify(res, null, 2) : `[ledger] lock=${res.locked ? "ACTIVE" : (res.stale ? "STALE" : "FREE")} dedupKey=${dk}`);
    process.exit(res.locked ? 2 : 0);
  }

  if (cmd === "pending") {
    const runs = listLedgerSummaries({ ledgerHome, repoDir }).filter((s) => s.pending && !s.pending.resolvedAt);
    if (asJson) console.log(JSON.stringify({ pending: runs.map((r) => ({ runKey: r.runKey, objective: r.objective, pending: r.pending })) }, null, 2));
    else if (!runs.length) console.log("[ledger] no pending human-merge one-way doors.");
    else for (const r of runs) console.log(`[ledger] PENDING_HUMAN_MERGE run=${r.runKey} target=${r.pending.targetBranch} triggers=${(r.pending.triggers || []).join(",")} objective="${r.objective}"`);
    process.exit(0);
  }

  if (cmd === "closeout") {
    if (!runKey) { console.error("[ledger] --run <runKey> is required"); process.exit(1); }
    const safeKey = assertSafeRunKey(runKey);
    const home = repoDir
      ? assertOutOfRepoPath(resolveLedgerHome(ledgerHome), repoDir)
      : resolveLedgerHome(ledgerHome);
    const summaryPath = join(home, "runs", `${safeKey}.summary.json`);
    if (!existsSync(summaryPath)) { console.error(`[ledger] run summary not found: ${summaryPath}`); process.exit(1); }
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    const targetRepo = repoDir || summary.worktreeDir;
    assertOutOfRepoPath(home, targetRepo);
    if (get("--target-branch")) summary.targetBranch = get("--target-branch");
    const closeout = computeCloseout({ summary, wtDir: targetRepo, overall: summary.status });
    summary.closeout = closeout;
    summary.acceptance = closeout.acceptance;
    if (closeout.pendingResolved && summary.pending) summary.pending.resolvedAt = closeout.closedAt;
    if (closeout.pendingResolved && summary.status === "pending-human-merge") summary.status = "succeeded";
    summary.updatedAt = new Date().toISOString();
    atomicWriteJson(summaryPath, summary);
    appendJsonl(join(home, "runs", `${safeKey}.jsonl`), { ts: summary.updatedAt, runKey: safeKey, kind: "closeout_reconcile", closeout });
    console.log(asJson ? JSON.stringify(closeout, null, 2) : `[ledger] closeout run=${safeKey} overall=${closeout.overall} protectedOk=${closeout.protectedViolations.length === 0}`);
    process.exit(closeout.protectedViolations.length === 0 ? 0 : 1);
  }

  // default: status
  const runs = listLedgerSummaries({ ledgerHome, repoDir });
  const filtered = runKey ? runs.filter((r) => r.runKey === runKey) : runs.slice(0, 10);
  if (asJson) {
    console.log(JSON.stringify({ runs: filtered }, null, 2));
  } else if (!filtered.length) {
    console.log("[ledger] no runs recorded.");
  } else {
    for (const r of filtered) {
      const acc = r.acceptance || {};
      const lvls = ["implemented", "integrated", "merged", "synced"].map((k) => `${k}:${acc[k]?.status ? "Y" : "N"}`).join(" ");
      console.log(`[ledger] ${r.runKey}  status=${r.status}  health=${r.health}  ${lvls}  "${r.objective}"`);
    }
  }
}
