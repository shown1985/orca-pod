// Orca CLI wrapper, worktree resolution/auto-create, worker warm/cold start,
// and per-task vitals + parked-prompt detection. Zero external dependencies.

import { spawnSync } from "node:child_process";
import readline from "node:readline";

export const IS_WIN = process.platform === "win32";
export const MODEL_FLAG_RE = /(^|\s)(--model|-m)(\s|=|$)/;
export const isKiroCmd = (a) => a === "kiro-cli" || a.startsWith("kiro-cli ");

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
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { rl.close(); } catch {} resolve(v); };
    rl.on("close", () => done(""));
    rl.question(question, (a) => done(String(a ?? "")));
  });
}

const PARKED_PROMPTS = [
  { sig: "requires confirmation for this command", label: "a permission-rule confirmation" },
  { sig: "Do you want to proceed?", label: "a permission confirmation" },
  { sig: "Quick safety check", label: "the folder-trust check" },
  { sig: "Yes, I trust this folder", label: "the folder-trust check" },
  { sig: "Update available", label: "a CLI update prompt" },
];
export const parkedPromptOf = (preview) =>
  typeof preview === "string" ? PARKED_PROMPTS.find((p) => preview.includes(p.sig)) || null : null;

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

export function createOrcaClient({ cfg, opt, objective, autoRun, agentOf, modelOf, writeStatus, log, warn, die }) {
  let orcaBin = null;
  let runId = null;
  let wt = null;
  let wtPath = null;
  let wtWarned = false;
  let createdWorktree = null;
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
      const detail = String(c.json?.error || c.stderr || c.raw || "orca worktree create failed").slice(0, 600);
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

  function agentCommand(agent, model = null) {
    if (model && !MODEL_FLAG_RE.test(agent) && !isKiroCmd(agent)) agent += ` --model ${model}`;
    else if (model && isKiroCmd(agent) && !MODEL_FLAG_RE.test(agent)) warn(`step model "${model}" ignored: kiro-cli has no model selection.`);
    const isClaude = agent === "claude" || agent.startsWith("claude ");
    if (!isClaude) return agent;
    let cmd = agent;
    if (autoRun && !cmd.includes("--permission-mode") && !cmd.includes("--dangerously-skip-permissions"))
      cmd += " --permission-mode bypassPermissions";
    if (!autoRun) return cmd;
    return IS_WIN ? `cmd /c "set CLAUDE_AFK_TIMEOUT_MS=60000&& ${cmd}"` : `env CLAUDE_AFK_TIMEOUT_MS=60000 ${cmd}`;
  }

  function warmTerminal(agent, model = null, wtSelector = null) {
    const startedAt = Date.now();
    const c = orca(["terminal", "create", "--worktree", wtSelector || resolveWorktree(), "--command", agentCommand(agent, model)]);
    const cr = res(c.json);
    const handle = pick(cr, ["handle", "terminalHandle"]) || pick(cr.terminal || {}, ["handle"]);
    if (!c.ok || !handle) { warn(`terminal create ('${agent}') failed: ${c.stderr || c.raw || "no handle"}; cold-starting instead.`); return null; }
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
        return handle;
      }
    }
    warn(`agent '${agent}' TUI not ready within ${WARMUP_TIMEOUT_MS}ms; cold-starting instead.`);
    orca(["terminal", "close", "--terminal", handle]);
    return null;
  }

  function manualStart(step, taskId, wtSelector = null) {
    const term = warmTerminal(agentOf(step), modelOf(step), wtSelector);
    if (!term) return null;
    const d = orca(["orchestration", "dispatch", "--task", taskId, "--to", term, "--run", runId]);
    const dr = res(d.json);
    const dispatchId = pick(pick(dr, ["dispatch"]) || {}, ["id"]) || pick(dr, ["dispatchId", "dispatch_id"]);
    if (!d.ok || !dispatchId) { warn(`tracking dispatch '${step.title}' failed: ${d.stderr || d.raw}`); orca(["terminal", "close", "--terminal", term]); return null; }
    const p = orca(["orchestration", "dispatch", "--task", taskId, "--to", term, "--run", runId, "--dry-run", "--return-preamble"]);
    const preamble = pick(res(p.json), ["preamble"]);
    if (!p.ok || !preamble) { warn(`preamble fetch '${step.title}' failed: ${p.stderr || p.raw}`); orca(["terminal", "close", "--terminal", term]); return null; }
    const s = orca(["terminal", "send", "--terminal", term, "--text", preamble.split("ctx_dryrun").join(dispatchId), "--enter"]);
    if (!s.ok) { warn(`terminal send '${step.title}' failed: ${s.stderr || s.raw}`); orca(["terminal", "close", "--terminal", term]); return null; }
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
        if (pv == null || before == null || pv !== before) return { dispatchId, terminal: term };
      }
      if (attempt < SEND_ATTEMPTS) {
        const nudge = attempt === 1;
        warn(`no sign the '${step.title}' prompt was consumed; ${nudge ? "nudging with Enter" : "re-sending"} (${attempt + 1}/${SEND_ATTEMPTS})`);
        const s2 = nudge
          ? orca(["terminal", "send", "--terminal", term, "--text", "", "--enter"])
          : orca(["terminal", "send", "--terminal", term, "--text", preamble.split("ctx_dryrun").join(dispatchId), "--enter"]);
        if (!s2.ok) { warn(`re-send '${step.title}' failed: ${s2.stderr || s2.raw}`); break; }
      }
    }
    warn(`prompt for '${step.title}' was not consumed after ${SEND_ATTEMPTS} attempt(s); cold-starting instead.`);
    orca(["terminal", "close", "--terminal", term]);
    return null;
  }

  function coldStart(step, taskId, wtSelector = null) {
    let retryOf = null;
    const model = modelOf(step);
    for (let attempt = 0; attempt <= START_RETRIES; attempt++) {
      const args = ["orchestration", "worker-start", "--task", taskId, "--run", runId, "--worktree", wtSelector || resolveWorktree(), "--agent", agentOf(step)];
      if (model) args.push("--model", model);
      if (step.effort) args.push("--effort", step.effort);
      if (step.startTimeoutMs) args.push("--timeout-ms", String(step.startTimeoutMs));
      if (retryOf) args.push("--retry-of", retryOf);
      const r = orca(args);
      const result = res(r.json);
      const dispatchId = pick(result, ["dispatchId", "dispatch_id"]);
      const state = pick(result, ["state"]);
      const receiptTurnStart = pick(result, ["turnStart", "turn_start"]) || null;
      if (r.ok && (state === "ready" || !state)) return { dispatchId, terminal: null, dispatchState: state || null, receiptTurnStart };
      const lastError = pick(result, ["lastError"]) || r.stderr || "unknown error";
      const failedStage = pick(result, ["failedStage", "stage"]);
      if (dispatchId && state === "failed") orca(["orchestration", "worker-release", "--dispatch", dispatchId]);
      if (attempt < START_RETRIES) {
        warn(`worker-start '${step.title}' not ready (stage=${failedStage}, error=${lastError}). Retrying via --retry-of (attempt ${attempt + 1}/${START_RETRIES})...`);
        retryOf = dispatchId || retryOf;
        sleepMs(START_RETRY_DELAY_MS);
        continue;
      }
      die(`worker-start '${step.title}' failed after ${attempt + 1} attempt(s): stage=${failedStage} error=${lastError}. Raw: ${r.raw || r.stderr}`);
    }
  }

  function startWorker(step, taskId, wtSelector = null) {
    return manualStart(step, taskId, wtSelector) || coldStart(step, taskId, wtSelector);
  }

  function workerVitals(taskId, terminal, dispatchId) {
    const v = { status: null, settled: false, outcome: null, lastBusyMs: 0, heartbeatMs: 0, preview: null, agentWait: null };
    const d = orca(["orchestration", "dispatch-show", "--task", taskId]);
    const dd = pick(res(d.json), ["dispatch"]) || {};
    v.status = pick(dd, ["status"]);
    const beat = pick(dd, ["last_heartbeat_at"]);
    if (beat) {
      const norm = beat.includes("T") ? beat : beat.replace(" ", "T") + (beat.endsWith("Z") ? "" : "Z");
      const t = Date.parse(norm);
      if (!Number.isNaN(t)) { v.lastBusyMs = t; v.heartbeatMs = t; }
    }
    let tinfo = null;
    if (terminal) tinfo = pick(res(orca(["terminal", "show", "--terminal", terminal]).json), ["terminal"]) || {};
    else if (dispatchId) {
      const ws = res(orca(["orchestration", "worker-show", "--dispatch", dispatchId]).json);
      tinfo = pick(ws, ["terminal"]) || {};
      v.agentWait = pick(ws, ["agentWait", "agent_wait"]) ?? pick(tinfo, ["agentWait", "agent_wait"]) ?? null;
    }
    v.lastBusyMs = Math.max(v.lastBusyMs, pick(tinfo, ["lastOutputAt"]) || 0);
    v.preview = pick(tinfo, ["preview"]) ?? null;
    if (v.status === "failed") { v.settled = true; v.outcome = "failed"; }
    else if (/^(completed|settled|done)$/.test(v.status || "")) {
      v.settled = true;
      const tl = orca(["orchestration", "task-list", "--run", runId]);
      const t = (pick(res(tl.json), ["tasks"]) || []).find((x) => x.id === taskId);
      let r = t?.result;
      if (typeof r === "string") { try { r = JSON.parse(r); } catch { r = null; } }
      v.outcome = pick(r || {}, ["outcome", "result"]) || "succeeded";
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
