#!/usr/bin/env node
// Orca-Pod Flow Orchestrator — thin CLI entry point & pipeline controller.
// Zero dependencies (Node >= 18 builtins only).
//
// Usage:
//   node .orca/flow.mjs "Build feature X"
//   node .orca/flow.mjs --config flow-epic.json "#epic ..."
//   node .orca/flow.mjs --dry-run "Preview pipeline plan"
//   node .orca/flow.mjs --scan [--json]          # scan local agents & recommend routing
//   node .orca/flow.mjs --setup [--yes]          # interactive pre-dev strategy confirmation
//   node .orca/flow.mjs --from coding "..."      # resume from step
//   node .orca/flow.mjs --only a,b "..."         # run selected steps
//   node .orca/flow.mjs --agent coding=claude "."# override step agent
//   node .orca/flow.mjs --status-preview         # render fixture dashboard

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgentConfig, restoreAgentConfig } from "./agent-config.mjs";
import { validateVerifyConfig, verifyStepArtifact } from "./gate-verify.mjs";
import {
  validateIsolationConfig,
  recordVerifiedContractCommit,
  recordMergedAfterContract,
  knownIsolatedWorktreePaths,
} from "./worktree-isolation.mjs";
import { validateMergeDangerConfig, verifyMergeDangerGate } from "./merge-danger.mjs";
import {
  snapshotBranchShas,
  createRunLedger,
  acquireRunLock,
  releaseRunLock,
} from "./ledger.mjs";
import { scanLocalAgents, recommendStrategy, formatScanReport } from "./agent-scanner.mjs";
import { runStrategyWizard } from "./strategy-wizard.mjs";
import {
  resolveIssueTrackingConfig,
  detectIssueProvider,
  loadIssueState,
  syncPlanIssues,
} from "./issue-tracker.mjs";
import { generateCiCdFiles } from "./ci-generator.mjs";
import { createOrcaClient, pick, res, wtStamp, slugify, headSha, MODEL_FLAG_RE, isKiroCmd } from "./lib/orca-cli.mjs";
import { createStatusManager, writeStatusTo } from "./lib/status.mjs";
import { createNotifier } from "./lib/notify.mjs";
import { reportUsage } from "./lib/usage.mjs";
import { createRunner, runEarlyChooser } from "./lib/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..");

let statusMgr = null;
let notifier = null;
let orcaClient = null;
let LEDGER = null;
let LOCK_CTX = null;
let LAST_MERGE_DANGER = null;
let PENDING_HUMAN_MERGE = false;
let HISTORY_ARCHIVE_DONE = false;
const PRE_STEP_TARGET_REFS = {};
const isolatedState = {};

const log = (...a) => console.log("[orca-flow]", ...a);
const warn = (...a) => console.warn("[orca-flow]", ...a);

let ART_DIR = ".orca/artifacts";
let allSteps = [];
let outPath = (file) => `${ART_DIR}/${file}`;

const die = (m) => {
  console.error("[orca-flow] ERROR:", m);
  if (statusMgr?.STATUS?.meta?.runId) {
    const S = statusMgr.STATUS;
    for (const st of S.steps)
      if ((st.status === "running" || st.status === "waiting-approval") && !st.endedAt) st.status = "unknown";
    if (S.overall === "running") S.overall = "failed";
    try { writeStatusTo(statusMgr.statusDir(), S); } catch {}
    try {
      reportUsage({
        STATUS: S, wt: orcaClient?.getWt(), wtPath: orcaClient?.getWtPath(),
        allSteps, outPath, statusDir: statusMgr.statusDir, writeStatusTo, log, warn,
      });
    } catch (e) { warn(`[usage] report skipped (${e.message})`); }
    try { notifier?.notifyRun(S.overall); } catch {}
  }
  if (LEDGER) {
    try {
      LEDGER.reconcileCloseout({
        wtDir: orcaClient?.getWtPath() || ".",
        artDirRel: ART_DIR,
        overall: statusMgr?.STATUS?.overall || "failed",
        mergeDanger: LAST_MERGE_DANGER,
      });
    } catch {}
  }
  if (LOCK_CTX) {
    try { releaseRunLock(LOCK_CTX); } catch {}
    LOCK_CTX = null;
  }
  process.exit(1);
};

