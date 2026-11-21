// Orca CLI wrapper, worktree resolution/auto-create, worker warm/cold start,
// strict dispatch fencing & release verification, deadline-clamped RPCs, and per-dispatch vitals.
// Zero external dependencies (Node >= 18).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import readline from "node:readline";
import { WATCHDOG_PARKED_PROMPTS, detectGatewayDisconnect, detectPromptBlocked } from "../watchdog.mjs";
import { appendFlagsBeforeTerminator, isSafeSingleTokenValue, parseAgentCommandSpec, resolveEffectiveLaunchSpec, stripUnquotedShellComment } from "../preflight.mjs";
import { sanitizeText } from "./sanitize.mjs";

export const IS_WIN = process.platform === "win32";
export const MODEL_FLAG_RE = /(^|\s)(--model|-m)(\s|=|$)/;
export const EFFORT_FLAG_RE = /(^|\s)--effort(\s|=|$)/;
export const isKiroCmd = (a) => a === "kiro-cli" || a.startsWith("kiro-cli ");
export const isAgyCmd = (a) => /^(?:agy|antigravity)(?:\s|$)/.test(String(a || "").trim());

const CONFIRMED_STOP_STATES = new Set(["stopped", "terminated", "exited", "already_stopped", "completed", "not_found"]);
const CONFIRMED_MANUAL_FENCE_STATES = new Set(["fenced", ...CONFIRMED_STOP_STATES]);
const REJECTED_PROC_ACTIONS = new Set(["stop_unknown", "none", "failed", "kept_open", "retained"]);
const CONFIRMED_RELEASE_STATES = new Set(["released", "already_released", "closed", "not_found"]);
const CONFIRMED_MANUAL_RELEASE_STATES = new Set(["retained", ...CONFIRMED_RELEASE_STATES]);
// P0-01: Only strictly provable pre-launch validation error codes may be treated as non-ambiguous
// when `worker-start` fails with NO `dispatchId` and `dispatch-show` finds no dispatch!
const STRICT_PRE_LAUNCH_REJECTION_CODES = new Set([
  "invalid_argument",
  "invalid_args",
  "arg_validation",
  "unknown_agent",
  "agent_not_found",
  "worktree_not_found",
  "task_not_found",
  "permission_denied",
  "workspace_trust",
]);

export function normalizeOrcaWorkerAgent(agentCmd) {
  const parsed = parseAgentCommandSpec(agentCmd);
  const base = parsed.parseable ? parsed.baseAgent : String(agentCmd || "").trim().split(/\s+/)[0];
  if (base === "agy") return "antigravity";
  if (base === "kiro-cli") return "kiro";
  if (base === "cursor-agent") return "cursor";
  return base || String(agentCmd || "").trim();
}

/**
 * Read-only check of `~/.gemini/antigravity-cli/settings.json` to see if `worktreePath`
 * (or an ancestor directory) is already listed in `trustedWorkspaces`.
 * Never writes to or mutates global settings.
 */
export function isAgyWorkspaceTrusted(worktreePath, { homeDir = homedir() } = {}) {
  if (!worktreePath) return false;
  const settingsPath = join(homeDir, ".gemini", "antigravity-cli", "settings.json");
  if (!existsSync(settingsPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    const list = Array.isArray(parsed?.trustedWorkspaces) ? parsed?.trustedWorkspaces : [];
    const target = resolve(worktreePath);
    return list.some((entry) => {
      if (typeof entry !== "string" || !entry.trim()) return false;
      const trusted = resolve(entry.trim());
      return target === trusted || target.startsWith(trusted + sep);
    });
  } catch {
    return false;
  }
}

export function buildAgySettingsArg(trustedDirs, { isWin = IS_WIN, settingsDir = null } = {}) {
  const dirs = [...new Set((Array.isArray(trustedDirs) ? trustedDirs : [trustedDirs]).map((d) => String(d || "").trim()).filter(Boolean))];
  if (!dirs.length) return "";
  const json = JSON.stringify({ trustedWorkspaces: dirs });
  if (isWin) {
    const baseDir = settingsDir || join(tmpdir(), "orca-pod-agy-settings");
    mkdirSync(baseDir, { recursive: true });
    const digest = createHash("sha256").update(json).digest("hex").slice(0, 12);
    const settingsFile = join(baseDir, `agy-trust-${process.pid}-${digest}.json`);
    writeFileSync(settingsFile, json + "\n", "utf8");
    return `--settings "${settingsFile}"`;
  }
  return `--settings '${json.replace(/'/g, "'\\''")}'`;
}

export function buildAgentCommand(agent, model = null, { autoRun = true, effort = null, worktreePath = null, extraTrustedDirs = [], settingsDir = null, warn = () => {}, isWin = IS_WIN } = {}) {
  let cmd = stripUnquotedShellComment(String(agent || "").trim());
  const parsed = parseAgentCommandSpec(cmd);
  if (!parsed.parseable) {
    // Fail closed on unparseable shell expressions/expansions: NEVER inject `--model` or `--effort`!
    return cmd;
  }
  const baseLower = parsed.lowerBase;
  const isKiro = parsed.isKiro;
  const isAgy = baseLower === "agy" || baseLower === "antigravity";
  const hasModel = parsed.hasModelFlag;
  const hasEffort = parsed.hasEffortFlag;
  const rawModel = (model != null && String(model).trim() && String(model).trim().toLowerCase() !== "default")
    ? String(model).trim()
    : null;
  const normModel = rawModel && isSafeSingleTokenValue(rawModel) ? rawModel : null;
  if (rawModel && !normModel) {
    warn(`step model "${sanitizeText(rawModel, { maxLen: 80 })}" rejected: must be a single safe CLI token without spaces or globs.`);
  }
  const rawEffort = (effort != null && String(effort).trim()) ? String(effort).trim() : null;
  const normEffort = rawEffort && isSafeSingleTokenValue(rawEffort) ? rawEffort : null;
  if (rawEffort && !normEffort) {
    warn(`step effort "${sanitizeText(rawEffort, { maxLen: 80 })}" rejected: must be a single safe CLI token without spaces or globs.`);
  }

  const extraFlags = [];
  if (normModel && !hasModel && !isKiro) extraFlags.push(`--model ${normModel}`);
  else if (normModel && isKiro && !hasModel) warn(`step model "${normModel}" ignored: kiro-cli has no model selection.`);

  if (isAgy) {
    if (normEffort && !hasEffort) extraFlags.push(`--effort ${normEffort}`);
    if (autoRun && !parsed.hasDangerouslySkipFlag && !parsed.hasModeFlag) {
      extraFlags.push("--dangerously-skip-permissions");
    }
    const trustDirs = [worktreePath, ...(extraTrustedDirs || [])].filter(Boolean);
    if (trustDirs.length && !parsed.hasSettingsFlag) {
      const settingsArg = buildAgySettingsArg(trustDirs, { isWin, settingsDir });
      if (settingsArg) extraFlags.push(settingsArg);
    }
    return appendFlagsBeforeTerminator(cmd, extraFlags, parsed);
  }

  const isClaude = baseLower === "claude";
  if (!isClaude) return appendFlagsBeforeTerminator(cmd, extraFlags, parsed);
  if (autoRun && !parsed.hasPermissionModeFlag && !parsed.hasDangerouslySkipFlag)
    extraFlags.push("--permission-mode bypassPermissions");
  cmd = appendFlagsBeforeTerminator(cmd, extraFlags, parsed);
  if (!autoRun) return cmd;
  return isWin ? `cmd /c "set CLAUDE_AFK_TIMEOUT_MS=60000&& ${cmd}"` : `env CLAUDE_AFK_TIMEOUT_MS=60000 ${cmd}`;
}

export const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; };
export const res = (j) => (j && j.result) ? j.result : (j || {});

export function sleepMs(ms) {
  if (!(ms > 0)) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, Math.max(1, Math.floor(ms)));
}

function clampTimeoutToDeadline(deadlineAt, fallbackMs = undefined) {
  if (deadlineAt == null || !Number.isFinite(deadlineAt)) return fallbackMs;
  const rem = deadlineAt - Date.now();
  if (rem <= 0) return 0;
  const raw = fallbackMs != null ? Math.min(fallbackMs, rem) : rem;
  return Math.max(1, Math.floor(raw));
}

export function wtStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function slugify(text) {
  return String(text || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC")
    .toLowerCase().replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/g, "") || "run";
}

export function gitRoot() {
  const g = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return !g.error && g.status === 0 ? (g.stdout || "").trim() : null;
}

export function headSha() {
  const g = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  return !g.error && g.status === 0 ? (g.stdout || "").trim() : null;
}

export function promptChoice(question) {
  return new Promise((resolveAns) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { rl.close(); } catch {} resolveAns(v); };
    rl.on("close", () => done(""));
    rl.question(question, (a) => done(String(a ?? "")));
  });
}

export const parkedPromptOf = (preview) =>
  typeof preview === "string" ? WATCHDOG_PARKED_PROMPTS.find((p) => preview.includes(p.sig)) || null : null;

export function outcomeOf(done) {
  if (!done) return null;
  let o = pick(done, ["outcome", "result"]);
  if (!o && done.payload != null) {
    let p = done.payload;
    if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
    o = pick(p || {}, ["outcome", "result"]);
  }
  return o || null;
}

const CLEANUP_RPC_TIMEOUT_MS = 3000;
const CONFIRMED_TERMINAL_CLOSE_STATES = new Set(["closed", "already_closed", "exited", "terminated", "stopped", "gone", "not_found", "removed"]);

function collectHandleValuesFromObject(obj, setOut) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const k of ["handle", "terminalHandle", "terminal_handle", "id", "terminalId", "terminal_id"]) {
    if (typeof obj[k] === "string" && obj[k].trim()) setOut.add(obj[k].trim());
  }
  if (typeof obj.terminal === "string" && obj.terminal.trim()) {
    setOut.add(obj.terminal.trim());
  } else if (obj.terminal && typeof obj.terminal === "object" && !Array.isArray(obj.terminal)) {
    for (const k of ["handle", "terminalHandle", "terminal_handle", "id", "terminalId", "terminal_id"]) {
      if (typeof obj.terminal[k] === "string" && obj.terminal[k].trim()) setOut.add(obj.terminal[k].trim());
    }
  }
}

function extractAllReceiptTerminalHandles(rawJson) {
  const handles = new Set();
  if (!rawJson || typeof rawJson !== "object") return [];
  collectHandleValuesFromObject(rawJson, handles);
  if (rawJson.result && typeof rawJson.result === "object") {
    collectHandleValuesFromObject(rawJson.result, handles);
  }
  return [...handles];
}

function extractReceiptTerminalHandle(obj) {
  const all = extractAllReceiptTerminalHandles(obj);
  return all[0] || null;
}

