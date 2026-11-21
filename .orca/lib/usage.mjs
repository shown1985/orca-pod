// Post-run token usage collector for Claude Code & Codex session transcripts.
// Display-only: never alters pipeline outcomes or exit codes.

import { readFileSync, existsSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const fmtDurMs = (ms) => {
  const s = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(ss).padStart(2, "0")}s`;
};

export const claudeProjectSlug = (p) => String(p || "").replace(/[^A-Za-z0-9]/g, "-") || "-";
export const normPath = (p) => String(p || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");

export function parseClaudeSession(text) {
  const out = { agent: "claude", cwd: null, userText: "", events: [], subagent: false, firstTs: null, lastTs: null, stepId: null };
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const parsed = j.timestamp ? Date.parse(j.timestamp) : NaN;
    const ts = Number.isFinite(parsed) ? parsed : null;
    if (j.cwd && !out.cwd) out.cwd = j.cwd;
    if (ts != null) {
      if (out.firstTs == null || ts < out.firstTs) out.firstTs = ts;
      if (out.lastTs == null || ts > out.lastTs) out.lastTs = ts;
    }
    if (j.type === "user" && j.message) {
      const c = j.message.content;
      const txt = typeof c === "string" ? c
        : Array.isArray(c) ? c.filter((b) => b && typeof b.text === "string").map((b) => b.text).join("\n") : "";
      if (txt && out.userText.length < 40000) out.userText += txt + "\n";
    }
    if (j.type === "assistant" && j.message?.usage && ts != null) {
      const u = j.message.usage;
      out.events.push({ ts, in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 });
    }
  }
  return out;
}

export function parseCodexSession(text) {
  const out = { agent: "codex", cwd: null, userText: "", events: [], subagent: false, firstTs: null, lastTs: null, stepId: null };
  const oldEvents = [], countEvents = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const parsed = j.timestamp ? Date.parse(j.timestamp) : NaN;
    const ts = Number.isFinite(parsed) ? parsed : null;
    const cwd = j.payload?.cwd || j.cwd;
    if (cwd && !out.cwd) out.cwd = cwd;
    if (ts != null) {
      if (out.firstTs == null || ts < out.firstTs) out.firstTs = ts;
      if (out.lastTs == null || ts > out.lastTs) out.lastTs = ts;
    }
    if (j.type === "event_msg" && j.payload?.type === "user_message" && typeof j.payload.message === "string") {
      if (out.userText.length < 40000) out.userText += j.payload.message + "\n";
    }
    const isNew = j.type === "event_msg" && j.payload?.type === "token_count" && j.payload.info;
    const usage = isNew ? j.payload.info.last_token_usage : (j.type === "token_usage_record" ? j.payload?.usage : null);
    if (usage && ts != null) {
      const inp = usage.input_tokens || 0, cached = usage.cached_input_tokens || 0;
      (isNew ? countEvents : oldEvents).push({ ts, in: Math.max(0, inp - cached), out: usage.output_tokens || 0, cr: cached, cw: usage.cache_write_input_tokens || 0 });
    }
  }
  out.events = countEvents.length ? countEvents : oldEvents;
  return out;
}

export function stepSignatures(stepsIn, outPathFn) {
  const sigs = [];
  for (const s of stepsIn) {
    if (!s?.id || !s.spec) continue;
    const head = String(s.spec).split(/{(?:out|reads|tasks)}/)[0];
    sigs.push({ id: s.id, out: s.writes ? outPathFn(s.writes) : "", spec: head.length >= 12 ? head : "" });
  }
  return sigs;
}

export function matchSessionToStep(session, sigs) {
  if (!session.userText) return null;
  const heads = new Set(), outs = new Set();
  for (const g of sigs) {
    if (g.spec && session.userText.includes(g.spec)) heads.add(g.id);
    if (g.out && session.userText.includes(g.out)) outs.add(g.id);
  }
  if (heads.size === 1) return [...heads][0];
  if (heads.size > 1) return null;
  return outs.size === 1 ? [...outs][0] : null;
}

export function attributeAndSum({ steps: stepsIn, sessions, runStart, reportTs, adapters }) {
  const WIN_PRE = 60000, WIN_POST = 120000;
  const zero = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  const addEvs = (acc, evs, lo, hi) => {
    for (const e of evs) if (e.ts >= lo && e.ts <= hi) {
      acc.in += e.in; acc.out += e.out; acc.cacheRead += e.cr; acc.cacheWrite += e.cw;
    }
  };
  const perStep = {};
  for (const st of stepsIn) perStep[st.id] = { ...zero, total: 0, note: null };
  const unattributed = { ...zero, count: 0 };

  const byStep = new Map();
  for (const s of sessions) {
    if (s.subagent || !s.stepId) continue;
    if (!byStep.has(s.stepId)) byStep.set(s.stepId, []);
    byStep.get(s.stepId).push(s);
  }

  for (const st of stepsIn) {
    const u = perStep[st.id];
    if (st.status === "pending" || st.status === "skipped") continue;
    if (st.startedAt != null && st.startedAt < runStart - WIN_PRE) { u.note = "prior run"; continue; }
    const mine = byStep.get(st.id) || [];
    if (!mine.length) { u.note = adapters.includes(st.agent) ? "no session found" : "no adapter"; continue; }
    const lo = (st.startedAt ?? mine[0]?.firstTs ?? runStart) - WIN_PRE;
    const hi = st.endedAt != null ? st.endedAt + WIN_POST : reportTs;
    const notes = [];
    let extras = 0;
    for (const x of mine) {
      if (x.lastTs != null && x.lastTs < lo) { addEvs(u, x.events, runStart, reportTs); extras++; }
      else addEvs(u, x.events, lo, hi);
    }
    if (st.endedAt == null) notes.push("unfinished");
    if (extras) notes.push(`+${extras} extra attempt${extras > 1 ? "s" : ""}`);
    u.note = notes.join("; ") || null;
  }

  for (const s of sessions) {
    if (!s.subagent || s.lastTs == null || s.lastTs < runStart - WIN_PRE) continue;
    const hits = stepsIn.filter((st) => st.startedAt != null && st.endedAt != null &&
      s.lastTs >= st.startedAt - WIN_PRE && s.lastTs <= st.endedAt + WIN_POST);
    if (hits.length === 1) addEvs(perStep[hits[0].id], s.events, -Infinity, Infinity);
    else { unattributed.count++; addEvs(unattributed, s.events, -Infinity, Infinity); }
  }

  const totals = { ...zero };
  for (const id in perStep) {
    const u = perStep[id];
    u.total = u.in + u.out + u.cacheRead + u.cacheWrite;
    for (const k of ["in", "out", "cacheRead", "cacheWrite"]) totals[k] += u[k];
  }
  for (const k of ["in", "out", "cacheRead", "cacheWrite"]) totals[k] += unattributed[k];
  totals.total = totals.in + totals.out + totals.cacheRead + totals.cacheWrite;
  return { perStep, totals, unattributed };
}

export function renderUsageSection(r) {
  const n = (v) => (v == null ? "—" : v.toLocaleString("en-US"));
  const lines = [
    `## Run ${r.runId} — ${r.endedIso} — ${r.overall} — ${String(r.objective || "").slice(0, 80)} (${r.config})`,
    "",
    "| Step | Agent | In | Out | Cache R | Cache W | Total | Duration | Note |",
    "|---|---|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const row of r.rows) {
    const u = row.usage;
    lines.push(`| ${row.title} | ${row.agent} | ${u ? n(u.in) : "—"} | ${u ? n(u.out) : "—"} | ${u ? n(u.cacheRead) : "—"} | ${u ? n(u.cacheWrite) : "—"} | ${u ? n(u.total) : "—"} | ${row.durationMs != null ? fmtDurMs(row.durationMs) : "—"} | ${row.note || u?.note || ""} |`);
  }
  const t = r.totals;
  lines.push(`| **Total** | | ${n(t.in)} | ${n(t.out)} | ${n(t.cacheRead)} | ${n(t.cacheWrite)} | **${n(t.total)}** | ${r.runDurationMs != null ? fmtDurMs(r.runDurationMs) : "—"} | ${r.unattributedCount ? `${r.unattributedCount} subagent file(s) unattributed` : ""} |`, "");
  return lines.join("\n");
}