// --- Parse CLI flags ---
const argv = process.argv.slice(2);
const opt = {
  from: null, only: null, dryRun: false, config: null, agentOverrides: {},
  grillMe: undefined, worktree: null, createWorktree: false,
  noOpenStatus: false, statusPreview: false, newRun: false,
  allowOneWayMerge: false, dedupKey: null, ledgerHome: null,
  scan: false, setup: false, json: false, yes: false, noOrca: false,
  issues: false, noIssues: false, epicIssue: null,
  generateCi: false, selfHostedCd: false,
};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--from") opt.from = argv[++i];
  else if (a === "--only") opt.only = argv[++i].split(",").map((s) => s.trim());
  else if (a === "--dry-run") opt.dryRun = true;
  else if (a === "--grill-me" || a === "--no-grill-me") {
    const v = a === "--grill-me";
    if (opt.grillMe !== undefined && opt.grillMe !== v) die("--grill-me and --no-grill-me are mutually exclusive.");
    opt.grillMe = v;
  } else if (a === "--config") opt.config = argv[++i];
  else if (a === "--worktree") opt.worktree = argv[++i];
  else if (a === "--create-worktree") opt.createWorktree = true;
  else if (a === "--no-open-status") opt.noOpenStatus = true;
  else if (a === "--status-preview") opt.statusPreview = true;
  else if (a === "--new") opt.newRun = true;
  else if (a === "--allow-one-way-merge") opt.allowOneWayMerge = true;
  else if (a === "--dedup-key") opt.dedupKey = argv[++i];
  else if (a === "--ledger-home") opt.ledgerHome = argv[++i];
  else if (a === "--scan") opt.scan = true;
  else if (a === "--setup") opt.setup = true;
  else if (a === "--json") opt.json = true;
  else if (a === "--yes" || a === "--apply-recommended") opt.yes = true;
  else if (a === "--no-orca") opt.noOrca = true;
  else if (a === "--issues") opt.issues = true;
  else if (a === "--no-issues") opt.noIssues = true;
  else if (a === "--epic-issue") opt.epicIssue = argv[++i];
  else if (a === "--generate-ci") opt.generateCi = true;
  else if (a === "--self-hosted-cd") opt.selfHostedCd = true;
  else if (a === "--agent") {
    const [step, ag] = argv[++i].split("=");
    if (step && ag) opt.agentOverrides[step] = ag;
  } else rest.push(a);
}

// --- Pre-development strategy scan / interactive setup commands ---
if (opt.scan) {
  const scan = scanLocalAgents({ queryOrca: !opt.noOrca });
  const recommendation = recommendStrategy(scan);
  if (opt.json) console.log(JSON.stringify({ scan, recommendation }, null, 2));
  else console.log(formatScanReport(scan, recommendation));
  process.exit(0);
}
if (opt.setup) {
  const scan = scanLocalAgents({ queryOrca: !opt.noOrca });
  const recommendation = recommendStrategy(scan);
  await runStrategyWizard({
    projectDir: PROJECT_ROOT,
    scan,
    recommendation,
    interactive: !opt.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY),
    applyRecommended: opt.yes,
  });
  process.exit(0);
}
if (opt.generateCi) {
  const res = generateCiCdFiles(PROJECT_ROOT, {
    writeGithubCi: true,
    writeGiteaCi: false,
    writeSelfHostedCd: opt.selfHostedCd,
    force: true,
  });
  if (opt.json) console.log(JSON.stringify(res, null, 2));
  else {
    log(`[ci] detected stack: ${res.detection.summary}`);
    for (const f of res.written) log(`[ci] wrote ${f}`);
  }
  process.exit(0);
}

const objective = rest.join(" ").trim();
if (!objective && !opt.dryRun && !opt.statusPreview)
  die('An objective is required, e.g.: node .orca/flow.mjs "Build a login page"');

// --- Load config ---
const CONFIG_FILE = opt.config || "flow.config.json";
let cfg;
try { cfg = JSON.parse(readFileSync(join(HERE, CONFIG_FILE), "utf8")); }
catch (e) { die(`Could not read ${CONFIG_FILE}: ${e.message}`); }

if (opt.grillMe !== undefined) {
  const grill = (cfg.pipeline || []).find((s) => s && s.id === "grill");
  if (!grill) die(`--grill-me/--no-grill-me: ${CONFIG_FILE} has no step with id "grill".`);
  grill.enabled = opt.grillMe;
}

ART_DIR = cfg.artifactsDir || ".orca/artifacts";
outPath = (file) => `${ART_DIR}/${file}`;
const AUTO_RUN = cfg.autoRun ?? true;
const DEFAULT_TIMEOUT = cfg.defaults?.timeoutMs ?? 900000;
const READINESS_RETRIES = cfg.defaults?.readinessRetries ?? 3;
const READINESS_MIN_BYTES = cfg.defaults?.readinessMinBytes ?? 200;
const agentOf = (step) => opt.agentOverrides[step.id] || step.agent;
const modelOf = (step) => {
  const m = step.model !== undefined ? step.model : cfg.defaults?.model;
  const t = m == null ? "" : String(m).trim();
  return t && t !== "default" ? t : null;
};
const effectiveModel = (step) => {
  const m = modelOf(step);
  if (!m) return null;
  const a = agentOf(step);
  return (isKiroCmd(a) || MODEL_FLAG_RE.test(a)) ? null : m;
};
const timeoutOf = (step) => step.timeoutMs || DEFAULT_TIMEOUT;
const nudgeRetriesOf = (step) => step.nudgeRetries ?? cfg.defaults?.nudgeRetries ?? 0;
const nudgeTimeoutOf = (step) => step.nudgeTimeoutMs ?? cfg.defaults?.nudgeTimeoutMs ?? 120000;
const maxRetriesOf = (step) => step.maxRetries ?? cfg.maxRetries ?? 2;