const RUNTIME_NETWORK_CONFLICT_RE = /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN|socket hang up|fetch failed|connection refused|connection reset|broken pipe|timed?\s*out)\b/i;

/**
 * P0-01: Positively close a caller-created manual terminal AND confirm via `terminal show`
 * that the exact `termHandle` session is closed/gone.
 *   - NEVER accepts empty `{}` receipts on `terminal close` or `terminal show`!
 *   - Inspects ALL top-level and nested handle fields so a matching top-level handle NEVER masks a conflicting nested handle!
 *   - Rejects generic gateway errors like `endpoint not found` (only accepts explicit terminal-resource absence)!
 */
export function verifyManualTerminalClosed(orcaFn, termHandle) {
  if (!termHandle || !String(termHandle).trim()) {
    return { ok: false, reason: "missing manual terminal handle for close verification" };
  }
  const target = String(termHandle).trim();
  const cl = orcaFn(["terminal", "close", "--terminal", target], { allowPostDeadlineCleanup: true, timeoutMs: CLEANUP_RPC_TIMEOUT_MS });
  const clJson = res(cl.json);
  const clHandles = extractAllReceiptTerminalHandles(cl.json);
  const badClHandle = clHandles.find((h) => h !== target);
  if (badClHandle) {
    return {
      ok: false,
      reason: `terminal close handle mismatch (got "${badClHandle}", expected "${target}")`,
    };
  }
  const clHandle = clHandles.includes(target) ? target : null;
  const clAction = String(pick(clJson, ["status", "action", "state"]) || "").trim().toLowerCase();
  const closeReceiptPositive = Boolean(
    cl.ok &&
    cl.json &&
    (clJson?.closed === true || CONFIRMED_TERMINAL_CLOSE_STATES.has(clAction))
  );
  if (!closeReceiptPositive) {
    return {
      ok: false,
      reason: `terminal close (${target}) lacked positive close confirmation (status=${clAction || "empty"}: ${sanitizeText(cl.stderr || cl.raw || "unconfirmed", { maxLen: 200 })})`,
    };
  }

  const checkRes = orcaFn(["terminal", "show", "--terminal", target], { allowPostDeadlineCleanup: true, timeoutMs: CLEANUP_RPC_TIMEOUT_MS });
  if (checkRes.timedOut) {
    return { ok: false, reason: `terminal show (${target}) timed out while verifying manual terminal closure` };
  }
  const showHandles = extractAllReceiptTerminalHandles(checkRes.json);
  const badShowHandle = showHandles.find((h) => h !== target);
  if (badShowHandle) {
    return {
      ok: false,
      reason: `terminal show handle mismatch (got "${badShowHandle}", expected "${target}")`,
    };
  }
  if (!checkRes.ok) {
    const errJson = res(checkRes.json);
    const errCode = String(
      pick(errJson, ["code", "errorCode", "error_code"]) ||
      pick(checkRes.json || {}, ["code", "errorCode", "error_code"]) ||
      ""
    ).trim().toLowerCase();
    const parsedErrMsg = pick(errJson, ["error", "message", "lastError"]) || checkRes.json?.error || checkRes.json?.message || "";
    const errTxt = [
      checkRes.stderr || "",
      typeof parsedErrMsg === "string" ? parsedErrMsg : "",
      !checkRes.json ? (checkRes.raw || "") : "",
    ].join(" ");
    // Extract ANY terminal identifier tokens mentioned in the error text so `Terminal term-other not found`
    // NEVER passes verification when closing `term-a`!
    const mentionedTermIds = new Set();
    const NOT_ID_WORDS = new Set(["not", "found", "does", "exist", "is", "closed", "already", "gone", "unknown", "invalid", "such", "error", "handle", "id", "session", "for", "the", "a", "an"]);
    const addIdCandidate = (tok) => {
      const cleaned = String(tok || "").replace(/^["'`(\[{]+|["'`)\]},.:;!?]+$/g, "").trim();
      if (cleaned && !NOT_ID_WORDS.has(cleaned.toLowerCase())) mentionedTermIds.add(cleaned);
    };
    for (const m of errTxt.matchAll(/\b(?:unknown|invalid|no[\s_-]+such)[\s_-]+terminal(?:\s+(?:handle|id|session))?\s+([^\s,;:]+)/gi)) {
      addIdCandidate(m[1]);
    }
    for (const m of errTxt.matchAll(/\bterminal(?:\s+(?:handle|id|session))?\s+([^\s,;:]+)\s+(?:not[\s_-]*found|does not exist|is closed|already closed|gone)\b/gi)) {
      addIdCandidate(m[1]);
    }
    for (const m of errTxt.matchAll(/\b((?:term|structworker)[-_][A-Za-z0-9._:-]+)\b/gi)) {
      addIdCandidate(m[1]);
    }
    const wrongTextId = [...mentionedTermIds].find((id) => id !== target);
    if (wrongTextId) {
      return {
        ok: false,
        reason: `terminal show error referenced different terminal "${wrongTextId}" (expected "${target}")`,
      };
    }
    const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const errMentionsTarget = mentionedTermIds.has(target) || new RegExp(`(?:^|[^A-Za-z0-9._-])${escapedTarget}(?:$|[^A-Za-z0-9._-])`).test(errTxt);
    // Reject generic gateway errors like `endpoint not found` or `route not found` or `method not found`!
    const isGenericGatewayNotFound = /\b(?:endpoint|route|url|path|method|command|service|server|daemon|gateway|rpc)\s+not[\s_-]*found\b/i.test(errTxt);
    const explicitTerminalGone = !isGenericGatewayNotFound && (showHandles.includes(target) || errMentionsTarget) && (
      /^(?:terminal_not_found|unknown_terminal|no_such_terminal|terminal_closed|terminal_gone)$/.test(errCode) ||
      /\b(?:terminal(?:\s+handle|\s+id|\s+session)?(?:\s+["'`]?[A-Za-z0-9._:-]+["'`]?)?\s+(?:not[\s_-]*found|does not exist|is closed|already closed|gone)|unknown[\s_-]*terminal|no[\s_-]*such[\s_-]*terminal|invalid[\s_-]*terminal)\b/i.test(errTxt)
    );
    if (explicitTerminalGone) {
      return { ok: true, reason: null };
    }
    return {
      ok: false,
      reason: `terminal show (${target}) failed without target-attributed terminal-not-found confirmation: ${sanitizeText(errTxt || "unknown error", { maxLen: 180 })}`,
    };
  }

  const checkJson = res(checkRes.json);
  const termObj = pick(checkJson, ["terminal"]);
  if (!termObj || typeof termObj !== "object" || Array.isArray(termObj)) {
    return { ok: false, reason: `terminal show (${target}) returned empty/missing terminal record instead of explicit closed/not_found confirmation` };
  }
  const shownHandle = showHandles.includes(target) ? target : null;
  const tState = String(pick(termObj, ["status", "state"]) || "").trim().toLowerCase();
  if ((termObj.closed === true || CONFIRMED_TERMINAL_CLOSE_STATES.has(tState)) && (shownHandle === target || clHandle === target)) {
    return { ok: true, reason: null };
  }
  if (termObj.closed === true || CONFIRMED_TERMINAL_CLOSE_STATES.has(tState)) {
    return {
      ok: false,
      reason: `terminal close/show for "${target}" lacked explicit handle attribution in receipt`,
    };
  }
  return {
    ok: false,
    reason: `terminal (${target}) still appears live or unconfirmed after terminal close (state=${tState || "empty"})`,
  };
}

export function collectReceiptDispatchIds(rawJson, resJson = null) {
  const rj = resJson || res(rawJson);
  const raw = [
    rj?.dispatchId, rj?.dispatch_id, rj?.id,
    rj?.dispatch?.id, rj?.dispatch?.dispatchId, rj?.dispatch?.dispatch_id,
    rawJson?.dispatchId, rawJson?.dispatch_id,
    rawJson?.dispatch?.id, rawJson?.dispatch?.dispatchId, rawJson?.dispatch?.dispatch_id,
  ]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => v.trim());
  return [...new Set(raw)];
}

export function collectAllStopStates(rawJson, resJson = null) {
  const rj = resJson || res(rawJson);
  const rawStates = [
    rj?.state, rj?.status, rj?.stopStatus, rj?.stop_status, rj?.workerState, rj?.worker_state,
    rj?.dispatch?.state, rj?.dispatch?.status,
    rawJson?.state, rawJson?.status, rawJson?.stopStatus, rawJson?.stop_status, rawJson?.workerState, rawJson?.worker_state,
    rawJson?.dispatch?.state, rawJson?.dispatch?.status,
  ]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => v.trim().toLowerCase());
  const rawProcActions = [
    rj?.processAction, rj?.process_action,
    rawJson?.processAction, rawJson?.process_action,
  ]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => v.trim().toLowerCase());
  const hasExplicitKeptOpen = Boolean(
    rj?.keptOpen === true || rj?.kept_open === true ||
    rawJson?.keptOpen === true || rawJson?.kept_open === true ||
    rj?.dispatch?.keptOpen === true || rj?.dispatch?.kept_open === true ||
    rawJson?.dispatch?.keptOpen === true || rawJson?.dispatch?.kept_open === true
  );
  const hasBooleanRetained = Boolean(
    hasExplicitKeptOpen ||
    rj?.retained === true || rawJson?.retained === true ||
    rj?.dispatch?.retained === true || rawJson?.dispatch?.retained === true
  );
  return {
    states: [...new Set(rawStates)],
    procActions: [...new Set(rawProcActions)],
    hasExplicitKeptOpen,
    hasBooleanRetained,
  };
}

export function collectAllReleaseStatuses(rawJson, resJson = null) {
  const rj = resJson || res(rawJson);
  const rawStatuses = [
    rj?.action, rj?.status, rj?.releaseStatus, rj?.release_status, rj?.state, rj?.processAction, rj?.process_action,
    rj?.dispatch?.status, rj?.dispatch?.state,
    rawJson?.action, rawJson?.status, rawJson?.releaseStatus, rawJson?.release_status, rawJson?.state, rawJson?.processAction, rawJson?.process_action,
    rawJson?.dispatch?.status, rawJson?.dispatch?.state,
  ]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => v.trim().toLowerCase());
  const hasExplicitKeptOpen = Boolean(
    rj?.keptOpen === true || rj?.kept_open === true ||
    rawJson?.keptOpen === true || rawJson?.kept_open === true ||
    rj?.dispatch?.keptOpen === true || rj?.dispatch?.kept_open === true ||
    rawJson?.dispatch?.keptOpen === true || rawJson?.dispatch?.kept_open === true
  );
  const hasBooleanRetained = Boolean(
    hasExplicitKeptOpen ||
    rj?.retained === true || rawJson?.retained === true ||
    rj?.dispatch?.retained === true || rawJson?.dispatch?.retained === true
  );
  return {
    statuses: [...new Set(rawStatuses)],
    hasExplicitKeptOpen,
    hasBooleanRetained,
  };
}

export function hasUnconfirmedHelper(rawJson, resJson = null) {
  const rj = resJson || res(rawJson);
  const lists = [
    ...(Array.isArray(rj?.helpers) ? rj.helpers : []),
    ...(Array.isArray(rawJson?.helpers) ? rawJson.helpers : []),
  ];
  if (lists.length === 0) return false;
  for (const h of lists) {
    if (!h || typeof h !== "object") return true;
    if (
      h.keptOpen === true ||
      h.kept_open === true ||
      h.retained === true ||
      h.running === true
    ) {
      return true;
    }
    const hStates = [
      h.status, h.state, h.stopStatus, h.stop_status, h.workerState, h.worker_state,
    ]
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => v.trim().toLowerCase());
    if (hStates.length === 0 || hStates.some((s) => !CONFIRMED_STOP_STATES.has(s))) {
      return true;
    }
    const hActions = [h.processAction, h.process_action]
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => v.trim().toLowerCase());
    if (hActions.some((a) => REJECTED_PROC_ACTIONS.has(a))) {
      return true;
    }
  }
  return false;
}

