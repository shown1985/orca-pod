// Orca CLI wrapper, worktree resolution/auto-create, worker warm/cold start,
// strict dispatch fencing & release verification, and per-dispatch vitals.
// Zero external dependencies (Node >= 18).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import readline from "node:readline";
import { WATCHDOG_PARKED_PROMPTS, detectGatewayDisconnect, detectPromptBlocked } from "../watchdog.mjs";
import { sanitizeText } from "./sanitize.mjs";

export const IS_WIN = process.platform === "win32";
export const MODEL_FLAG_RE = /(^|\s)(--model|-m)(\s|=|$)/;
export const EFFORT_FLAG_RE = /(^|\s)--effort(\s|=|$)/;
export const isKiroCmd = (a) => a === "kiro-cli" || a.startsWith("kiro-cli ");
export const isAgyCmd = (a) => /^(?:agy|antigravity)(?:\s|$)/.test(String(a || "").trim());

export function normalizeOrcaWorkerAgent(agentCmd) {
  const base = String(agentCmd || "").trim().split(/\s+/)[0];
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
    const list = Array.isArray(parsed?.trustedWorkspaces) ? parsed.trustedWorkspaces : [];
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
  let cmd = String(agent || "").trim();
  if (model && !MODEL_FLAG_RE.test(cmd) && !isKiroCmd(cmd)) cmd += ` --model ${model}`;
  else if (model && isKiroCmd(cmd) && !MODEL_FLAG_RE.test(cmd)) warn(`step model "${model}" ignored: kiro-cli has no model selection.`);

  if (isAgyCmd(cmd)) {
    if (effort && !EFFORT_FLAG_RE.test(cmd)) cmd += ` --effort ${effort}`;
    if (autoRun && !cmd.includes("--dangerously-skip-permissions") && !/(^|\s)--mode(\s|=|$)/.test(cmd)) {
      cmd += " --dangerously-skip-permissions";
    }
    const trustDirs = [worktreePath, ...(extraTrustedDirs || [])].filter(Boolean);
    if (trustDirs.length && !cmd.includes("--settings")) {
      const settingsArg = buildAgySettingsArg(trustDirs, { isWin, settingsDir });
      if (settingsArg) cmd += ` ${settingsArg}`;
    }
    return cmd;
  }

  const isClaude = cmd === "claude" || cmd.startsWith("claude ");
  if (!isClaude) return cmd;
  if (autoRun && !cmd.includes("--permission-mode") && !cmd.includes("--dangerously-skip-permissions"))
    cmd += " --permission-mode bypassPermissions";
  if (!autoRun) return cmd;
  return isWin ? `cmd /c "set CLAUDE_AFK_TIMEOUT_MS=60000&& ${cmd}"` : `env CLAUDE_AFK_TIMEOUT_MS=60000 ${cmd}`;
}

export const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; };
export const res = (j) => (j && j.result) ? j.result : (j || {});

export function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
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