export function reportUsage({ STATUS, wt, wtPath, allSteps, outPath, statusDir, writeStatusTo, log, warn }) {
  if (!STATUS?.meta?.runId) return;
  const runStart = STATUS.meta.startedAt || STATUS.meta.updatedAt;
  if (!runStart) return;
  const nowTs = Date.now();
  const adapters = ["claude", "codex"];
  const wtNorm = normPath(wtPath || ".");
  const home = process.env.ORCA_FLOW_USAGE_HOME || homedir();
  const sessions = [];
  const mtimeOk = (p) => { try { const m = statSync(p).mtimeMs; return m >= runStart - 300000 && m <= nowTs + 60000; } catch { return false; } };

  const readSessions = (dir, parseFn, isSubFn) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(dir, name);
      if (!mtimeOk(p)) continue;
      let s; try { s = parseFn(readFileSync(p, "utf8")); } catch { continue; }
      if (!s.events.length || !s.cwd || normPath(s.cwd) !== wtNorm) continue;
      if (isSubFn(name)) s.subagent = true;
      sessions.push(s);
    }
  };

  const claudeRoot = join(home, ".claude", "projects");
  if (existsSync(claudeRoot)) {
    const readClaudeDir = (dir) => {
      readSessions(dir, parseClaudeSession, (n) => n.startsWith("agent-"));
      try {
        for (const e of readdirSync(dir, { withFileTypes: true }))
          if (e.isDirectory()) readSessions(join(dir, e.name, "subagents"), parseClaudeSession, () => true);
      } catch {}
    };
    const slugDir = join(claudeRoot, claudeProjectSlug(wtPath || "."));
    if (existsSync(slugDir)) readClaudeDir(slugDir);
    else {
      try {
        for (const d of readdirSync(claudeRoot, { withFileTypes: true }))
          if (d.isDirectory()) readClaudeDir(join(claudeRoot, d.name));
      } catch {}
    }
  }

  const codexRoot = join(home, ".codex", "sessions");
  if (existsSync(codexRoot)) {
    const day = new Date(runStart - 300000); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - 1);
    const end = new Date(nowTs); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 1);
    for (let i = 0; i < 40 && day <= end; i++) {
      const dir = join(codexRoot, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
      if (existsSync(dir)) readSessions(dir, parseCodexSession, () => false);
      day.setDate(day.getDate() + 1);
    }
  }

  const sigs = stepSignatures(allSteps, outPath);
  for (const s of sessions) if (!s.subagent) s.stepId = matchSessionToStep(s, sigs);
  const engine = attributeAndSum({
    steps: STATUS.steps.map((st) => ({ id: st.id, agent: st.agent, startedAt: st.startedAt, endedAt: st.endedAt, status: st.status })),
    sessions, runStart, reportTs: nowTs, adapters,
  });

  for (const st of STATUS.steps) {
    const u = engine.perStep[st.id];
    st.usage = u && u.total > 0 ? { in: u.in, out: u.out, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, total: u.total, note: u.note } : null;
  }
  if (engine.totals.total > 0) STATUS.meta.usage = engine.totals;

  try {
    const mdPath = join(statusDir(), "USAGE.md");
    const had = existsSync(mdPath);
    const lastEnd = Math.max(0, ...STATUS.steps.map((s) => s.endedAt || 0));
    const section = renderUsageSection({
      runId: STATUS.meta.runId, endedIso: new Date(nowTs).toLocaleString("en-US"),
      overall: STATUS.overall, objective: STATUS.meta.objective, config: STATUS.meta.config,
      rows: STATUS.steps.map((st) => ({ title: st.id, agent: st.agent, usage: st.usage, durationMs: st.durationMs, note: engine.perStep[st.id]?.note })),
      totals: engine.totals, unattributedCount: engine.unattributed.count,
      runDurationMs: lastEnd ? lastEnd - STATUS.meta.startedAt : null,
    });
    appendFileSync(mdPath, (had ? "" : `# Token usage — ${wt || wtPath || "worktree"}\n\nPer-run token consumption per pipeline step (Claude Code / Codex).\n\n`) + section + "\n", "utf8");
    log(`[usage] ${mdPath} — run total ${engine.totals.total.toLocaleString("en-US")} tokens`);
  } catch (e) { warn(`[usage] USAGE.md write failed (${e.message})`); }
  try { STATUS.meta.updatedAt = nowTs; writeStatusTo(statusDir(), STATUS); } catch {}
}