// --- Early dedup lock + Orca/worktree resolution + startup chooser ---
const EARLY_RUN_KEY = `${wtStamp()}-${slugify(objective || CONFIG_FILE).slice(0, 24)}-${process.pid}`;
const LEDGER_HOME_CFG = opt.ledgerHome || cfg.defaults?.ledgerHome || null;
if (!opt.statusPreview && !opt.dryRun && opt.dedupKey) {
  let lockRes;
  try {
    lockRes = acquireRunLock({ dedupKey: opt.dedupKey, runKey: EARLY_RUN_KEY, repoDir: process.cwd(), objective, ledgerHome: LEDGER_HOME_CFG });
  } catch (e) { die(`[ledger] lock init failed: ${e.message}`); }
  if (!lockRes.acquired) {
    console.error(`[orca-flow] DUPLICATE RUN BLOCKED: dedup-key "${opt.dedupKey}" is already held by live PID ${lockRes.holder?.pid} (run=${lockRes.holder?.runKey}).`);
    process.exit(2);
  }
  LOCK_CTX = { dedupKey: opt.dedupKey, runKey: EARLY_RUN_KEY, repoDir: process.cwd(), ledgerHome: LEDGER_HOME_CFG };
  if (lockRes.reclaimedStale) warn(`[ledger] reclaimed stale lock for dedup-key "${opt.dedupKey}" (previous PID ${lockRes.holder?.reclaimedStaleFromPid} is no longer running).`);
  process.on("exit", () => { if (LOCK_CTX) { try { releaseRunLock(LOCK_CTX); } catch {} LOCK_CTX = null; } });
}

orcaClient = createOrcaClient({
  cfg, opt, objective, autoRun: AUTO_RUN, agentOf, modelOf,
  writeStatus: () => statusMgr?.writeStatus(),
  log, warn, die,
});

// Early temporary status helpers for startup chooser (before pipeline slicing)
const earlyStatus = createStatusManager({
  artDir: ART_DIR, objective, configFile: CONFIG_FILE, cfg, opt,
  allSteps: [], getSteps: () => [], enabledIds: new Set(), isParallel: new Set(), agentOf,
  getWt: orcaClient.getWt, getWtPin: orcaClient.getWtPin, getWtPath: orcaClient.getWtPath,
  getRunId: orcaClient.getRunId, outPath, notifyRun: () => {}, log, warn,
});

if (!opt.statusPreview) {
  orcaClient.resolveOrca();
  await orcaClient.ensureWorktree();
  orcaClient.resolveWorktree(opt.dryRun);
  orcaClient.resolveWorktreePath(opt.dryRun);
  HISTORY_ARCHIVE_DONE = await runEarlyChooser({
    opt, cfg, artDir: ART_DIR, getWtPath: orcaClient.getWtPath,
    archiveCurrentRun: earlyStatus.archiveCurrentRun, copyRunFiles: earlyStatus.copyRunFiles,
    listRuns: earlyStatus.listRuns, printRunList: earlyStatus.printRunList, log,
  });
}

// --- Pipeline normalization & strict fail-fast validation ---
allSteps = (cfg.pipeline || []).filter((s) => s && s.id);
const byId = Object.fromEntries(allSteps.map((s) => [s.id, s]));
let steps = allSteps.filter((s) => s.enabled !== false && (!opt.only || opt.only.includes(s.id)));
if (opt.from) {
  const idx = steps.findIndex((s) => s.id === opt.from);
  if (idx < 0) die(`--from "${opt.from}" is not among the enabled steps.`);
  steps = steps.slice(idx);
}
if (steps.length === 0) die("No steps to run (all skipped?).");
const enabledIds = new Set(steps.map((s) => s.id));

for (const s of steps) {
  if (!s.parallelWith) continue;
  const id = s.parallelWith, t = byId[id];
  if (!t) die(`step "${s.id}": parallelWith "${id}" is not a known step id.`);
  if (t.enabled === false) die(`step "${s.id}": parallelWith "${id}" is disabled in the config.`);
  if (!enabledIds.has(id)) { warn(`step "${s.id}": parallelWith "${id}" is not part of this run — running it sequentially.`); delete s.parallelWith; continue; }
  if (steps.indexOf(t) > steps.indexOf(s)) die(`step "${s.id}": parallelWith "${id}" must appear EARLIER in the pipeline array.`);
  if (t.parallelWith) die(`step "${s.id}": parallelWith chains are not allowed — "${id}" itself declares parallelWith.`);
  if (!AUTO_RUN && s.interactive) die(`step "${s.id}": interactive steps cannot join a parallel group in manual mode.`);
  const reads = new Set((s.reads || []).filter((rid) => byId[rid]));
  if (reads.has(id)) die(`step "${s.id}" reads "${id}" — dependent steps cannot run in parallel with what they read.`);
  for (const m of steps) if (m.parallelWith === id && m !== s && reads.has(m.id)) die(`step "${s.id}" reads "${m.id}" — dependent steps cannot run in parallel.`);
}