/**
 * P0-01: Stop & release verification for caller-created MANUAL terminal dispatches:
 *   Per `orca orchestration worker-stop --help` & `worker-release --help`, a dispatch created by
 *   `orchestration dispatch` reports `fenced` on `worker-stop` and `retained` on `worker-release`.
 *   Therefore:
 *     1) Fence via `worker-stop` (mutually exclusive unanimous `fenced` OR confirmed stop states across ALL fields, zero `keptOpen`/`kept_open` at outer/inner/dispatch levels, zero unconfirmed helpers);
 *     2) Explicitly close the manual terminal via `verifyManualTerminalClosed` (requiring positive close confirmation!);
 *     3) Release via `worker-release` (mutually exclusive unanimous `retained` OR unanimous `released`/`already_released`/`closed`/`not_found` across ALL fields, zero `keptOpen`/`kept_open` at outer/inner/dispatch levels ONLY AFTER step 2 proved terminal closure!).
 */
export function verifyManualStopAndReleaseReceipt(orcaFn, dispatchId, termHandle) {
  if (!termHandle || !String(termHandle).trim()) {
    return { ok: false, reason: "manual dispatch stop/release requires a valid terminal handle" };
  }
  if (dispatchId && String(dispatchId).trim()) {
    const stopRes = orcaFn(["orchestration", "worker-stop", "--dispatch", dispatchId], { allowPostDeadlineCleanup: true });
    const stopJson = res(stopRes.json);
    const stopDispIds = collectReceiptDispatchIds(stopRes.json, stopJson);
    const {
      states: stopStates,
      procActions,
      hasExplicitKeptOpen: stopKeptOpen,
      hasBooleanRetained: stopRetained,
    } = collectAllStopStates(stopRes.json, stopJson);
    const liveHelper = hasUnconfirmedHelper(stopRes.json, stopJson);
    const idMatchedStop = stopDispIds.length > 0 && stopDispIds.every((id) => id === dispatchId);
    const pureFenced = !stopKeptOpen && (stopStates.length > 0 ? stopStates.every((s) => s === "fenced") : stopJson.fenced === true);
    const pureStopped = !stopRetained && stopStates.length > 0 && stopStates.every((s) => CONFIRMED_STOP_STATES.has(s));
    const unanimousFence = (pureFenced || pureStopped) &&
      procActions.every((a) => a !== "stop_unknown" && a !== "failed" && a !== "kept_open");
    const fencedOk = Boolean(
      stopRes.ok &&
      stopRes.json &&
      idMatchedStop &&
      !liveHelper &&
      !stopKeptOpen &&
      unanimousFence
    );
    if (!fencedOk) {
      return {
        ok: false,
        reason: liveHelper
          ? `worker-stop (${dispatchId}) left kept-open/running helper(s)`
          : `manual worker-stop (${dispatchId}) failed to fence cleanly (states=[${stopStates.join(",") || "empty"}], actions=[${procActions.join(",") || "none"}]: ${sanitizeText(stopRes.stderr || stopRes.raw || "unconfirmed", { maxLen: 180 })})`,
      };
    }
  }

  const termClosed = verifyManualTerminalClosed(orcaFn, termHandle);
  if (!termClosed.ok) {
    return termClosed;
  }

  if (dispatchId && String(dispatchId).trim()) {
    const relRes = orcaFn(["orchestration", "worker-release", "--dispatch", dispatchId], { allowPostDeadlineCleanup: true });
    const relJson = res(relRes.json);
    const relDispIds = collectReceiptDispatchIds(relRes.json, relJson);
    const {
      statuses: relStatuses,
      hasExplicitKeptOpen: relKeptOpen,
      hasBooleanRetained: relRetained,
    } = collectAllReleaseStatuses(relRes.json, relJson);
    const idMatchedRel = relDispIds.length > 0 && relDispIds.every((id) => id === dispatchId);
    const pureRetained = !relKeptOpen && relStatuses.length > 0 && relStatuses.every((s) => s === "retained");
    const pureReleased = !relRetained && relStatuses.length > 0 && relStatuses.every((s) => CONFIRMED_RELEASE_STATES.has(s));
    const unanimousManualRel = pureRetained || pureReleased;
    const relOk = Boolean(
      relRes.ok &&
      relRes.json &&
      idMatchedRel &&
      !relKeptOpen &&
      unanimousManualRel
    );
    if (!relOk) {
      return {
        ok: false,
        reason: `manual worker-release (${dispatchId}) lacked confirmation after terminal close (statuses=[${relStatuses.join(",") || "empty"}]: ${sanitizeText(relRes.stderr || relRes.raw || "unconfirmed", { maxLen: 180 })})`,
      };
    }
  }
  return { ok: true, reason: null };
}

/**
 * P0-01: Require explicit UNANIMOUS stop AND release confirmation across ALL fields for SUPERVISED (`cold`) `dispatchId`:
 *   - `worker-stop` MUST confirm an actual stopped state across ALL state/status fields (`state=stopped, status=running` is REJECTED!)
 *     and across ALL helper status/state fields (`helpers: [{ status: "stopped", state: "running" }]` is REJECTED!);
 *     `"fenced"` or bare `processAction` without a confirmed stop state is REJECTED!
 *   - `worker-release` MUST return a non-empty confirmed release state across ALL action/status/releaseStatus fields
 *     (`action=released, releaseStatus=retained` is REJECTED!).
 */
export function verifyStopAndReleaseReceipt(orcaFn, dispatchId) {
  if (!dispatchId || !String(dispatchId).trim()) {
    return { ok: false, reason: "missing dispatchId for stop/release verification" };
  }
  const stopRes = orcaFn(["orchestration", "worker-stop", "--dispatch", dispatchId], { allowPostDeadlineCleanup: true });
  const stopJson = res(stopRes.json);
  const stopDispIds = collectReceiptDispatchIds(stopRes.json, stopJson);
  const { states: stopStates, procActions, hasBooleanRetained: stopRetained } = collectAllStopStates(stopRes.json, stopJson);
  const liveHelper = hasUnconfirmedHelper(stopRes.json, stopJson);
  const idMatchedStop = stopDispIds.length > 0 && stopDispIds.every((id) => id === dispatchId);
  const unanimousStopped = stopStates.length > 0 &&
    stopStates.every((s) => CONFIRMED_STOP_STATES.has(s)) &&
    procActions.every((a) => !REJECTED_PROC_ACTIONS.has(a));
  const provenStopped = Boolean(
    stopRes.ok &&
    stopRes.json &&
    idMatchedStop &&
    !liveHelper &&
    !stopRetained &&
    unanimousStopped
  );
  if (!provenStopped) {
    return {
      ok: false,
      reason: liveHelper
        ? `worker-stop (${dispatchId}) left kept-open/running helper(s)`
        : !idMatchedStop
          ? `worker-stop receipt dispatchId mismatch (got [${stopDispIds.join(",") || "missing"}], expected "${dispatchId}")`
          : `worker-stop (${dispatchId}) lacked unanimous terminal stop confirmation (states=[${stopStates.join(",") || "empty"}], actions=[${procActions.join(",") || "none"}]: ${sanitizeText(stopRes.stderr || stopRes.raw || "unconfirmed", { maxLen: 180 })})`,
    };
  }

  const relRes = orcaFn(["orchestration", "worker-release", "--dispatch", dispatchId], { allowPostDeadlineCleanup: true });
  const relJson = res(relRes.json);
  const relDispIds = collectReceiptDispatchIds(relRes.json, relJson);
  const { statuses: relStatuses, hasBooleanRetained: relRetained } = collectAllReleaseStatuses(relRes.json, relJson);
  const idMatchedRel = relDispIds.length > 0 && relDispIds.every((id) => id === dispatchId);
  const unanimousReleased = relStatuses.length > 0 &&
    relStatuses.every((s) => CONFIRMED_RELEASE_STATES.has(s) || s === "closed_agent_terminal");
  const provenReleased = Boolean(
    relRes.ok &&
    relRes.json &&
    idMatchedRel &&
    !relRetained &&
    unanimousReleased
  );
  if (!provenReleased) {
    return {
      ok: false,
      reason: `worker-release (${dispatchId}) lacked unanimous release confirmation (statuses=[${relStatuses.join(",") || "empty"}]: ${sanitizeText(relRes.stderr || relRes.raw || "unconfirmed", { maxLen: 180 })}) — terminal ownership not released`,
    };
  }
  return { ok: true, reason: null };
}