export function verifyStopAndReleaseReceipt(orcaFn, dispatchId) {
  const stopRes = orcaFn(["orchestration", "worker-stop", "--dispatch", dispatchId]);
  const stopJson = res(stopRes.json);
  const stopState = pick(stopJson, ["state", "status", "stopStatus"]);
  const procAction = pick(stopJson, ["processAction"]);
  const helpers = Array.isArray(stopJson.helpers) ? stopJson.helpers : [];
  const liveHelper = helpers.some((h) => h && (h.keptOpen === true || h.running === true || h.status === "running"));
  const provenStopped = Boolean(
    stopRes.ok &&
    !liveHelper &&
    stopState !== "stop_unknown" &&
    procAction !== "stop_unknown" &&
    (stopState === "stopped" || stopState === "fenced" || procAction === "closed_agent_terminal")
  );
  if (!provenStopped) {
    return {
      ok: false,
      reason: liveHelper
        ? `worker-stop (${dispatchId}) left kept-open/running helper(s)`
        : `worker-stop (${dispatchId}) lacked positive stop confirmation (${sanitizeText(stopRes.stderr || stopRes.raw || stopState || "unconfirmed", { maxLen: 200 })})`,
    };
  }

  const relRes = orcaFn(["orchestration", "worker-release", "--dispatch", dispatchId]);
  const relJson = res(relRes.json);
  const relAction = pick(relJson, ["action", "status", "releaseStatus"]);
  if (!relRes.ok || relAction === "release_unknown" || relAction === "release_pending" || relAction === "retained") {
    return {
      ok: false,
      reason: `worker-release (${dispatchId}) returned ${relAction || sanitizeText(relRes.stderr || relRes.raw || "unconfirmed", { maxLen: 200 })} — terminal ownership not yet released`,
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

  function resolveOrca() {
    const bases = process.env.ORCA_CLI_COMMAND ? [process.env.ORCA_CLI_COMMAND] : ["orca", "orca-dev", "orca-ide"];
    const cands = IS_WIN ? bases.flatMap((b) => (b.includes(".") ? [b] : [`${b}.cmd`, `${b}.exe`, b])) : bases;
    for (const c of cands) {
      const p = spawnSync(c, ["--version"], { encoding: "utf8" });
      if (!p.error) { orcaBin = c; return c; }
    }
    die("Could not find the orca CLI. Set ORCA_CLI_COMMAND.");
  }

  function orca(args, { timeoutMs } = {}) {
    const full = args.includes("--json") ? args : [...args, "--json"];
    const r = spawnSync(orcaBin, full, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    const raw = (r.stdout || "").trim();
    let json = null;
    for (const line of raw.split(/\r?\n/).reverse()) {
      const s = line.trim();
      if (s.startsWith("{") || s.startsWith("[")) { try { json = JSON.parse(s); break; } catch {} }
    }
    if (!json && raw) { try { json = JSON.parse(raw); } catch {} }
    return { ok: r.status === 0, json, raw, stderr: (r.stderr || "").trim() };
  }

  function worktreeCandidates() {
    const l = orca(["worktree", "list"]);
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

  function resolveWorktree(soft = false) {
    if (wt) return wt;
    if (wtPin) {
      const shown = orca(["worktree", "show", "--worktree", wtPin]);
      const p = pick(res(shown.json).worktree || {}, ["path"]);
      if (shown.ok && p) { wt = wtPin; wtPath = p; return wt; }
      const cands = worktreeCandidates();
      const msg = `worktree "${wtPin}" (from ${wtSource()}) does not exist.\n${wtFixHint()}${cands ? `\nAvailable worktrees:\n${cands}` : ""}`;
      if (soft) { if (!wtWarned) { wtWarned = true; warn(msg); } return null; }
      die(msg);
    }
    const w = orca(["worktree", "current"]);
    const entry = pick(res(w.json), ["worktree"]) || res(w.json);
    const p = pick(entry, ["path"]);
    if (w.ok && p) { wt = `path:${p}`; wtPath = p; return wt; }
    if (soft) return null;
    const cands = worktreeCandidates();
    die(`Could not auto-detect the worktree: the invoking directory is not inside an Orca-managed worktree.\n${wtFixHint()}${cands ? `\nAvailable worktrees:\n${cands}` : ""}`);
  }

  function resolveWorktreePath(soft = false) {
    if (wtPath != null) return wtPath;
    const sel = resolveWorktree(soft);
    if (!sel) return null;
    if (sel.startsWith("path:")) wtPath = sel.slice("path:".length);
    else {
      const w = orca(["worktree", "show", "--worktree", sel]);
      wtPath = pick(res(w.json).worktree || {}, ["path"]) || null;
    }
    return wtPath;
  }

  function agentCommand(agent, model = null, { effort = null, worktreePath = null } = {}) {
    return buildAgentCommand(agent, model, { autoRun, effort, worktreePath, warn, isWin: IS_WIN });
  }

  function resolveEffectiveWtPath(wtSelector, explicitPath) {
    if (explicitPath) return explicitPath;
    if (wtSelector && wtSelector.startsWith("path:")) return wtSelector.slice("path:".length);
    return resolveWorktreePath(true);
  }

  function warmTerminal(agent, model = null, wtSelector = null, { effort = null, worktreePath = null } = {}) {
    const startedAt = Date.now();
    const effWtPath = resolveEffectiveWtPath(wtSelector, worktreePath);
    const cmd = agentCommand(agent, model, { effort, worktreePath: effWtPath });
    const c = orca(["terminal", "create", "--worktree", wtSelector || resolveWorktree(), "--command", cmd]);
    const cr = res(c.json);
    const handle = pick(cr, ["handle", "terminalHandle"]) || pick(cr.terminal || {}, ["handle"]);
    if (!c.ok || !handle) {
      warn(`terminal create ('${agent}') failed: ${sanitizeText(c.stderr || c.raw || "no handle", { maxLen: 240 })}; cold-starting instead.`);
      return { ok: false, uncreated: true, handle: null };
    }
    const QUIET_MS = 8000, MIN_UPTIME_MS = 12000, POLL_MS = 3000;
    let lastOut = -1, quietSince = Date.now();
    while (Date.now() - startedAt < WARMUP_TIMEOUT_MS) {
      sleepMs(POLL_MS);
      writeStatus();
      const s = orca(["terminal", "show", "--terminal", handle]);
      const out = pick(pick(res(s.json), ["terminal"]) || {}, ["lastOutputAt"]) || 0;
      if (out !== lastOut) { lastOut = out; quietSince = Date.now(); }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= MIN_UPTIME_MS && Date.now() - quietSince >= QUIET_MS) {
        log(`  warmed ${agent} terminal ${handle} (${Math.round(elapsed / 1000)}s)`);
        return { ok: true, handle, command: cmd };
      }
    }
    warn(`agent '${agent}' TUI not ready within ${WARMUP_TIMEOUT_MS}ms; closing terminal before fallback.`);
    const cl = orca(["terminal", "close", "--terminal", handle]);
    if (!cl.ok) {
      return {
        ok: false,
        ambiguous: true,
        handle,
        error: `terminal close (${handle}) after warmup timeout did not confirm: ${sanitizeText(cl.stderr || cl.raw, { maxLen: 200 })}`,
      };
    }
    return { ok: false, uncreated: false, closedCleanly: true, handle: null };
  }

  function closeManualSessionSafely(dispatchId, term, stageLabel) {
    if (dispatchId) {
      const ws = orca(["orchestration", "worker-stop", "--dispatch", dispatchId]);
      const wsJson = res(ws.json);
      const stopState = pick(wsJson, ["state", "status", "stopStatus"]);
      const procAction = pick(wsJson, ["processAction"]);
      if (!ws.ok || stopState === "stop_unknown" || procAction === "stop_unknown") {
        return {
          ok: false,
          reason: `worker-stop (${dispatchId}) after ${stageLabel} did not confirm: ${sanitizeText(ws.stderr || ws.raw || stopState || "unconfirmed", { maxLen: 200 })}`,
        };
      }
    }
    if (term) {
      const cl = orca(["terminal", "close", "--terminal", term]);
      if (!cl.ok) {
        return {
          ok: false,
          reason: `terminal close (${term}) after ${stageLabel} did not confirm: ${sanitizeText(cl.stderr || cl.raw || "unconfirmed", { maxLen: 200 })}`,
        };
      }
    }
    return { ok: true, reason: null };
  }

  function manualStart(step, taskId, wtSelector = null, launchOpts = {}) {
    const effAgent = launchOpts.agentOverride ?? agentOf(step);
    const effModel = launchOpts.modelOverride !== undefined ? launchOpts.modelOverride : modelOf(step);
    const effEffort = launchOpts.effortOverride !== undefined ? launchOpts.effortOverride : (step.effort || null);
    const effectivePassedModel = (effModel && !isKiroCmd(effAgent)) ? effModel : null;
    const effectivePassedEffort = isAgyCmd(effAgent) ? (effEffort || null) : null;

    const warmed = warmTerminal(effAgent, effModel, wtSelector, { effort: effEffort, worktreePath: launchOpts.worktreePath || null });
    if (!warmed.ok) {
      if (warmed.ambiguous) {
        return {
          ok: false,
          ambiguous: true,
          dispatchId: null,
          terminal: warmed.handle,
          error: warmed.error,
          attempts: [{ attempt: 1, mode: "manual", agent: effAgent, model: effectivePassedModel, effort: effectivePassedEffort, ok: false, error: warmed.error }],
        };
      }
      return null; // Safe to try coldStart when no terminal exists or warmup terminal closed cleanly
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
          error: "task-update to ready failed before manual dispatch",
        };
      }
    }

    const d = orca(["orchestration", "dispatch", "--task", taskId, "--to", term, "--run", runId]);
    const dr = res(d.json);
    const dispatchId = pick(pick(dr, ["dispatch"]) || {}, ["id"]) || pick(dr, ["dispatchId", "dispatch_id"]);
    if (!d.ok || !dispatchId || !String(dispatchId).trim()) {
      warn(`tracking dispatch '${step.title}' failed: ${sanitizeText(d.stderr || d.raw || "missing dispatchId", { maxLen: 240 })}`);
      const cl = closeManualSessionSafely(dispatchId || null, term, "dispatch failure");
      if (!cl.ok || (d.ok && !dispatchId)) {
        return {
          ok: false,
          ambiguous: true,
          dispatchId: dispatchId || null,
          terminal: term,
          error: cl.reason || "orchestration dispatch returned ok without a dispatchId",
        };
      }
      return null;
    }

    const p = orca(["orchestration", "dispatch", "--task", taskId, "--to", term, "--run", runId, "--dry-run", "--return-preamble"]);
    const preamble = pick(res(p.json), ["preamble"]);
    if (!p.ok || !preamble) {
      warn(`preamble fetch '${step.title}' failed: ${sanitizeText(p.stderr || p.raw, { maxLen: 240 })}`);
      const cl = closeManualSessionSafely(dispatchId, term, "preamble failure");
      if (!cl.ok) return { ok: false, ambiguous: true, dispatchId, terminal: term, error: cl.reason };
      return { ok: false, manualAbortedAfterDispatch: true, supersededDispatchId: dispatchId, error: "preamble fetch failed" };
    }

    const s = orca(["terminal", "send", "--terminal", term, "--text", preamble.split("ctx_dryrun").join(dispatchId), "--enter"]);
    if (!s.ok) {
      warn(`terminal send '${step.title}' failed: ${sanitizeText(s.stderr || s.raw, { maxLen: 240 })}`);
      const cl = closeManualSessionSafely(dispatchId, term, "send failure");
      if (!cl.ok) return { ok: false, ambiguous: true, dispatchId, terminal: term, error: cl.reason };
      return { ok: false, manualAbortedAfterDispatch: true, supersededDispatchId: dispatchId, error: "terminal send failed" };
    }

    sleepMs(3000);
    orca(["terminal", "send", "--terminal", term, "--text", "", "--enter"]);
    const START_GRACE_MS = cfg.defaults?.startGraceMs ?? 90000;
    const SEND_ATTEMPTS = cfg.defaults?.sendAttempts ?? 3;
    const previewOf = (h) => pick(pick(res(orca(["terminal", "show", "--terminal", h]).json), ["terminal"]) || {}, ["preview"]) ?? null;
    const before = previewOf(term);
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
      const deadline = Date.now() + START_GRACE_MS;
      while (Date.now() < deadline) {
        sleepMs(4000);
        writeStatus();
        const pv = previewOf(term);
        if (pv == null || before == null || pv !== before) {
          return {
            ok: true,
            dispatchId: String(dispatchId).trim(),
            terminal: term,
            effectiveAgent: effAgent,
            effectiveModel: effectivePassedModel,
            effectiveEffort: effectivePassedEffort,
            attempts: [{ attempt, mode: "manual", agent: effAgent, model: effectivePassedModel, effort: effectivePassedEffort, dispatchId: String(dispatchId).trim(), state: "manual", ok: true }],
          };
        }
      }
      if (attempt < SEND_ATTEMPTS) {
        const nudge = attempt === 1;
        warn(`no sign the '${step.title}' prompt was consumed; ${nudge ? "nudging with Enter" : "re-sending"} (${attempt + 1}/${SEND_ATTEMPTS})`);
        const s2 = nudge
          ? orca(["terminal", "send", "--terminal", term, "--text", "", "--enter"])
          : orca(["terminal", "send", "--terminal", term, "--text", preamble.split("ctx_dryrun").join(dispatchId), "--enter"]);
        if (!s2.ok) { warn(`re-send '${step.title}' failed: ${sanitizeText(s2.stderr || s2.raw, { maxLen: 240 })}`); break; }
      }
    }
    warn(`prompt for '${step.title}' was not consumed after ${SEND_ATTEMPTS} attempt(s); stopping manual dispatch before cold-start.`);
    const cl = closeManualSessionSafely(dispatchId, term, "unconsumed prompt");
    if (!cl.ok) {
      return { ok: false, ambiguous: true, dispatchId, terminal: term, error: cl.reason };
    }
    return { ok: false, manualAbortedAfterDispatch: true, supersededDispatchId: dispatchId, error: "manual prompt not consumed" };
  }

  function coldStart(step, taskId, wtSelector = null, launchOpts = {}) {
    let retryOf = launchOpts.retryOfDispatchId || null;
    const effAgent = launchOpts.agentOverride ?? agentOf(step);
    const orcaAgent = normalizeOrcaWorkerAgent(effAgent);
    const model = launchOpts.modelOverride !== undefined ? launchOpts.modelOverride : modelOf(step);
    const effort = launchOpts.effortOverride !== undefined ? launchOpts.effortOverride : (step.effort || null);
    const effWtPath = resolveEffectiveWtPath(wtSelector, launchOpts.worktreePath || null);
    const attempts = [];

    // P1-04: `orca orchestration worker-start` cannot pass session `--settings '{"trustedWorkspaces":...}'`.
    // Outside synthetic ORCA_TEST_MODE (or when ORCA_ENFORCE_COLD_AGY_TRUST=1), verify read-only
    // `~/.gemini/antigravity-cli/settings.json` trust before booting an untrusted cold-start dialog!
    const enforceColdAgyTrust = process.env.ORCA_ENFORCE_COLD_AGY_TRUST === "1" || process.env.ORCA_TEST_MODE !== "1";
    if (orcaAgent === "antigravity" && enforceColdAgyTrust && effWtPath && !isAgyWorkspaceTrusted(effWtPath)) {
      const trustErr = `antigravity supervised cold-start cannot inject session --settings trustedWorkspaces for untrusted worktree "${effWtPath}" (warm terminal required or add parent directory to trustedWorkspaces)`;
      return {
        ok: false,
        ambiguous: false,
        dispatchId: null,
        terminal: null,
        effectiveAgent: orcaAgent,
        effectiveModel: model || null,
        effectiveEffort: null,
        attempts: [{ attempt: 1, mode: "cold", agent: orcaAgent, model: model || null, effort: null, dispatchId: null, state: "blocked_untrusted", ok: false, error: trustErr }],
        error: trustErr,
        failedStage: "workspace_trust",
        promptBlocked: true,
      };
    }

    for (let attempt = 0; attempt <= START_RETRIES; attempt++) {
      const startReqId = `start-${process.pid}-${++startReqSeq}`;
      const args = [
        "orchestration", "worker-start",
        "--task", taskId,
        "--run", runId,
        "--worktree", wtSelector || resolveWorktree(),
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
      if (step.startTimeoutMs) args.push("--timeout-ms", String(step.startTimeoutMs));
      if (retryOf) args.push("--retry-of", retryOf);

      const r = orca(args);
      const result = res(r.json);
      const rawDispId = pick(result, ["dispatchId", "dispatch_id"]) || pick(result.dispatch || {}, ["id"]);
      const dispatchId = rawDispId && String(rawDispId).trim() ? String(rawDispId).trim() : null;
      const state = pick(result, ["state"]);
      const receiptTurnStart = pick(result, ["turnStart", "turn_start"]) || null;

      if (r.ok && (state === "ready" || !state)) {
        // P0-01: Require non-empty dispatchId on every successful start receipt!
        if (!dispatchId) {
          const noIdErr = "worker-start returned ok without a dispatchId — refusing unattributed worker on worktree";
          attempts.push({ attempt: attempt + 1, requestId: startReqId, mode: "cold", agent: orcaAgent, model: model || null, effort: passedEffort, dispatchId: null, state: state || "ok_missing_id", ok: false, error: noIdErr });
          return {
            ok: false,
            ambiguous: true,
            dispatchId: null,
            terminal: null,
            effectiveAgent: orcaAgent,
            effectiveModel: model || null,
            effectiveEffort: passedEffort,
            attempts,
            error: noIdErr,
            failedStage: "missing_dispatch_id",
          };
        }
        attempts.push({ attempt: attempt + 1, requestId: startReqId, mode: "cold", agent: orcaAgent, model: model || null, effort: passedEffort, dispatchId, state: state || "ready", ok: true });
        return {
          ok: true,
          dispatchId,
          terminal: null,
          dispatchState: state || null,
          receiptTurnStart,
          effectiveAgent: orcaAgent,
          effectiveModel: model || null,
          effectiveEffort: passedEffort,
          attempts,
        };
      }

      const rawErr = pick(result, ["lastError"]) || r.json?.error || r.stderr || "unknown error";
      const lastError = sanitizeText(String(rawErr), { maxLen: 260 });
      const failedStage = pick(result, ["failedStage", "stage"]) || null;
      const residual = pick(result, ["residualResources", "effects"]);
      const hasResiduals = Array.isArray(residual) ? residual.length > 0 : Boolean(residual && typeof residual === "object" && Object.keys(residual).length > 0);
      attempts.push({
        attempt: attempt + 1,
        requestId: startReqId,
        mode: "cold",
        agent: orcaAgent,
        model: model || null,
        effort: passedEffort,
        dispatchId,
        state: state || "failed",
        ok: false,
        failedStage,
        error: lastError,
      });

      // P0-01: Even when `state === "failed"`, Orca may retain an active terminal (`release_pending` / `retained`).
      // ALWAYS run `verifyStopAndReleaseReceipt` when `dispatchId` exists and refuse reuse if not proven released!
      if (dispatchId) {
        const sr = verifyStopAndReleaseReceipt(orca, dispatchId);
        if (!sr.ok) {
          return {
            ok: false,
            ambiguous: true,
            dispatchId,
            terminal: null,
            effectiveAgent: orcaAgent,
            effectiveModel: model || null,
            effectiveEffort: passedEffort,
            attempts,
            error: `${sr.reason} (after worker-start ${state || failedStage || "failure"}: ${lastError})`,
            failedStage,
            raw: sanitizeText(r.raw || r.stderr, { maxLen: 300 }),
          };
        }
      } else if (state === "outcome_unknown" || hasResiduals || r.ok) {
        return {
          ok: false,
          ambiguous: true,
          dispatchId: null,
          terminal: null,
          effectiveAgent: orcaAgent,
          effectiveModel: model || null,
          effectiveEffort: passedEffort,
          attempts,
          error: `worker-start returned ${state || "residualResources"} without dispatchId (${lastError}) — refusing blind retry on worktree`,
          failedStage,
          raw: sanitizeText(r.raw || r.stderr, { maxLen: 300 }),
        };
      }

      const combinedText = `${lastError} ${sanitizeText(String(r.raw || ""), { maxLen: 300 })}`;
      const gwErr = Boolean(detectGatewayDisconnect(combinedText));
      const pbErr = Boolean(detectPromptBlocked(combinedText));
      if (attempt < START_RETRIES && !gwErr) {
        warn(`worker-start '${step.title}' not ready (stage=${failedStage}, error=${lastError}). Retrying via --retry-of (attempt ${attempt + 1}/${START_RETRIES})...`);
        if (dispatchId) {
          const tu = orca(["orchestration", "task-update", "--id", taskId, "--status", "failed", "--result", `coldStart retry: ${lastError}`]);
          if (!tu.ok) {
            return {
              ok: false,
              ambiguous: true,
              dispatchId,
              terminal: null,
              effectiveAgent: orcaAgent,
              effectiveModel: model || null,
              effectiveEffort: passedEffort,
              attempts,
              error: `task-update before --retry-of failed: ${sanitizeText(tu.stderr || tu.raw, { maxLen: 200 })}`,
              failedStage,
            };
          }
          retryOf = dispatchId;
        }
        sleepMs(START_RETRY_DELAY_MS);
        continue;
      }

      return {
        ok: false,
        ambiguous: false,
        dispatchId: dispatchId || null,
        terminal: null,
        effectiveAgent: orcaAgent,
        effectiveModel: model || null,
        effectiveEffort: passedEffort,
        attempts,
        error: `stage=${failedStage} error=${lastError}`,
        failedStage,
        gatewayError: gwErr,
        promptBlocked: pbErr,
        raw: sanitizeText(r.raw || r.stderr, { maxLen: 300 }),
      };
    }
    return { ok: false, ambiguous: false, dispatchId: null, terminal: null, attempts, error: "worker-start exhausted retries" };
  }

  function startWorker(step, taskId, wtSelector = null, launchOpts = {}) {
    const manual = manualStart(step, taskId, wtSelector, launchOpts);
    if (manual) {
      if (manual.ok || manual.ambiguous) return manual;
      if (manual.manualAbortedAfterDispatch && manual.supersededDispatchId) {
        const tu = orca(["orchestration", "task-update", "--id", taskId, "--status", "failed", "--result", manual.error || "manual dispatch aborted"]);
        if (!tu.ok) {
          return {
            ok: false,
            ambiguous: true,
            dispatchId: manual.supersededDispatchId,
            terminal: null,
            error: `task-update failed after stopping manual dispatch (${manual.supersededDispatchId}): ${sanitizeText(tu.stderr || tu.raw, { maxLen: 200 })}`,
          };
        }
        return coldStart(step, taskId, wtSelector, { ...launchOpts, retryOfDispatchId: manual.supersededDispatchId });
      }
    }
    return coldStart(step, taskId, wtSelector, launchOpts);
  }

  function workerVitals(taskId, terminal, dispatchId) {
    const v = { status: null, settled: false, outcome: null, lastBusyMs: 0, heartbeatMs: 0, preview: null, agentWait: null, dispatchMismatch: false };
    const d = orca(["orchestration", "dispatch-show", "--task", taskId]);
    const dd = pick(res(d.json), ["dispatch"]) || {};
    const shownDispId = pick(dd, ["id", "dispatchId", "dispatch_id"]) || null;

    // P0-01: When active `dispatchId` is known, require an explicit positive ID match!
    // Never accept an unattributed task-level dispatch record missing `id`.
    const matchesActiveDispatch = dispatchId ? (shownDispId === dispatchId) : true;
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
    if (terminal) {
      tinfo = pick(res(orca(["terminal", "show", "--terminal", terminal]).json), ["terminal"]) || {};
    } else if (dispatchId) {
      const ws = res(orca(["orchestration", "worker-show", "--dispatch", dispatchId]).json);
      const wsDispId = pick(ws, ["dispatchId", "dispatch_id", "id"]) || pick(ws.dispatch || {}, ["id", "dispatchId"]) || null;
      if (!wsDispId || wsDispId === dispatchId) {
        tinfo = pick(ws, ["terminal"]) || {};
        const wsStatus = pick(ws, ["status", "state"]) || pick(ws.dispatch || {}, ["status", "state"]);
        if (!v.status && wsStatus) v.status = wsStatus;
        wsOutcome = pick(ws, ["outcome", "result"]) || pick(ws.dispatch || {}, ["outcome", "result"]) || null;
        v.agentWait = pick(ws.observation || {}, ["agentWait", "agent_wait"])
          ?? pick(ws, ["agentWait", "agent_wait"])
          ?? pick(tinfo, ["agentWait", "agent_wait"])
          ?? null;
      }
    }

    v.lastBusyMs = Math.max(v.lastBusyMs, pick(tinfo, ["lastOutputAt"]) || 0);
    v.preview = pick(tinfo, ["preview"]) ?? null;

    if (v.status === "failed") {
      v.settled = true;
      v.outcome = "failed";
    } else if (/^(completed|settled|done)$/.test(v.status || "")) {
      v.settled = true;
      let resolvedOutcome = (matchesActiveDispatch && pick(dd, ["outcome", "result"])) || wsOutcome || null;
      if (!resolvedOutcome) {
        const tl = orca(["orchestration", "task-list", "--run", runId]);
        const t = (pick(res(tl.json), ["tasks"]) || []).find((x) => x.id === taskId);
        let r = t?.result;
        if (typeof r === "string") { try { r = JSON.parse(r); } catch { r = null; } }
        const resDispId = pick(r || {}, ["dispatchId", "dispatch_id"]) || null;
        if (r && (!dispatchId || !resDispId || resDispId === dispatchId)) {
          resolvedOutcome = pick(r, ["outcome", "result"]) || null;
        }
      }
      // P0-01: NEVER default a missing outcome to "succeeded" — missing outcome is "unknown"!
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