const groups = (() => {
  const membersOf = new Map();
  for (const s of steps) if (s.parallelWith) { if (!membersOf.has(s.parallelWith)) membersOf.set(s.parallelWith, []); membersOf.get(s.parallelWith).push(s); }
  const out = [];
  for (let i = 0; i < steps.length;) {
    const members = membersOf.get(steps[i].id);
    if (!members) { out.push([steps[i]]); i++; continue; }
    for (let k = 0; k < members.length; k++)
      if (steps.indexOf(members[k]) !== i + 1 + k)
        die(`parallel group of "${steps[i].id}" must be contiguous: keep every step with parallelWith:"${steps[i].id}" immediately after it in the pipeline.`);
    out.push([steps[i], ...members]);
    i += 1 + members.length;
  }
  return out;
})();
const isParallel = new Set();
for (const g of groups) if (g.length > 1) for (const m of g) isParallel.add(m.id);

{
  const groupIdx = new Map();
  groups.forEach((g, i) => g.forEach((m) => groupIdx.set(m.id, i)));
  for (const s of steps) for (const id of (s.reads || [])) {
    if (!byId[id]) continue;
    if (!byId[id].writes) die(`step "${s.id}" reads "${id}" which has no "writes" — nothing to read.`);
    if (enabledIds.has(id) && groupIdx.get(id) >= groupIdx.get(s.id)) die(`step "${s.id}" reads "${id}" which has not run yet — reorder the pipeline (reads must point at EARLIER steps).`);
  }
  const checkNudge = (o, where) => {
    if (o.nudgeRetries != null && (!Number.isInteger(o.nudgeRetries) || o.nudgeRetries < 0)) die(`${where} nudgeRetries must be a non-negative integer (got ${JSON.stringify(o.nudgeRetries)}).`);
    if (o.nudgeTimeoutMs != null && (!Number.isInteger(o.nudgeTimeoutMs) || o.nudgeTimeoutMs <= 0)) die(`${where} nudgeTimeoutMs must be a positive integer of milliseconds (got ${JSON.stringify(o.nudgeTimeoutMs)}).`);
  };
  checkNudge(cfg.defaults || {}, "defaults:");
  for (const s of steps) checkNudge(s, `step "${s.id}":`);
  if (cfg.maxRetries != null && (!Number.isInteger(cfg.maxRetries) || cfg.maxRetries < 0)) die(`config: maxRetries must be a non-negative integer (got ${JSON.stringify(cfg.maxRetries)}).`);
  for (const s of steps) if (s.maxRetries != null && (!Number.isInteger(s.maxRetries) || s.maxRetries < 0)) die(`step "${s.id}": maxRetries must be a non-negative integer (got ${JSON.stringify(s.maxRetries)}).`);
}

validateAgentConfig({ cfg, configDir: HERE, steps, die });
for (const s of allSteps) { validateVerifyConfig(s, die); validateIsolationConfig(s, die); }
const tb = cfg.defaults?.targetBranch;
if (tb != null && (typeof tb !== "string" || !tb.trim() || /\s/.test(tb))) die(`defaults: targetBranch must be a non-empty branch name with no whitespace (got ${JSON.stringify(tb)}).`);
const pb = cfg.defaults?.protectedBranches;
if (pb != null && (!Array.isArray(pb) || pb.some((x) => typeof x !== "string" || !x.trim()))) die(`defaults: protectedBranches must be an array of non-empty branch names.`);
const TARGET_BRANCH = cfg.defaults?.targetBranch || "dev";
const PROTECTED_BRANCHES = cfg.defaults?.protectedBranches || ["main", "master"];
if (PROTECTED_BRANCHES.includes(TARGET_BRANCH)) die(`defaults: targetBranch "${TARGET_BRANCH}" is listed in protectedBranches (${PROTECTED_BRANCHES.join(", ")}) — refusing to target a protected branch.`);
const TURN_START_WINDOW_MS = cfg.defaults?.turnStartWindowMs ?? 120000;
const TURN_START_ESCALATE_MS = cfg.defaults?.turnStartEscalateMs ?? 600000;
if (!Number.isInteger(TURN_START_WINDOW_MS) || TURN_START_WINDOW_MS <= 0) die(`defaults: turnStartWindowMs must be a positive integer (got ${JSON.stringify(TURN_START_WINDOW_MS)}).`);
if (!Number.isInteger(TURN_START_ESCALATE_MS) || TURN_START_ESCALATE_MS < TURN_START_WINDOW_MS) die(`defaults: turnStartEscalateMs must be an integer >= turnStartWindowMs (got ${JSON.stringify(TURN_START_ESCALATE_MS)}).`);
for (const s of allSteps) {
  const sw = s.turnStartWindowMs ?? TURN_START_WINDOW_MS, se = s.turnStartEscalateMs ?? TURN_START_ESCALATE_MS;
  if (!Number.isInteger(sw) || sw <= 0) die(`step "${s.id}": turnStartWindowMs must be a positive integer (got ${JSON.stringify(s.turnStartWindowMs)}).`);
  if (!Number.isInteger(se) || se < sw) die(`step "${s.id}": turnStartEscalateMs must be an integer >= turnStartWindowMs (got ${JSON.stringify(s.turnStartEscalateMs)}).`);
}
validateMergeDangerConfig(cfg.defaults?.mergeDanger, die);
const MERGE_DANGER_THRESHOLDS = cfg.defaults?.mergeDanger || null;