export function createOrcaClient({ cfg, opt, objective, autoRun, agentOf, modelOf, writeStatus, log, warn, die }) {
  let orcaBin = null;
  let runId = null;
  let wt = null;
  let wtPath = null;
  let wtWarned = false;
  let createdWorktree = null;
  let startReqSeq = 0;
  const wtPin = opt.worktree || process.env.ORCA_FLOW_WORKTREE || cfg.defaults?.worktree || null;
  const START_RETRIES = cfg.defaults?.startRetries ?? 2;
  const START_RETRY_DELAY_MS = cfg.defaults?.startRetryDelayMs ?? 4000;
  const WARMUP_TIMEOUT_MS = cfg.defaults?.warmupTimeoutMs ?? 240000;

  const wtSource = () => opt.worktree ? "--worktree flag"
    : process.env.ORCA_FLOW_WORKTREE ? "ORCA_FLOW_WORKTREE env"
    : cfg.defaults?.worktree ? "config defaults.worktree"
    : createdWorktree ? "created this run" : "auto-detect";

  const wtFixHint = () =>
    "Fix one of:\n" +
    "  - run the flow from inside the target Orca worktree (auto-detect), or\n" +
    '  - let the flow create one (only when no worktree is pinned): re-run with --create-worktree (or set "defaults": { "autoCreateWorktree": true }), or\n' +
    "  - pass --worktree <selector> for this run, or\n" +
    "  - set ORCA_FLOW_WORKTREE for this machine/shell, or\n" +
    '  - set "defaults": { "worktree": "name:<displayName>" } in the config.';

  function resolveOrca(deadlineAt = null) {
    if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      return null;
    }
    const bases = process.env.ORCA_CLI_COMMAND ? [process.env.ORCA_CLI_COMMAND] : ["orca", "orca-dev", "orca-ide"];
    const cands = IS_WIN ? bases.flatMap((b) => (b.includes(".") ? [b] : [`${b}.cmd`, `${b}.exe`, b])) : bases;
    for (const c of cands) {
      const rem = clampTimeoutToDeadline(deadlineAt, 3000);
      if (rem === 0) return null;
      const p = spawnSync(c, ["--version"], {
        encoding: "utf8",
        timeout: rem,
        ...(deadlineAt != null && Number.isFinite(deadlineAt) ? { killSignal: "SIGKILL" } : {}),
      });
      if (deadlineAt != null && Number.isFinite(deadlineAt) && (Date.now() >= deadlineAt || p.error?.code === "ETIMEDOUT" || p.signal === "SIGTERM" || p.signal === "SIGKILL")) {
        return null;
      }
      if (!p.error) { orcaBin = c; return c; }
    }
    die("Could not find the orca CLI. Set ORCA_CLI_COMMAND.");
  }

  function orca(args, { timeoutMs, deadlineAt = null, allowPostDeadlineCleanup = false } = {}) {
    if (!allowPostDeadlineCleanup && deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      return {
        ok: false,
        json: null,
        raw: "",
        stderr: "step deadline reached before RPC",
        timedOut: true,
        deadlineExceeded: true,
      };
    }
    if (!orcaBin) {
      const resolvedBin = resolveOrca(allowPostDeadlineCleanup ? null : deadlineAt);
      if (!resolvedBin) {
        return {
          ok: false,
          json: null,
          raw: "",
          stderr: "step deadline reached before resolving orca CLI",
          timedOut: true,
          deadlineExceeded: true,
        };
      }
    }
    // P1-02: Recompute remaining budget IMMEDIATELY before spawning `orcaBin` (never reuse a pre-`resolveOrca` timeout)!
    const effTimeout = allowPostDeadlineCleanup
      ? Math.min(timeoutMs ?? CLEANUP_RPC_TIMEOUT_MS, CLEANUP_RPC_TIMEOUT_MS)
      : clampTimeoutToDeadline(deadlineAt, timeoutMs);
    if (!allowPostDeadlineCleanup && (effTimeout === 0 || (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt))) {
      return {
        ok: false,
        json: null,
        raw: "",
        stderr: "step deadline reached before RPC",
        timedOut: true,
        deadlineExceeded: true,
      };
    }
    const full = args.includes("--json") ? args : [...args, "--json"];
    const r = spawnSync(orcaBin, full, {
      encoding: "utf8",
      timeout: effTimeout,
      maxBuffer: 64 * 1024 * 1024,
      ...(allowPostDeadlineCleanup || (deadlineAt != null && Number.isFinite(deadlineAt)) ? { killSignal: "SIGKILL" } : {}),
    });
    const timedOut = Boolean(r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM" || r.signal === "SIGKILL");
    const hitDeadline = Boolean(
      !allowPostDeadlineCleanup &&
      deadlineAt != null &&
      Number.isFinite(deadlineAt) &&
      (timedOut || r.error) &&
      Date.now() >= deadlineAt - 5
    );
    const raw = (r.stdout || "").trim();
    let json = null;
    for (const line of raw.split(/\r?\n/).reverse()) {
      const s = line.trim();
      if (s.startsWith("{") || s.startsWith("[")) { try { json = JSON.parse(s); break; } catch {} }
    }
    if (!json && raw) { try { json = JSON.parse(raw); } catch {} }
    return {
      ok: !r.error && r.status === 0,
      json,
      raw,
      stderr: (r.stderr || (r.error ? r.error.message : "") || "").trim(),
      timedOut,
      ...(hitDeadline ? { deadlineExceeded: true } : {}),
    };
  }

  function worktreeCandidates(deadlineAt = null) {
    const l = orca(["worktree", "list"], { deadlineAt });
    if (l.deadlineExceeded) return "";
    const ws = (pick(res(l.json), ["worktrees"]) || [])
      .map((w) => ({ name: pick(w, ["displayName"]) || "", path: pick(w, ["path"]) || "" }))
      .filter((w) => w.name && w.path);
    const root = gitRoot()?.toLowerCase() || null;
    const same = root ? ws.filter((w) => {
      const p = w.path.toLowerCase();
      return p === root || p.startsWith(root + "\\") || p.startsWith(root + "/");
    }) : [];
    return (same.length ? same : ws).slice(0, 8).map((w) => `  name:${w.name}  ->  ${w.path}`).join("\n");
  }

  async function ensureWorktree() {
    if (wtPin || wt || opt.dryRun) return;
    const w = orca(["worktree", "current"]);
    const entry = pick(res(w.json), ["worktree"]) || res(w.json);
    const cur = w.ok ? pick(entry, ["path"]) : null;
    if (cur) { wt = `path:${cur}`; wtPath = cur; return; }
    const consent = opt.createWorktree || cfg.defaults?.autoCreateWorktree === true;
    const name = `flow-${slugify(objective)}-${wtStamp()}`;
    if (!consent) {
      if (!(process.stdin.isTTY && process.stdout.isTTY)) return;
      const root = gitRoot();
      if (!root) die("Cannot create a worktree: the invoking directory is not inside a git repository.");
      const sha = headSha();
      if (!sha) die("Cannot create a worktree: this git repository has no commits yet.");
      const a = await promptChoice(`No Orca worktree detected here. Create "${name}" from HEAD ${sha.slice(0, 8)}? Uncommitted changes will NOT follow. [y/N] `);
      if (!/^(y|yes)$/i.test(a.trim())) return;
    }
    const root = gitRoot();
    if (!root) die("Cannot create a worktree: the invoking directory is not inside a git repository.");
    const sha = headSha();
    if (!sha) die("Cannot create a worktree: this git repository has no commits yet.");
    const c = orca(["worktree", "create", "--repo", `path:${root}`, "--name", name, "--base-branch", sha, "--no-parent"]);
    if (!c.ok) {
      const detail = sanitizeText(String(c.json?.error || c.stderr || c.raw || "orca worktree create failed"), { maxLen: 600 });
      die(`Could not create worktree "${name}": ${detail}\n${wtFixHint()}`);
    }
    wt = `name:${name}`;
    const cp = pick(pick(res(c.json), ["worktree"]) || {}, ["path"]);
    if (cp) wtPath = cp;
    createdWorktree = name;
    log(`[worktree] created ${name}${cp ? " -> " + cp : ""}`);
  }

  function resolveWorktree(soft = false, deadlineAt = null) {
    if (wt) return wt;
    if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      return null;
    }
    if (wtPin) {
      const shown = orca(["worktree", "show", "--worktree", wtPin], { deadlineAt });
      if (shown.deadlineExceeded) return null;
      const p = pick(res(shown.json).worktree || {}, ["path"]);
      if (shown.ok && p) { wt = wtPin; wtPath = p; return wt; }
      const cands = worktreeCandidates(deadlineAt);
      const msg = `worktree "${wtPin}" (from ${wtSource()}) does not exist.\n${wtFixHint()}${cands ? `\nAvailable worktrees:\n${cands}` : ""}`;
      if (soft) { if (!wtWarned) { wtWarned = true; warn(msg); } return null; }
      die(msg);
    }
    const w = orca(["worktree", "current"], { deadlineAt });
    if (w.deadlineExceeded) return null;
    const entry = pick(res(w.json), ["worktree"]) || res(w.json);
    const p = pick(entry, ["path"]);
    if (w.ok && p) { wt = `path:${p}`; wtPath = p; return wt; }
    if (soft) return null;
    const cands = worktreeCandidates(deadlineAt);
    die(`Could not auto-detect the worktree: the invoking directory is not inside an Orca-managed worktree.\n${wtFixHint()}${cands ? `\nAvailable worktrees:\n${cands}` : ""}`);
  }

  function resolveWorktreePath(soft = false, deadlineAt = null) {
    if (wtPath != null) return wtPath;
    if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      return null;
    }
    const sel = resolveWorktree(soft, deadlineAt);
    if (!sel) return null;
    if (sel.startsWith("path:")) wtPath = sel.slice("path:".length);
    else {
      const w = orca(["worktree", "show", "--worktree", sel], { deadlineAt });
      if (w.deadlineExceeded) return null;
      wtPath = pick(res(w.json).worktree || {}, ["path"]) || null;
    }
    return wtPath;
  }

  function agentCommand(agent, model = null, { effort = null, worktreePath = null } = {}) {
    return buildAgentCommand(agent, model, { autoRun, effort, worktreePath, warn, isWin: IS_WIN });
  }

  function resolveEffectiveWtPath(wtSelector, explicitPath, deadlineAt = null) {
    if (explicitPath) return explicitPath;
    if (wtSelector && wtSelector.startsWith("path:")) return wtSelector.slice("path:".length);
    return resolveWorktreePath(true, deadlineAt);
  }

  function warmTerminal(agent, model = null, wtSelector = null, { effort = null, worktreePath = null, deadlineAt = null } = {}) {
    if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      return { ok: false, deadlineExceeded: true, uncreated: true, handle: null };
    }
    const startedAt = Date.now();
    const effWtPath = resolveEffectiveWtPath(wtSelector, worktreePath, deadlineAt);
    if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      return { ok: false, deadlineExceeded: true, uncreated: true, handle: null };
    }
    const effWtSel = wtSelector || resolveWorktree(false, deadlineAt);
    if (!effWtSel && deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      return { ok: false, deadlineExceeded: true, uncreated: true, handle: null };
    }
    const cmd = agentCommand(agent, model, { effort, worktreePath: effWtPath });
    const c = orca(["terminal", "create", "--worktree", effWtSel, "--command", cmd], {
      deadlineAt,
    });
    if (c.deadlineExceeded) {
      return { ok: false, deadlineExceeded: true, uncreated: true, handle: null, command: cmd };
    }
    const cr = res(c.json);
    const allCreateHandles = extractAllReceiptTerminalHandles(c.json);
    const handle = pick(cr, ["handle", "terminalHandle"]) || pick(cr.terminal || {}, ["handle"]) || allCreateHandles[0] || null;
    if (!c.ok || !handle) {
      // P0-01: If `terminal create` failed AFTER returning a terminal handle, NEVER discard it!
      // Explicitly close and verify closure; if closure cannot be positively proven, return `ambiguous: true`!
      if (handle) {
        const cl = verifyManualTerminalClosed(orca, handle);
        if (!cl.ok) {
          return {
            ok: false,
            ambiguous: true,
            uncreated: false,
            handle,
            command: cmd,
            error: `terminal create ('${agent}') failed after returning handle ${handle}, and close could not be confirmed: ${cl.reason}`,
          };
        }
        warn(`terminal create ('${agent}') failed after returning handle ${handle} (closed cleanly); cold-starting instead.`);
        return {
          ok: false,
          uncreated: false,
          closedCleanly: true,
          handle: null,
          command: cmd,
          error: sanitizeText(c.stderr || c.raw || "terminal create failed after returning handle", { maxLen: 200 }),
        };
      }
      warn(`terminal create ('${agent}') failed: ${sanitizeText(c.stderr || c.raw || "no handle", { maxLen: 240 })}; cold-starting instead.`);
      return { ok: false, uncreated: true, handle: null, command: cmd, error: sanitizeText(c.stderr || c.raw || "no handle", { maxLen: 200 }) };
    }
    const QUIET_MS = 8000, MIN_UPTIME_MS = 12000, POLL_MS = 3000;
    let lastOut = -1, quietSince = Date.now();
    const warmCapAt = (deadlineAt != null && Number.isFinite(deadlineAt))
      ? Math.min(startedAt + WARMUP_TIMEOUT_MS, deadlineAt)
      : (startedAt + WARMUP_TIMEOUT_MS);
    while (Date.now() < warmCapAt) {
      const rem = warmCapAt - Date.now();
      if (rem <= 0) break;
      sleepMs(Math.min(POLL_MS, rem));
      writeStatus();
      if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
        return { ok: false, deadlineExceeded: true, handle, command: cmd };
      }
      const s = orca(["terminal", "show", "--terminal", handle], { deadlineAt });
      if (s.deadlineExceeded) {
        return { ok: false, deadlineExceeded: true, handle, command: cmd };
      }
      const out = pick(pick(res(s.json), ["terminal"]) || {}, ["lastOutputAt"]) || 0;
      if (out !== lastOut) { lastOut = out; quietSince = Date.now(); }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= MIN_UPTIME_MS && Date.now() - quietSince >= QUIET_MS) {
        log(`  warmed ${agent} terminal ${handle} (${Math.round(elapsed / 1000)}s)`);
        return { ok: true, handle, command: cmd };
      }
    }
    if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      return { ok: false, deadlineExceeded: true, handle, command: cmd };
    }
    warn(`agent '${agent}' TUI not ready within ${WARMUP_TIMEOUT_MS}ms; closing terminal before fallback.`);
    const cl = verifyManualTerminalClosed(orca, handle);
    if (!cl.ok) {
      return {
        ok: false,
        ambiguous: true,
        handle,
        command: cmd,
        error: `after warmup timeout: ${cl.reason}`,
      };
    }
    return { ok: false, uncreated: false, closedCleanly: true, handle: null, command: cmd, error: "warmup timeout" };
  }

  function closeManualSessionSafely(dispatchId, term, stageLabel) {
    const mr = verifyManualStopAndReleaseReceipt(orca, dispatchId, term);
    if (!mr.ok) {
      return {
        ok: false,
        reason: `${mr.reason} (after ${stageLabel})`,
      };
    }
    return { ok: true, reason: null };
  }

  function manualStart(step, taskId, wtSelector = null, launchOpts = {}) {
    const deadlineAt = launchOpts.deadlineAt ?? null;
    const effAgent = launchOpts.agentOverride ?? agentOf(step);
    // P1-02: Check `deadlineAt` BEFORE any worktree/CLI resolution probes!
    if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      return {
        ok: false,
        deadlineExceeded: true,
        dispatchId: null,
        terminal: null,
        effectiveAgent: effAgent,
        effectiveModel: null,
        effectiveModelResolved: true,
        effectiveEffort: null,
        effectiveEffortResolved: true,
        attempts: [],
        error: "reached step deadline before manualStart",
      };
    }
    const reqModel = launchOpts.modelOverride !== undefined ? launchOpts.modelOverride : modelOf(step);
    const reqEffort = launchOpts.effortOverride !== undefined ? launchOpts.effortOverride : (step.effort || null);
    const effWtPath = resolveEffectiveWtPath(wtSelector, launchOpts.worktreePath || null, deadlineAt);
    if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      return {
        ok: false,
        deadlineExceeded: true,
        dispatchId: null,
        terminal: null,
        effectiveAgent: effAgent,
        effectiveModel: null,
        effectiveModelResolved: true,
        effectiveEffort: null,
        effectiveEffortResolved: true,
        attempts: [],
        error: "reached step deadline resolving worktree path",
      };
    }
    // P0-03 & P2-01: Build the EXACT final command string first and parse its real shell `argv`
    // so comments, `--`/`"--"`, and `--model default` never diverge between launch and ledger!
    const previewBuiltCmd = agentCommand(effAgent, reqModel, { effort: reqEffort, worktreePath: effWtPath });
    const parsedFinal = parseAgentCommandSpec(previewBuiltCmd);
    const effectivePassedModel = (!parsedFinal.parseable || parsedFinal.isKiro)
      ? null
      : (parsedFinal.explicitDefaultModel ? "default" : (parsedFinal.embeddedModel || null));
    const effectivePassedEffort = parsedFinal.parseable ? (parsedFinal.embeddedEffort || null) : null;
    const manualReqId = `start-${process.pid}-${++startReqSeq}`;

    let lastClearedInfo = null;
    if (launchOpts.beforeEachStartAttempt) {
      lastClearedInfo = launchOpts.beforeEachStartAttempt();
    }

    const warmed = warmTerminal(effAgent, reqModel, wtSelector, {
      effort: reqEffort,
      worktreePath: launchOpts.worktreePath || null,
      deadlineAt,
    });
    if (!warmed.ok) {
      const failedManualAttempt = {
        attempt: 1,
        requestId: manualReqId,
        mode: "manual",
        agent: effAgent,
        model: effectivePassedModel,
        effort: effectivePassedEffort,
        dispatchId: null,
        state: warmed.deadlineExceeded ? "deadline_exceeded" : (warmed.uncreated ? "terminal_create_failed" : "warmup_failed"),
        ok: false,
        error: warmed.error || (warmed.deadlineExceeded ? "deadline exceeded during warmTerminal" : "manual warm failed"),
      };
      if (warmed.deadlineExceeded) {
        return {
          ok: false,
          deadlineExceeded: true,
          dispatchId: null,
          terminal: warmed.handle || null,
          effectiveAgent: effAgent,
          effectiveModel: effectivePassedModel,
          effectiveEffort: effectivePassedEffort,
          lastClearedInfo,
          attempts: [failedManualAttempt],
          error: "reached step deadline during terminal warmup",
        };
      }
      if (warmed.ambiguous) {
        return {
          ok: false,
          ambiguous: true,
          dispatchId: null,
          terminal: warmed.handle,
          effectiveAgent: effAgent,
          effectiveModel: effectivePassedModel,
          effectiveEffort: effectivePassedEffort,
          lastClearedInfo,
          error: warmed.error,
          attempts: [failedManualAttempt],
        };
      }
      return { ok: false, fallbackToCold: true, attempts: [failedManualAttempt], lastClearedInfo };
    }

    const term = warmed.handle;
    if (launchOpts.onBeforeManualDispatch) {
      const okReady = launchOpts.onBeforeManualDispatch();
      if (okReady === false) {
        const cl = closeManualSessionSafely(null, term, "failed task-update");
        return {
          ok: false,
          ambiguous: !cl.ok,
          dispatchId: null,
          terminal: cl.ok ? null : term,
          effectiveAgent: effAgent,
          effectiveModel: effectivePassedModel,
          effectiveEffort: effectivePassedEffort,
          lastClearedInfo,
          attempts: [{ attempt: 1, requestId: manualReqId, mode: "manual", agent: effAgent, model: effectivePassedModel, effort: effectivePassedEffort, dispatchId: null, state: "task_update_failed", ok: false, error: "task-update to ready failed before manual dispatch" }],
          error: "task-update to ready failed before manual dispatch",
        };
      }
    }

    const d = orca(["orchestration", "dispatch", "--task", taskId, "--to", term, "--run", runId], {
      deadlineAt,
      timeoutMs: clampTimeoutToDeadline(deadlineAt),
    });
    const dr = res(d.json);
    const rawDispId = pick(pick(dr, ["dispatch"]) || {}, ["id"]) || pick(dr, ["dispatchId", "dispatch_id"]);
    const dispatchId = rawDispId && String(rawDispId).trim() ? String(rawDispId).trim() : null;
    if (!d.ok || !dispatchId) {
      const dispErr = sanitizeText(d.stderr || d.raw || "missing dispatchId", { maxLen: 240 });
      warn(`tracking dispatch '${step.title}' failed: ${dispErr}`);
      const cl = closeManualSessionSafely(dispatchId || null, term, "dispatch failure");
      const att = { attempt: 1, requestId: manualReqId, mode: "manual", agent: effAgent, model: effectivePassedModel, effort: effectivePassedEffort, dispatchId: dispatchId || null, state: "dispatch_failed", ok: false, error: dispErr };
      if (!cl.ok || (d.ok && !dispatchId)) {
        return {
          ok: false,
          ambiguous: true,
          dispatchId: dispatchId || null,
          terminal: term,
          effectiveAgent: effAgent,
          effectiveModel: effectivePassedModel,
          effectiveEffort: effectivePassedEffort,
          lastClearedInfo,
          attempts: [att],
          error: cl.reason || "orchestration dispatch returned ok without a dispatchId",
        };
      }
      return { ok: false, fallbackToCold: true, attempts: [att], lastClearedInfo };
    }

    const p = orca(["orchestration", "dispatch", "--task", taskId, "--to", term, "--run", runId, "--dry-run", "--return-preamble"], {
      deadlineAt,
      timeoutMs: clampTimeoutToDeadline(deadlineAt),
    });
    const preamble = pick(res(p.json), ["preamble"]);
    if (!p.ok || !preamble) {
      warn(`preamble fetch '${step.title}' failed: ${sanitizeText(p.stderr || p.raw, { maxLen: 240 })}`);
      const cl = closeManualSessionSafely(dispatchId, term, "preamble failure");
      const att = { attempt: 1, requestId: manualReqId, mode: "manual", agent: effAgent, model: effectivePassedModel, effort: effectivePassedEffort, dispatchId, state: "preamble_failed", ok: false, error: "preamble fetch failed" };
      if (!cl.ok) return { ok: false, ambiguous: true, dispatchId, terminal: term, lastClearedInfo, attempts: [att], error: cl.reason };
      return { ok: false, manualAbortedAfterDispatch: true, supersededDispatchId: dispatchId, lastClearedInfo, attempts: [att], error: "preamble fetch failed" };
    }

    const s = orca(["terminal", "send", "--terminal", term, "--text", preamble.split("ctx_dryrun").join(dispatchId), "--enter"], {
      deadlineAt,
      timeoutMs: clampTimeoutToDeadline(deadlineAt),
    });
    if (!s.ok) {
      warn(`terminal send '${step.title}' failed: ${sanitizeText(s.stderr || s.raw, { maxLen: 240 })}`);
      const cl = closeManualSessionSafely(dispatchId, term, "send failure");
      const att = { attempt: 1, requestId: manualReqId, mode: "manual", agent: effAgent, model: effectivePassedModel, effort: effectivePassedEffort, dispatchId, state: "send_failed", ok: false, error: "terminal send failed" };
      if (!cl.ok) return { ok: false, ambiguous: true, dispatchId, terminal: term, lastClearedInfo, attempts: [att], error: cl.reason };
      return { ok: false, manualAbortedAfterDispatch: true, supersededDispatchId: dispatchId, lastClearedInfo, attempts: [att], error: "terminal send failed" };
    }

    const remInitialEnter = deadlineAt != null && Number.isFinite(deadlineAt) ? (deadlineAt - Date.now()) : 3000;
    if (remInitialEnter > 0) sleepMs(Math.min(3000, remInitialEnter));
    if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      return {
        ok: false,
        deadlineExceeded: true,
        dispatchId,
        terminal: term,
        effectiveAgent: effAgent,
        effectiveModel: effectivePassedModel,
        effectiveEffort: effectivePassedEffort,
        lastClearedInfo,
        attempts: [{ attempt: 1, requestId: manualReqId, mode: "manual", agent: effAgent, model: effectivePassedModel, effort: effectivePassedEffort, dispatchId, state: "deadline_exceeded", ok: false, error: "deadline exceeded after manual send" }],
        error: "reached step deadline during manual prompt delivery",
      };
    }
    orca(["terminal", "send", "--terminal", term, "--text", "", "--enter"], { deadlineAt, timeoutMs: clampTimeoutToDeadline(deadlineAt) });
    const START_GRACE_MS = cfg.defaults?.startGraceMs ?? 90000;
    const SEND_ATTEMPTS = cfg.defaults?.sendAttempts ?? 3;
    const previewOf = (h) => pick(pick(res(orca(["terminal", "show", "--terminal", h], { deadlineAt, timeoutMs: clampTimeoutToDeadline(deadlineAt) }).json), ["terminal"]) || {}, ["preview"]) ?? null;
    const before = previewOf(term);
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
      const graceCap = (deadlineAt != null && Number.isFinite(deadlineAt))
        ? Math.min(Date.now() + START_GRACE_MS, deadlineAt)
        : (Date.now() + START_GRACE_MS);
      while (Date.now() < graceCap) {
        const rem = graceCap - Date.now();
        if (rem <= 0) break;
        sleepMs(Math.min(4000, rem));
        writeStatus();
        if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
          return {
            ok: false,
            deadlineExceeded: true,
            dispatchId,
            terminal: term,
            effectiveAgent: effAgent,
            effectiveModel: effectivePassedModel,
            effectiveEffort: effectivePassedEffort,
            lastClearedInfo,
            attempts: [{ attempt, requestId: manualReqId, mode: "manual", agent: effAgent, model: effectivePassedModel, effort: effectivePassedEffort, dispatchId, state: "deadline_exceeded", ok: false, error: "deadline exceeded waiting for prompt consumption" }],
            error: "reached step deadline waiting for manual prompt consumption",
          };
        }
        const pv = previewOf(term);
        if (pv == null || before == null || pv !== before) {
          return {
            ok: true,
            startMode: "manual",
            dispatchId,
            terminal: term,
            effectiveAgent: effAgent,
            effectiveModel: effectivePassedModel,
            effectiveModelResolved: true,
            effectiveEffort: effectivePassedEffort,
            effectiveEffortResolved: true,
            lastClearedInfo,
            attempts: [{ attempt, requestId: manualReqId, mode: "manual", agent: effAgent, model: effectivePassedModel, effort: effectivePassedEffort, dispatchId, state: "manual", ok: true }],
          };
        }
      }
      if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
        return {
          ok: false,
          deadlineExceeded: true,
          dispatchId,
          terminal: term,
          effectiveAgent: effAgent,
          effectiveModel: effectivePassedModel,
          effectiveEffort: effectivePassedEffort,
          lastClearedInfo,
          attempts: [{ attempt, requestId: manualReqId, mode: "manual", agent: effAgent, model: effectivePassedModel, effort: effectivePassedEffort, dispatchId, state: "deadline_exceeded", ok: false, error: "deadline exceeded waiting for prompt consumption" }],
          error: "reached step deadline waiting for manual prompt consumption",
        };
      }
      if (attempt < SEND_ATTEMPTS) {
        const nudge = attempt === 1;
        warn(`no sign the '${step.title}' prompt was consumed; ${nudge ? "nudging with Enter" : "re-sending"} (${attempt + 1}/${SEND_ATTEMPTS})`);
        const s2 = nudge
          ? orca(["terminal", "send", "--terminal", term, "--text", "", "--enter"], { deadlineAt, timeoutMs: clampTimeoutToDeadline(deadlineAt) })
          : orca(["terminal", "send", "--terminal", term, "--text", preamble.split("ctx_dryrun").join(dispatchId), "--enter"], { deadlineAt, timeoutMs: clampTimeoutToDeadline(deadlineAt) });
        if (!s2.ok) { warn(`re-send '${step.title}' failed: ${sanitizeText(s2.stderr || s2.raw, { maxLen: 240 })}`); break; }
      }
    }
    warn(`prompt for '${step.title}' was not consumed after ${SEND_ATTEMPTS} attempt(s); stopping manual dispatch before cold-start.`);
    const cl = closeManualSessionSafely(dispatchId, term, "unconsumed prompt");
    const att = { attempt: SEND_ATTEMPTS, requestId: manualReqId, mode: "manual", agent: effAgent, model: effectivePassedModel, effort: effectivePassedEffort, dispatchId, state: "unconsumed_prompt", ok: false, error: "manual prompt not consumed" };
    if (!cl.ok) {
      return { ok: false, ambiguous: true, dispatchId, terminal: term, lastClearedInfo, attempts: [att], error: cl.reason };
    }
    return { ok: false, manualAbortedAfterDispatch: true, supersededDispatchId: dispatchId, lastClearedInfo, attempts: [att], error: "manual prompt not consumed" };
  }

  function coldStart(step, taskId, wtSelector = null, launchOpts = {}) {
    const deadlineAt = launchOpts.deadlineAt ?? null;
    let retryOf = launchOpts.retryOfDispatchId || null;
    const effAgent = launchOpts.agentOverride ?? agentOf(step);
    const orcaAgent = normalizeOrcaWorkerAgent(effAgent);
    const attempts = [...(launchOpts.priorAttempts || [])];
    let lastClearedInfo = launchOpts.initialClearedInfo || null;
    // P1-02: Check `deadlineAt` BEFORE any worktree/CLI resolution probes!
    if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      return {
        ok: false,
        deadlineExceeded: true,
        dispatchId: null,
        terminal: null,
        effectiveAgent: orcaAgent,
        effectiveModel: null,
        effectiveModelResolved: true,
        effectiveEffort: null,
        effectiveEffortResolved: true,
        lastClearedInfo,
        attempts,
        error: "reached step deadline before coldStart",
      };
    }
    const parsedCmd = parseAgentCommandSpec(effAgent);
    const reqModel = launchOpts.modelOverride !== undefined ? launchOpts.modelOverride : modelOf(step);
    const reqEffort = launchOpts.effortOverride !== undefined ? launchOpts.effortOverride : (step.effort || null);
    const rawNormModel = (reqModel != null && String(reqModel).trim() && String(reqModel).trim().toLowerCase() !== "default")
      ? String(reqModel).trim()
      : null;
    const normReqModel = rawNormModel && isSafeSingleTokenValue(rawNormModel) ? rawNormModel : null;
    // P0-03 & P2-01: Honor embedded `--model`/`--effort` in `effAgent` consistently on coldStart;
    // if `effAgent` explicitly specified `--model default` or `rawNormModel` was invalid, do NOT override!
    const model = (!parsedCmd.parseable || parsedCmd.isKiro || parsedCmd.explicitDefaultModel || (rawNormModel && !normReqModel))
      ? null
      : (parsedCmd.embeddedModel || normReqModel || null);
    const effWtPath = resolveEffectiveWtPath(wtSelector, launchOpts.worktreePath || null, deadlineAt);
    if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      return {
        ok: false,
        deadlineExceeded: true,
        dispatchId: null,
        terminal: null,
        effectiveAgent: orcaAgent,
        effectiveModel: null,
        effectiveModelResolved: true,
        effectiveEffort: null,
        effectiveEffortResolved: true,
        lastClearedInfo,
        attempts,
        error: "reached step deadline resolving worktree path in coldStart",
      };
    }
    const resolvedColdSpec = parsedCmd.explicitDefaultModel
      ? { effectiveModel: "default" }
      : resolveEffectiveLaunchSpec(effAgent, model, null, { projectDir: effWtPath || null });
    const recordedColdModel = parsedCmd.explicitDefaultModel
      ? "default"
      : (model || (parsedCmd.parseable && !(rawNormModel && !normReqModel) && /^opencode2?$/i.test(orcaAgent) ? resolvedColdSpec.effectiveModel : null) || null);
    const rawColdEffort = parsedCmd.parseable ? (parsedCmd.embeddedEffort || reqEffort || null) : null;
    const effort = (rawColdEffort && isSafeSingleTokenValue(String(rawColdEffort).trim())) ? String(rawColdEffort).trim() : null;

    const enforceColdAgyTrust = process.env.ORCA_ENFORCE_COLD_AGY_TRUST === "1" || process.env.ORCA_TEST_MODE !== "1";
    if (orcaAgent === "antigravity" && enforceColdAgyTrust && effWtPath && !isAgyWorkspaceTrusted(effWtPath)) {
      const trustErr = `antigravity supervised cold-start cannot inject session --settings trustedWorkspaces for untrusted worktree "${effWtPath}" (warm terminal required or add parent directory to trustedWorkspaces)`;
      attempts.push({ attempt: attempts.length + 1, mode: "cold", agent: orcaAgent, model: model || null, effort: null, dispatchId: null, state: "blocked_untrusted", ok: false, error: trustErr });
      return {
        ok: false,
        ambiguous: false,
        dispatchId: null,
        terminal: null,
        effectiveAgent: orcaAgent,
        effectiveModel: model || null,
        effectiveEffort: null,
        lastClearedInfo,
        attempts,
        error: trustErr,
        failedStage: "workspace_trust",
        promptBlocked: true,
      };
    }

    for (let attempt = 0; attempt <= START_RETRIES; attempt++) {
      if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
        return {
          ok: false,
          deadlineExceeded: true,
          dispatchId: null,
          terminal: null,
          effectiveAgent: orcaAgent,
          effectiveModel: model || null,
          effectiveEffort: null,
          lastClearedInfo,
          attempts,
          error: "reached step deadline before worker-start attempt",
        };
      }
      if (launchOpts.beforeEachStartAttempt) {
        lastClearedInfo = launchOpts.beforeEachStartAttempt();
      }

      const startReqId = `start-${process.pid}-${++startReqSeq}`;
      const effWtSel = wtSelector || resolveWorktree(false, deadlineAt);
      if (!effWtSel && deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
        return {
          ok: false,
          deadlineExceeded: true,
          dispatchId: null,
          terminal: null,
          effectiveAgent: orcaAgent,
          effectiveModel: recordedColdModel,
          effectiveModelResolved: true,
          effectiveEffort: null,
          effectiveEffortResolved: true,
          lastClearedInfo,
          attempts,
          error: "reached step deadline resolving worktree before worker-start",
        };
      }
      const args = [
        "orchestration", "worker-start",
        "--task", taskId,
        "--run", runId,
        "--worktree", effWtSel,
        "--agent", orcaAgent,
      ];
      let passedEffort = null;
      if (model) {
        args.push("--model", model);
        if (effort && !/^opencode2?$/i.test(orcaAgent)) {
          args.push("--effort", effort);
          passedEffort = effort;
        } else if (effort && attempt === 0) {
          warn(`[orca-cli] omitting --effort "${effort}" on cold-start of "${orcaAgent}" (effort unsupported for OpenCode worker-start).`);
        }
      } else if (effort && attempt === 0) {
        warn(`[orca-cli] omitting --effort "${effort}" on cold-start of "${orcaAgent}" because Orca worker-start requires --model with --effort.`);
      }
      const remMs = (deadlineAt != null && Number.isFinite(deadlineAt)) ? Math.max(1, Math.floor(deadlineAt - Date.now())) : null;
      const effStartTimeout = step.startTimeoutMs
        ? (remMs != null ? Math.min(step.startTimeoutMs, remMs) : step.startTimeoutMs)
        : remMs;
      if (effStartTimeout != null && step.startTimeoutMs) args.push("--timeout-ms", String(Math.floor(effStartTimeout)));
      if (retryOf) args.push("--retry-of", retryOf);

      const r = orca(args, { deadlineAt, timeoutMs: step.startTimeoutMs ? step.startTimeoutMs + 5000 : undefined });
      if (r.deadlineExceeded) {
        return {
          ok: false,
          deadlineExceeded: true,
          dispatchId: null,
          terminal: null,
          effectiveAgent: orcaAgent,
          effectiveModel: model || null,
          effectiveEffort: passedEffort,
          lastClearedInfo,
          attempts,
          error: "reached step deadline during worker-start",
        };
      }
      const result = res(r.json);
      const rawDispId = pick(result, ["dispatchId", "dispatch_id"])
        || pick(result.dispatch || {}, ["id"])
        || pick(r.json || {}, ["dispatchId", "dispatch_id"])
        || pick(r.json?.dispatch || {}, ["id"]);
      const dispatchId = rawDispId && String(rawDispId).trim() ? String(rawDispId).trim() : null;
      const state = pick(result, ["state"]) || pick(r.json || {}, ["state"]);
      const receiptTurnStart = pick(result, ["turnStart", "turn_start"]) || null;

      if (r.ok && (state === "ready" || !state)) {
        if (!dispatchId) {
          const noIdErr = "worker-start returned ok without a dispatchId — refusing unattributed worker on worktree";
          attempts.push({ attempt: attempts.length + 1, requestId: startReqId, mode: "cold", agent: orcaAgent, model: recordedColdModel, effort: passedEffort, dispatchId: null, state: state || "ok_missing_id", ok: false, error: noIdErr });
          return {
            ok: false,
            ambiguous: true,
            dispatchId: null,
            terminal: null,
            effectiveAgent: orcaAgent,
            effectiveModel: recordedColdModel,
            effectiveModelResolved: true,
            effectiveEffort: passedEffort,
            effectiveEffortResolved: true,
            lastClearedInfo,
            attempts,
            error: noIdErr,
            failedStage: "missing_dispatch_id",
          };
        }
        attempts.push({ attempt: attempts.length + 1, requestId: startReqId, mode: "cold", agent: orcaAgent, model: recordedColdModel, effort: passedEffort, dispatchId, state: state || "ready", ok: true });
        return {
          ok: true,
          startMode: "cold",
          dispatchId,
          terminal: null,
          dispatchState: state || null,
          receiptTurnStart,
          effectiveAgent: orcaAgent,
          effectiveModel: recordedColdModel,
          effectiveModelResolved: true,
          effectiveEffort: passedEffort,
          effectiveEffortResolved: true,
          lastClearedInfo,
          attempts,
        };
      }

      const rawErr = pick(result, ["lastError"]) || r.json?.error || r.stderr || "unknown error";
      const lastError = sanitizeText(String(rawErr), { maxLen: 260 });
      const failedStage = pick(result, ["failedStage", "stage"]) || pick(r.json || {}, ["failedStage", "stage"]) || null;
      const normFailedStage = String(failedStage || "").trim().toLowerCase();
      const residual = pick(result, ["residualResources", "effects"]) ?? pick(r.json || {}, ["residualResources", "effects"]);
      const hasResiduals = Array.isArray(residual) ? residual.length > 0 : Boolean(residual && typeof residual === "object" && Object.keys(residual).length > 0);
      attempts.push({
        attempt: attempts.length + 1,
        requestId: startReqId,
        mode: "cold",
        agent: orcaAgent,
        model: recordedColdModel,
        effort: passedEffort,
        dispatchId,
        state: state || "failed",
        ok: false,
        failedStage,
        error: lastError,
      });

      // P0-01: Scan FULL untruncated diagnostic channels (`lastError`, `json.error`, `stderr`, `raw`)
      // independently so runtime/network conflicts in `stderr` or beyond 300 chars are NEVER missed!
      const fullDiagText = [
        String(pick(result, ["lastError"]) || ""),
        String(r.json?.error || ""),
        String(r.stderr || ""),
        String(r.raw || ""),
      ].join("\n");
      const gwErr = Boolean(detectGatewayDisconnect(fullDiagText));
      const netConflict = RUNTIME_NETWORK_CONFLICT_RE.test(fullDiagText);
      const pbErr = Boolean(detectPromptBlocked(fullDiagText));

      if (dispatchId) {
        const sr = verifyStopAndReleaseReceipt(orca, dispatchId);
        if (!sr.ok) {
          return {
            ok: false,
            ambiguous: true,
            dispatchId,
            terminal: null,
            effectiveAgent: orcaAgent,
            effectiveModel: recordedColdModel,
            effectiveModelResolved: true,
            effectiveEffort: passedEffort,
            effectiveEffortResolved: true,
            lastClearedInfo,
            attempts,
            error: `${sr.reason} (after worker-start ${state || failedStage || "failure"}: ${lastError})`,
            failedStage,
            raw: sanitizeText(r.raw || r.stderr, { maxLen: 300 }),
          };
        }
      } else {
        // P0-01: Failed worker-start WITHOUT a `dispatchId`:
        // 1) Reconcile via `dispatch-show --task <taskId>` to check if a stray dispatch was created anyway!
        const recon = orca(["orchestration", "dispatch-show", "--task", taskId], { allowPostDeadlineCleanup: true, timeoutMs: CLEANUP_RPC_TIMEOUT_MS });
        const reconDisp = pick(res(recon.json), ["dispatch"]) || {};
        const reconDispId = pick(reconDisp, ["id", "dispatchId", "dispatch_id"]) || null;
        if (reconDispId && reconDispId !== retryOf) {
          const sr = verifyStopAndReleaseReceipt(orca, reconDispId);
          if (!sr.ok) {
            return {
              ok: false,
              ambiguous: true,
              dispatchId: reconDispId,
              terminal: null,
              effectiveAgent: orcaAgent,
              effectiveModel: recordedColdModel,
              effectiveModelResolved: true,
              effectiveEffort: passedEffort,
              effectiveEffortResolved: true,
              lastClearedInfo,
              attempts,
              error: `reconciled stray dispatch ${reconDispId} after unattributed worker-start failure could not be stopped/released: ${sr.reason}`,
              failedStage,
            };
          }
          retryOf = reconDispId;
        } else {
          // 2) No dispatchId in receipt or dispatch-show: ONLY classify as `ambiguous: false` when
          //    structured Orca error code/stage is strictly a pre-launch validation rejection AND
          //    NO conflicting runtime/post-start signal (`failedStage`, top-level or nested handle,
          //    `gwErr`, or `netConflict` in stderr/stdout) is present!
          const structuredCode = String(
            pick(result, ["code", "errorCode", "error_code"]) ||
            pick(r.json || {}, ["code", "errorCode", "error_code"]) ||
            ""
          ).trim().toLowerCase();
          const allRetHandles = extractAllReceiptTerminalHandles(r.json);
          const allReceiptStates = [
            pick(result, ["state"]),
            pick(result, ["status"]),
            pick(result.dispatch || {}, ["state"]),
            pick(result.dispatch || {}, ["status"]),
            pick(r.json || {}, ["state"]),
            pick(r.json || {}, ["status"]),
            pick(r.json?.dispatch || {}, ["state"]),
            pick(r.json?.dispatch || {}, ["status"]),
          ]
            .filter((v) => typeof v === "string" && v.trim())
            .map((v) => v.trim().toLowerCase());
          const hasConflictingActiveState = allReceiptStates.some(
            (st) => !/^(?:failed|rejected|invalid|error|aborted|cancelled|canceled|denied|blocked_untrusted)$/.test(st)
          );
          const hasConflictingStage = Boolean(normFailedStage && !STRICT_PRE_LAUNCH_REJECTION_CODES.has(normFailedStage));
          const provenPreSpawnFailure = Boolean(
            r.json &&
            !r.timedOut &&
            !r.ok &&
            !hasConflictingActiveState &&
            !hasResiduals &&
            allRetHandles.length === 0 &&
            !gwErr &&
            !netConflict &&
            !hasConflictingStage &&
            (
              STRICT_PRE_LAUNCH_REJECTION_CODES.has(structuredCode) ||
              STRICT_PRE_LAUNCH_REJECTION_CODES.has(normFailedStage)
            )
          );
          if (!provenPreSpawnFailure) {
            return {
              ok: false,
              ambiguous: true,
              dispatchId: null,
              terminal: null,
              effectiveAgent: orcaAgent,
              effectiveModel: recordedColdModel,
              effectiveModelResolved: true,
              effectiveEffort: passedEffort,
              effectiveEffortResolved: true,
              lastClearedInfo,
              attempts,
              error: `worker-start failed without dispatchId or strict pre-launch rejection proof (code=${structuredCode || "none"}, stage=${failedStage || "none"}, state=${state || "none"}: ${lastError}) — refusing blind retry/reuse on worktree`,
              failedStage,
              raw: sanitizeText(r.raw || r.stderr, { maxLen: 300 }),
            };
          }
        }
      }

      if (attempt < START_RETRIES && !gwErr) {
        if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
          return {
            ok: false,
            deadlineExceeded: true,
            dispatchId: null,
            terminal: null,
            effectiveAgent: orcaAgent,
            effectiveModel: model || null,
            effectiveEffort: passedEffort,
            lastClearedInfo,
            attempts,
            error: "reached step deadline before worker-start retry",
          };
        }
        warn(`worker-start '${step.title}' not ready (stage=${failedStage}, error=${lastError}). Retrying via --retry-of (attempt ${attempt + 1}/${START_RETRIES})...`);
        const effectivePrevDisp = dispatchId || retryOf;
        if (effectivePrevDisp) {
          const tu = orca(["orchestration", "task-update", "--id", taskId, "--status", "failed", "--result", `coldStart retry: ${lastError}`], {
            deadlineAt,
            timeoutMs: clampTimeoutToDeadline(deadlineAt, 5000),
          });
          if (!tu.ok) {
            return {
              ok: false,
              ambiguous: true,
              dispatchId: effectivePrevDisp,
              terminal: null,
              effectiveAgent: orcaAgent,
              effectiveModel: model || null,
              effectiveEffort: passedEffort,
              lastClearedInfo,
              attempts,
              error: `task-update before --retry-of failed: ${sanitizeText(tu.stderr || tu.raw, { maxLen: 200 })}`,
              failedStage,
            };
          }
          retryOf = effectivePrevDisp;
        }
        const remDelay = deadlineAt != null && Number.isFinite(deadlineAt) ? (deadlineAt - Date.now()) : START_RETRY_DELAY_MS;
        if (remDelay > 0) sleepMs(Math.min(START_RETRY_DELAY_MS, remDelay));
        continue;
      }

      return {
        ok: false,
        ambiguous: false,
        dispatchId: dispatchId || retryOf || null,
        terminal: null,
        effectiveAgent: orcaAgent,
        effectiveModel: model || null,
        effectiveEffort: passedEffort,
        lastClearedInfo,
        attempts,
        error: `stage=${failedStage} error=${lastError}`,
        failedStage,
        gatewayError: gwErr,
        promptBlocked: pbErr,
        raw: sanitizeText(r.raw || r.stderr, { maxLen: 300 }),
      };
    }
    return { ok: false, ambiguous: false, dispatchId: null, terminal: null, lastClearedInfo, attempts, error: "worker-start exhausted retries" };
  }

  function startWorker(step, taskId, wtSelector = null, launchOpts = {}) {
    const effDeadline = launchOpts.deadlineAt ?? null;
    // P1-02: Hard gate at the entry of `startWorker` BEFORE any worktree/CLI probes!
    if (effDeadline != null && Number.isFinite(effDeadline) && Date.now() >= effDeadline) {
      const effAgent = launchOpts.agentOverride ?? agentOf(step);
      return {
        ok: false,
        deadlineExceeded: true,
        dispatchId: null,
        terminal: null,
        effectiveAgent: effAgent,
        effectiveModel: null,
        effectiveModelResolved: true,
        effectiveEffort: null,
        effectiveEffortResolved: true,
        attempts: [],
        error: "reached step deadline before startWorker",
      };
    }
    const manual = manualStart(step, taskId, wtSelector, launchOpts);
    const manualAttempts = Array.isArray(manual?.attempts) ? manual.attempts : [];
    if (manual) {
      if (manual.ok || manual.ambiguous || manual.deadlineExceeded) return manual;
      if (manual.manualAbortedAfterDispatch && manual.supersededDispatchId) {
        const effDeadline = launchOpts.deadlineAt ?? null;
        const tu = orca(["orchestration", "task-update", "--id", taskId, "--status", "failed", "--result", manual.error || "manual dispatch aborted"], {
          deadlineAt: effDeadline,
          timeoutMs: clampTimeoutToDeadline(effDeadline, 5000),
        });
        if (!tu.ok) {
          return {
            ok: false,
            ambiguous: true,
            dispatchId: manual.supersededDispatchId,
            terminal: null,
            attempts: manualAttempts,
            error: `task-update failed after stopping manual dispatch (${manual.supersededDispatchId}): ${sanitizeText(tu.stderr || tu.raw, { maxLen: 200 })}`,
          };
        }
        return coldStart(step, taskId, wtSelector, {
          ...launchOpts,
          retryOfDispatchId: manual.supersededDispatchId,
          priorAttempts: manualAttempts,
          initialClearedInfo: manual.lastClearedInfo || null,
        });
      }
    }
    return coldStart(step, taskId, wtSelector, {
      ...launchOpts,
      priorAttempts: manualAttempts,
      initialClearedInfo: manual?.lastClearedInfo || null,
    });
  }

  function workerVitals(taskId, terminal, dispatchId, { deadlineAt = null } = {}) {
    const v = { status: null, settled: false, outcome: null, lastBusyMs: 0, heartbeatMs: 0, preview: null, agentWait: null, dispatchMismatch: false, deadlineExceeded: false };
    if (deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
      v.deadlineExceeded = true;
      return v;
    }
    const d = orca(["orchestration", "dispatch-show", "--task", taskId], { deadlineAt });
    if (d.deadlineExceeded) {
      v.deadlineExceeded = true;
      return v;
    }
    const dd = pick(res(d.json), ["dispatch"]) || {};
    const shownDispId = pick(dd, ["id", "dispatchId", "dispatch_id"]) || null;

    // P0-01: When active `dispatchId` is known, require an explicit positive ID match!
    // If `dispatch-show` returns a different or missing dispatchId, NEVER settle from any unattributed source!
    const matchesActiveDispatch = dispatchId ? Boolean(shownDispId && shownDispId === dispatchId) : true;
    if (!matchesActiveDispatch) {
      v.dispatchMismatch = true;
    } else {
      v.status = pick(dd, ["status"]);
      const beat = pick(dd, ["last_heartbeat_at"]);
      if (beat) {
        const norm = beat.includes("T") ? beat : beat.replace(" ", "T") + (beat.endsWith("Z") ? "" : "Z");
        const t = Date.parse(norm);
        if (!Number.isNaN(t)) { v.lastBusyMs = t; v.heartbeatMs = t; }
      }
    }

    let tinfo = null;
    let wsOutcome = null;
    let wsExplicitMatch = false;
    if (terminal) {
      const ts = orca(["terminal", "show", "--terminal", terminal], { deadlineAt });
      if (ts.deadlineExceeded) { v.deadlineExceeded = true; return v; }
      tinfo = pick(res(ts.json), ["terminal"]) || {};
    } else if (dispatchId) {
      const wsResp = orca(["orchestration", "worker-show", "--dispatch", dispatchId], { deadlineAt });
      if (wsResp.deadlineExceeded) { v.deadlineExceeded = true; return v; }
      const ws = res(wsResp.json);
      const wsDispId = pick(ws, ["dispatchId", "dispatch_id", "id"]) || pick(ws.dispatch || {}, ["id", "dispatchId"]) || null;
      if (wsDispId && wsDispId !== dispatchId) {
        v.dispatchMismatch = true;
      } else {
        wsExplicitMatch = Boolean(wsDispId && wsDispId === dispatchId);
        // Only read terminal observation if dispatch-show matched OR worker-show explicitly proved dispatchId!
        if (matchesActiveDispatch || wsExplicitMatch) {
          tinfo = pick(ws, ["terminal"]) || {};
          v.agentWait = pick(ws.observation || {}, ["agentWait", "agent_wait"])
            ?? pick(ws, ["agentWait", "agent_wait"])
            ?? pick(tinfo, ["agentWait", "agent_wait"])
            ?? null;
        }
        // P0-01: NEVER adopt status or outcome from `worker-show` unless `wsDispId === dispatchId` AND `!v.dispatchMismatch`!
        if (!v.dispatchMismatch && wsExplicitMatch) {
          const wsStatus = pick(ws, ["status", "state"]) || pick(ws.dispatch || {}, ["status", "state"]);
          if (!v.status && wsStatus) v.status = wsStatus;
          wsOutcome = pick(ws, ["outcome", "result"]) || pick(ws.dispatch || {}, ["outcome", "result"]) || null;
        }
      }
    }

    if (tinfo) {
      v.lastBusyMs = Math.max(v.lastBusyMs, pick(tinfo, ["lastOutputAt"]) || 0);
      v.preview = pick(tinfo, ["preview"]) ?? null;
    }

    // P0-01: Refuse ANY settlement when `v.dispatchMismatch` is true!
    if (v.dispatchMismatch) {
      v.settled = false;
      v.outcome = null;
      return v;
    }

    if (v.status === "failed") {
      v.settled = true;
      v.outcome = "failed";
    } else if (/^(completed|settled|done)$/.test(v.status || "")) {
      v.settled = true;
      let resolvedOutcome = (matchesActiveDispatch && pick(dd, ["outcome", "result"])) || (wsExplicitMatch ? wsOutcome : null) || null;
      if (!resolvedOutcome) {
        const tl = orca(["orchestration", "task-list", "--run", runId], { deadlineAt });
        if (!tl.deadlineExceeded) {
          const t = (pick(res(tl.json), ["tasks"]) || []).find((x) => x.id === taskId);
          let r = t?.result;
          if (typeof r === "string") { try { r = JSON.parse(r); } catch { r = null; } }
          const resDispId = pick(r || {}, ["dispatchId", "dispatch_id"]) || null;
          // P0-01: When `dispatchId` is set, REQUIRE `resDispId === dispatchId` (never accept unattributed task result!)
          if (r && (dispatchId ? (resDispId === dispatchId) : true)) {
            resolvedOutcome = pick(r, ["outcome", "result"]) || null;
          }
        }
      }
      v.outcome = resolvedOutcome || "unknown";
    }
    return v;
  }

  return {
    resolveOrca, orca, ensureWorktree, resolveWorktree, resolveWorktreePath,
    startWorker, workerVitals, wtSource,
    getOrcaBin: () => orcaBin,
    getRunId: () => runId, setRunId: (id) => { runId = id; },
    getWt: () => wt, getWtPin: () => wtPin, getWtPath: () => wtPath, getCreatedWorktree: () => createdWorktree,
  };
}
