// Optional webhook notification delivery (Slack, Telegram, Teams, WhatsApp, generic).
// Fails soft (latches dead after first delivery error) so notifications never block a run.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fmtDurMs } from "./usage.mjs";

const NOTIFY_SCRIPT = `
const req = JSON.parse(require("fs").readFileSync(0, "utf8"));
const u = new URL(req.url);
const mod = u.protocol === "http:" ? require("http") : require("https");
const data = Buffer.from(JSON.stringify(req.body));
const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443),
  path: u.pathname + u.search, method: "POST",
  headers: Object.assign({ "content-type": "application/json", "content-length": data.length }, req.headers || {}) },
  (res) => { res.resume(); res.on("end", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) console.error("HTTP " + res.statusCode);
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
  }); });
r.setTimeout(9000, () => r.destroy(new Error("timeout after 9s")));
r.on("error", (e) => { console.error(e.message); process.exit(1); });
r.end(data);
`;

export function createNotifier({ here, objective, outPath, statusOf, statusDir, getStatus, getRunId, getGroups, warn }) {
  const state = { on: false, dead: false, cfg: null, events: new Set() };

  function load() {
    const file = process.env.ORCA_FLOW_NOTIFY_FILE || join(here, "notify.json");
    if (!existsSync(file)) return;
    try { state.cfg = JSON.parse(readFileSync(file, "utf8")); }
    catch (e) { warn(`[notify] disabled: could not parse ${file} (${e.message})`); return; }
    const c = state.cfg;
    if (c.enabled === false || !String(c.provider ?? "").trim() || !String(c.url ?? "").trim()) return;
    try { new URL(c.url); } catch { warn(`[notify] disabled: "url" is not a valid URL`); return; }
    const providers = ["slack", "telegram", "teams", "whatsapp", "generic"];
    if (!providers.includes(c.provider)) { warn(`[notify] disabled: unknown provider "${c.provider}"`); return; }
    const need = { telegram: ["chatId"], whatsapp: ["token", "to"] }[c.provider] || [];
    const missing = need.filter((k) => !String(c[k] ?? "").trim());
    if (missing.length) { warn(`[notify] disabled: ${c.provider} needs ${missing.map((k) => `"${k}"`).join(", ")}`); return; }
    state.events = new Set(Array.isArray(c.events) ? c.events : ["step", "run"]);
    if (!state.events.size) return;
    state.on = true;
    const unknown = [...state.events].filter((e) => e !== "step" && e !== "run");
    if (unknown.length) warn(`[notify] unknown event(s) ignored: ${unknown.join(", ")}`);
  }

  function send(kind, payload, text) {
    if (!state.on || state.dead || !state.events.has(kind)) return;
    const p = state.cfg.provider;
    const headers = p === "whatsapp" ? { Authorization: `Bearer ${state.cfg.token}` } : {};
    const body = p === "generic" ? payload
      : p === "telegram" ? { chat_id: state.cfg.chatId, text }
      : p === "whatsapp" ? { messaging_product: "whatsapp", to: state.cfg.to, type: "text", text: { body: text } }
      : p === "teams" ? { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive",
          content: { type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text, wrap: true }] } }] }
      : { text };
    let r;
    try {
      r = spawnSync(process.execPath, ["-e", NOTIFY_SCRIPT],
        { input: JSON.stringify({ url: state.cfg.url, headers, body }), timeout: 12000, encoding: "utf8" });
    } catch (e) { r = { error: e }; }
    if (r.error || r.status !== 0) {
      state.dead = true;
      const reason = r.error ? (r.error.code || r.error.message) : ((r.stderr || "").trim().split(/\r?\n/).pop() || `exit ${r.status}`);
      warn(`[notify] disabled: delivery failed (${reason}) — further notifications skipped`);
    }
  }

  function notifyStep(m) {
    if (!state.on || !state.events.has("step")) return;
    const st = statusOf(m.step.id);
    const text = `[orca-flow] Step "${m.step.title}" ${String(m.outcome || "unknown").toUpperCase()} in ${fmtDurMs(st?.durationMs ?? 0)} (attempt ${st?.attempt ?? 1}) -> ${outPath(m.step.writes)}${m.note ? ` (${m.note})` : ""}`;
    send("step", {
      event: "step", run: getRunId(), objective, step: m.step.id, title: m.step.title,
      status: m.outcome, attempt: st?.attempt ?? null, durationMs: st?.durationMs ?? null,
      note: m.note || null, artifact: outPath(m.step.writes),
    }, text);
  }

  function notifyRun(overall) {
    const runId = getRunId();
    if (!state.on || !state.events.has("run") || !runId) return;
    const STATUS = getStatus();
    const groups = getGroups();
    const durMs = Date.now() - (STATUS?.meta?.startedAt ?? Date.now());
    const obj = objective.length > 80 ? objective.slice(0, 77) + "..." : objective;
    let text = `[orca-flow] Run ${runId} ${String(overall).toUpperCase()} in ${fmtDurMs(durMs)} — "${obj}" · artifacts: ${statusDir()}`;
    if (overall !== "succeeded") {
      const firstOf = (st) => (STATUS?.steps || []).find((s) => s.status === st);
      const bad = (overall === "still-running" ? firstOf("running") : null) || firstOf("failed") || firstOf("running") || firstOf("unknown");
      if (bad) {
        const gi = groups.findIndex((g) => g.some((s) => s.id === bad.id));
        const next = gi >= 0 ? (groups[gi + 1] || [])[0] : null;
        const target = bad.status === "running" ? (next || bad) : bad;
        text += ` · stuck at: ${bad.id} — continue with: node .orca/flow.mjs --from ${target.id} "<objective>"`;
      }
    }
    send("run", { event: "run", run: runId, objective, status: overall, durationMs: durMs }, text);
  }

  return { state, load, send, notifyStep, notifyRun };
}