// --- Wire status, notifier, runner ---
notifier = createNotifier({
  here: HERE, objective, outPath,
  statusOf: (id) => statusMgr.statusOf(id),
  statusDir: () => statusMgr.statusDir(),
  getStatus: () => statusMgr.STATUS,
  getRunId: orcaClient.getRunId,
  getGroups: () => groups,
  warn,
});

statusMgr = createStatusManager({
  artDir: ART_DIR, objective, configFile: CONFIG_FILE, cfg, opt,
  allSteps, getSteps: () => steps, enabledIds, isParallel, agentOf,
  getWt: orcaClient.getWt, getWtPin: orcaClient.getWtPin, getWtPath: orcaClient.getWtPath,
  getRunId: orcaClient.getRunId, outPath, notifyRun: notifier.notifyRun, log, warn,
});

if (opt.statusPreview && (objective || opt.only || opt.from || Object.keys(opt.agentOverrides).length))
  die("--status-preview renders a SAMPLE status page and exits WITHOUT calling agents, but this command looks like a real run (objective/--only/--from/--agent present). Remove --status-preview to run the pipeline for real — the status page opens automatically — or drop the objective and selectors to see the sample page.");
if (opt.statusPreview) statusMgr.runPreviewAndExit(HERE);

let WT_DIR = null;
const ISSUE_CFG = resolveIssueTrackingConfig(cfg, opt);
let ISSUE_PROVIDER = null;
let ISSUE_STATE = null;
const runner = createRunner({
  here: HERE, cfg, opt, objective, configFile: CONFIG_FILE, artDir: ART_DIR, autoRun: AUTO_RUN,
  targetBranch: TARGET_BRANCH, protectedBranches: PROTECTED_BRANCHES, mergeDangerThresholds: MERGE_DANGER_THRESHOLDS,
  turnStartWindowMs: TURN_START_WINDOW_MS, turnStartEscalateMs: TURN_START_ESCALATE_MS,
  readinessRetries: READINESS_RETRIES, readinessMinBytes: READINESS_MIN_BYTES,
  allSteps, steps, byId, enabledIds, groups, isParallel,
  agentOf, modelOf, effectiveModel, timeoutOf, nudgeRetriesOf, nudgeTimeoutOf, outPath,
  orcaClient, statusMgr, notifier, getLedger: () => LEDGER, getWtDir: () => WT_DIR,
  getIssueState: () => ISSUE_STATE, issueTrackingCfg: ISSUE_CFG,
  isolatedState, preStepTargetRefs: PRE_STEP_TARGET_REFS,
  setLastMergeDanger: (cls) => { LAST_MERGE_DANGER = cls; },
  log, warn, die,
});

notifier.load();
runner.printPlan();
if (opt.dryRun) { log("Dry-run — no agents called."); process.exit(0); }

// --- Execute pipeline ---
orcaClient.resolveWorktree();
WT_DIR = orcaClient.resolveWorktreePath();
if (!WT_DIR) die(`Could not resolve the path of worktree ${orcaClient.getWt()} (orca worktree show failed). Fix/remove it, then re-run.`);

const cleanupOnSignal = (sig) => {
  if (LEDGER) { try { LEDGER.reconcileCloseout({ wtDir: WT_DIR || ".", artDirRel: ART_DIR, overall: "interrupted", mergeDanger: LAST_MERGE_DANGER }); } catch {} }
  if (LOCK_CTX) { try { releaseRunLock(LOCK_CTX); } catch {} LOCK_CTX = null; }
  process.exit(sig === "SIGINT" ? 130 : 143);
};
process.on("SIGINT", () => cleanupOnSignal("SIGINT"));
process.on("SIGTERM", () => cleanupOnSignal("SIGTERM"));
process.on("exit", () => { if (LOCK_CTX) { try { releaseRunLock(LOCK_CTX); } catch {} LOCK_CTX = null; } });

const initialProtectedShas = snapshotBranchShas(WT_DIR || ".", PROTECTED_BRANCHES);
try {
  LEDGER = createRunLedger({
    runKey: EARLY_RUN_KEY, repoDir: WT_DIR || ".", ledgerHome: LEDGER_HOME_CFG,
    objective, configFile: CONFIG_FILE, targetBranch: TARGET_BRANCH, protectedBranches: PROTECTED_BRANCHES,
    dedupKey: opt.dedupKey, initialProtectedShas, warn,
  });
  log(`[ledger] out-of-repo run ledger: ${LEDGER.summaryPath}`);
} catch (e) { die(`[ledger] failed to initialize out-of-repo ledger: ${e.message}`); }

mkdirSync(join(WT_DIR || ".", ART_DIR), { recursive: true });
if (!HISTORY_ARCHIVE_DONE) statusMgr.archiveCurrentRun();
if (restoreAgentConfig({ worktree: WT_DIR || ".", warn })) log("[agent-config] restored worktree files left behind by a previous run.");
for (const isoDir of knownIsolatedWorktreePaths(join(WT_DIR || ".", ART_DIR))) {
  if (restoreAgentConfig({ worktree: isoDir, warn })) log(`[agent-config] restored isolated worktree files left behind in ${isoDir}.`);
}
if (!orcaClient.orca(["status"]).ok) die("Orca runtime not ready (orca status failed).");

log(`Creating Run: ${objective}`);
const runResp = orcaClient.orca(["orchestration", "run-create", "--objective", objective]);
if (!runResp.ok) die(`run-create failed: ${runResp.stderr || runResp.raw}`);
const runId = pick(res(runResp.json).run || {}, ["id"]) || pick(res(runResp.json), ["runId", "run_id"]);
if (!runId) die(`Could not read Run ID from run-create. Output: ${runResp.raw}`);
orcaClient.setRunId(runId);
log(`Run: ${runId}`);
LEDGER.setOrcaRunId(runId);
statusMgr.initStatus();

// Initialize GitHub/Gitea Issue traceability (auto-enabled when gh/tea & remote available)
const artDirAbs = join(WT_DIR || ".", ART_DIR);
ISSUE_STATE = loadIssueState(artDirAbs);
ISSUE_PROVIDER = detectIssueProvider({
  repoDir: WT_DIR || ".",
  mode: ISSUE_CFG.mode,
  providerOverride: ISSUE_CFG.provider,
});
if (ISSUE_PROVIDER.enabled) {
  log(`[issues] enabled (provider=${ISSUE_PROVIDER.provider}${ISSUE_PROVIDER.repo ? `, repo=${ISSUE_PROVIDER.repo}` : ""}${ISSUE_CFG.epicIssue ? `, epic=#${ISSUE_CFG.epicIssue}` : ""})`);
  if (ISSUE_CFG.epicIssue && !ISSUE_STATE?.epic) {
    ISSUE_STATE = syncPlanIssues({
      providerInfo: ISSUE_PROVIDER, config: ISSUE_CFG, repoDir: WT_DIR || ".", artDirAbs,
      objective, stepId: "init", artifactPath: null, log, warn,
    });
    if (ISSUE_STATE) LEDGER?.recordIssueLinks(ISSUE_STATE);
  }
} else if (ISSUE_CFG.mode === true) {
  warn(`[issues] issueTracking enabled in config/flags but provider unavailable: ${ISSUE_PROVIDER.reason}`);
}

const PLANNING_STEP_IDS = new Set(ISSUE_CFG.planningSteps || ["po-backlog", "micro-plan", "triage-root-cause"]);
const retriesUsed = {};
let gi = 0;
while (gi < groups.length) {
  await runner.readinessGate(groups[gi]);
  const results = await runner.runGroup(groups[gi]);
  let jumped = false;
  for (const r of results) {
    let vres = null;
    if (r.outcome === "succeeded" && r.step.verify) {
      const checkDir = r.ctx?.isolated ? r.ctx.dir : (WT_DIR || ".");
      vres = verifyStepArtifact(r.step, join(WT_DIR || ".", ART_DIR), checkDir, READINESS_MIN_BYTES, {
        mode: "settlement", targetBranch: TARGET_BRANCH, allowOneWayMerge: opt.allowOneWayMerge,
        preStepTargetSha: r.preStepTargetSha, preStepOriginTargetSha: r.preStepOriginTargetSha,
        preStepRemoteTargetSha: r.preStepRemoteTargetSha, preStepRemoteError: r.preStepRemoteError,
        preStepHasOrigin: r.preStepHasOrigin, preStepHeadSha: r.preStepHeadSha,
        mergeDangerThresholds: MERGE_DANGER_THRESHOLDS,
      });
      if (vres.mergeDanger) LAST_MERGE_DANGER = vres.mergeDanger;
      if (!vres.ok) {
        warn(`[gate-verify] "${r.step.title}" failed hard gate verification: ${vres.reason} — overriding outcome to failed.`);
        r.outcome = "failed";
        r.note = r.note ? `${r.note}; gate verify failed: ${vres.reason}` : `gate verify failed: ${vres.reason}`;
        statusMgr.statusSet(r.step.id, { status: "failed", note: r.note });
      } else {
        if (r.step.verify.requireContractCommit && vres.contractCommit) recordVerifiedContractCommit(join(WT_DIR || ".", ART_DIR), vres.contractCommit, WT_DIR || ".");
        if (r.step.verify.requireMergedTasks) recordMergedAfterContract(join(WT_DIR || ".", ART_DIR), WT_DIR || ".");
        if (vres.pendingHumanMerge) {
          PENDING_HUMAN_MERGE = true;
          statusMgr.statusSet(r.step.id, { note: `ONE-WAY DOOR: PR held open for human merge (${(vres.mergeDanger?.triggers || []).join(", ")})` });
          LEDGER?.recordPendingHumanMerge({ targetBranch: TARGET_BRANCH, door: "one-way", triggers: vres.mergeDanger?.triggers || [], artifact: outPath(r.step.writes), headSha: headSha() });
        }
      }
    }
    if (r.step.verify?.mergeDangerCheck && !opt.allowOneWayMerge) {
      let mdCheck = vres?.mergeDangerResult || null;
      if (!mdCheck) {
        const checkDir = r.ctx?.isolated ? r.ctx.dir : (WT_DIR || ".");
        const artPath = join(WT_DIR || ".", ART_DIR, r.step.writes || "");
        const artText = (r.step.writes && existsSync(artPath)) ? readFileSync(artPath, "utf8") : "";
        mdCheck = verifyMergeDangerGate({
          text: artText, gitDir: checkDir, targetBranch: TARGET_BRANCH, allowOneWayMerge: false,
          preStepTargetSha: r.preStepTargetSha, preStepOriginTargetSha: r.preStepOriginTargetSha,
          preStepRemoteTargetSha: r.preStepRemoteTargetSha, preStepRemoteError: r.preStepRemoteError,
          preStepHasOrigin: r.preStepHasOrigin, preStepHeadSha: r.preStepHeadSha,
          thresholds: MERGE_DANGER_THRESHOLDS,
        });
        if (mdCheck.classification) LAST_MERGE_DANGER = mdCheck.classification;
      }
      if (!mdCheck.ok && mdCheck.door === "one-way" && mdCheck.targetRefMoved) {
        const msg = `[merge-danger] CRITICAL VIOLATION on step "${r.step.title}": ${mdCheck.reason}`;
        warn(msg);
        r.outcome = "failed";
        r.note = r.note ? `${r.note}; ${mdCheck.reason}` : mdCheck.reason;
        statusMgr.statusSet(r.step.id, { status: "failed", note: r.note });
        LEDGER?.recordStepSettled({ stepId: r.step.id, outcome: "failed", note: r.note, verifyOk: false, verifyReason: mdCheck.reason, contractCommit: vres?.contractCommit || null });
        die(msg);
      }
    }
    if (LEDGER) {
      LEDGER.recordStepSettled({ stepId: r.step.id, outcome: r.outcome, note: r.note || null, verifyOk: vres ? vres.ok : null, verifyReason: vres ? vres.reason : null, contractCommit: vres?.contractCommit || null });
      if (r.outcome === "succeeded") {
        LEDGER.updateIntegrationHead(WT_DIR || ".");
        const isImplStep = Boolean(r.ctx?.isolated || /(?:worker|coding|impl|fix|integration)/i.test(r.step.id));
        if (isImplStep && r.step.writes) {
          const ev = r.ctx?.isolated ? `worktree:${r.ctx.wtName}@${r.ctx.branch}#${outPath(r.step.writes)}` : `artifact:${outPath(r.step.writes)}@HEAD=${headSha() || "uncommitted"}`;
          LEDGER.recordAcceptanceLevel("implemented", { status: true, evidenceRef: ev, detail: `step ${r.step.id} succeeded` });
        }
        if (r.step.verify?.requireMergedTasks) {
          const curHead = headSha();
          if (curHead) LEDGER.recordAcceptanceLevel("integrated", { status: true, evidenceRef: `gate:requireMergedTasks@HEAD=${curHead}`, detail: `step ${r.step.id} merged & verified isolated task branches` });
        }
      }
    }
    if (r.outcome === "succeeded") {
      log(`[ok] ${r.step.title} done -> ${outPath(r.step.writes)}`);
      if (ISSUE_PROVIDER?.enabled && (r.step.syncIssues || PLANNING_STEP_IDS.has(r.step.id))) {
        try {
          const planArt = r.step.writes ? join(WT_DIR || ".", ART_DIR, r.step.writes) : null;
          ISSUE_STATE = syncPlanIssues({
            providerInfo: ISSUE_PROVIDER, config: ISSUE_CFG, repoDir: WT_DIR || ".", artDirAbs,
            objective, stepId: r.step.id, artifactPath: planArt, log, warn,
          });
          if (ISSUE_STATE) LEDGER?.recordIssueLinks(ISSUE_STATE);
        } catch (e) {
          warn(`[issues] sync after "${r.step.id}" failed (continuing): ${e.message}`);
        }
      }
      if (r.step.gate && !AUTO_RUN) runner.runGate(r.step);
      continue;
    }
    if (r.outcome === "still-running") {
      statusMgr.STATUS.overall = "still-running";
      statusMgr.writeStatus();
      const next = (groups[gi + 1] || [])[0] || null;
      die(`"${r.step.title}" ${r.note}. Its terminal ${r.terminal || "(dispatch-owned)"} was left OPEN to finish. Watch it; once it reports done and writes ${outPath(r.step.writes)}, continue with:\n  node .orca/flow.mjs --from ${next ? next.id : r.step.id} "<objective>"`);
    }
    if (r.outcome !== "failed")
      die(`"${r.step.title}" returned outcome=${r.outcome}${r.note ? ` (${r.note})` : ""}. Not retrying without a definite failure — inspect the terminal/artifacts, then re-run with --from ${r.step.id}.`);

    const gotoId = r.step.onFailGoto;
    if (gotoId && enabledIds.has(gotoId)) {
      const budget = maxRetriesOf(r.step);
      const key = `${r.step.id}->${gotoId}`;
      retriesUsed[key] = (retriesUsed[key] || 0) + 1;
      if (retriesUsed[key] > budget) die(`"${r.step.title}" failed and exhausted ${budget} retries. See ${outPath(r.step.writes)}.`);
      log(`[fail] ${r.step.title} FAILED${r.note ? ` (${r.note})` : ""} -> back to "${byId[gotoId].title}" (attempt ${retriesUsed[key]}/${budget})`);
      orcaClient.orca(["orchestration", "task-update", "--id", runner.taskIds[gotoId], "--status", "ready", "--result", JSON.stringify({ reason: `fix from ${r.step.id} #${retriesUsed[key]}`, see: outPath(r.step.writes) })]);
      gi = groups.findIndex((g) => g.some((m) => m.id === gotoId));
      jumped = true;
      break;
    }
    die(`"${r.step.title}" returned outcome=${r.outcome}${r.note ? ` (${r.note})` : ""} and has no valid onFailGoto. Stopping.`);
  }
  if (!jumped) gi++;
}

const finalStatus = PENDING_HUMAN_MERGE ? "pending-human-merge" : "succeeded";
let closeout = null;
if (LEDGER) {
  try { closeout = LEDGER.reconcileCloseout({ wtDir: WT_DIR || ".", artDirRel: ART_DIR, overall: finalStatus, mergeDanger: LAST_MERGE_DANGER }); }
  catch (e) { die(`[ledger] closeout failed (refusing fail-open completion): ${e.message}`); }
}
if (closeout?.protectedViolations?.length) {
  die(`[closeout] PROTECTED BRANCH VIOLATION: ${closeout.protectedViolations.map((v) => `${v.branch} (${(v.before ?? "∅").slice(0, 8)} -> ${(v.after ?? "∅").slice(0, 8)})`).join(", ")}`);
}
statusMgr.finishStatus(finalStatus);
log(PENDING_HUMAN_MERGE ? `Pipeline HELD (PENDING HUMAN MERGE — One-Way Door). Artifacts in ${ART_DIR}:` : `Pipeline COMPLETE. Artifacts in ${ART_DIR}:`);
for (const s of steps) log(`  ${s.title.padEnd(26)} -> ${s.writes}`);
if (closeout) {
  const acc = closeout.acceptance;
  log(`[acceptance] implemented=${acc.implemented.status} integrated=${acc.integrated.status} merged=${acc.merged.status} synced=${acc.synced.status}`);
  log(`[closeout] ledger=${LEDGER.summaryPath} protectedUntouched=${closeout.protectedViolations.length === 0}`);
  if (closeout.pendingHumanMerge) {
    log(`[one-way-door] PR held open for human review & merge into "${TARGET_BRANCH}". After merging manually, reconcile closeout with:`);
    log(`  node .orca/ledger.mjs closeout --run ${LEDGER.runKey} --repo "${WT_DIR || "."}" --target-branch ${TARGET_BRANCH}`);
  }
}
if (orcaClient.getCreatedWorktree())
  log(`[worktree] created by this run: name:${orcaClient.getCreatedWorktree()} — remove later with: orca worktree rm name:${orcaClient.getCreatedWorktree()}`);
try {
  reportUsage({
    STATUS: statusMgr.STATUS, wt: orcaClient.getWt(), wtPath: orcaClient.getWtPath(),
    allSteps, outPath, statusDir: statusMgr.statusDir, writeStatusTo, log, warn,
  });
} catch (e) { warn(`[usage] report skipped (${e.message})`); }
