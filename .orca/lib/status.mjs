// Live status dashboard writer, artifact JSONP snapshots, progress parser,
// run history archiving/listing, and --status-preview fixture renderer.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, statSync, rmdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeText } from "./sanitize.mjs";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const STATUS_HTML = readFileSync(join(LIB_DIR, "status-template.html"), "utf8");
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "skipped", "unknown"]);
const IS_WIN = process.platform === "win32";

export function parseProgress(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^(\s*)-\s*\[([ xX~])\]\s*(.*)$/);
    if (!m) continue;
    out.push({ status: m[2] === " " ? "todo" : m[2] === "~" ? "doing" : "done", level: m[1].length >= 2 ? 1 : 0, text: m[3].trim() });
  }
  return out.length ? out : null;
}

export function parseStatusJs(file) {
  try {
    const m = readFileSync(file, "utf8").match(/window\.__STATUS=([\s\S]*?);window\.__ON_STATUS/);
    return m ? JSON.parse(m[1]) : null;
  } catch { return null; }
}

export const statusJsOf = (S) => `window.__STATUS=${JSON.stringify(S)};window.__ON_STATUS&&window.__ON_STATUS();`;
export const writeStatusTo = (dir, S) => writeFileSync(join(dir, "status.js"), statusJsOf(S));

export const artifactJsOf = (name, payload) =>
  `window.__ARTIFACTS=window.__ARTIFACTS||{};window.__ARTIFACTS[${JSON.stringify(name)}]=${JSON.stringify(payload)};window.__ON_ARTIFACT&&window.__ON_ARTIFACT(${JSON.stringify(name)});`;

export function writeArtifactSnapshotTo(dir, step) {
  if (!step.writes) return;
  const payload = { file: step.writes, exists: false, bytes: 0, mtime: null, text: "" };
  try {
    const st = statSync(join(dir, step.writes));
    Object.assign(payload, { exists: true, bytes: st.size, mtime: Math.round(st.mtimeMs), text: readFileSync(join(dir, step.writes), "utf8") });
  } catch {}
  writeFileSync(join(dir, step.writes + ".js"), artifactJsOf(step.writes, payload));
}

export function shouldOpenStatusPage({ cfg = {}, opt = {} } = {}) {
  if (opt?.noOpenStatus) return false;
  if (opt?.openStatus === true) return true;
  return Boolean(cfg?.defaults?.openStatus ?? false);
}

export function createStatusManager({
  artDir, objective, configFile, cfg, opt, allSteps, getSteps, enabledIds, isParallel, agentOf,
  getWt, getWtPin, getWtPath, getRunId, outPath, notifyRun, log, warn,
}) {
  let resumedLedgerRunKey = null;
  let resumedLineageId = null;
  let resumedLineageRunKeys = [];
  const STATUS = {
    meta: { runId: null, ledgerRunKey: null, lineageId: null, lineageRunKeys: [], objective, config: configFile, worktree: null, startedAt: null, updatedAt: null },
    overall: "running",
    steps: allSteps.map((s) => ({
      id: s.id, title: s.title, agent: agentOf(s), writes: s.writes || null, progress: s.progress || null,
      parallel: isParallel.has(s.id), status: enabledIds.has(s.id) ? "pending" : "skipped",
      attempt: 0, startedAt: null, endedAt: null, durationMs: null, note: null, tasks: null,
    })),
    artifacts: [],
  };
  let statusFailed = false;
  let artFailed = false;

  const statusDir = () => join(getWtPath() || ".", artDir);
  const statusOf = (id) => STATUS.steps.find((x) => x.id === id) || null;
  const statusSet = (id, patch) => { const st = statusOf(id); if (st) Object.assign(st, patch); };

  function writeStatus() {
    if (statusFailed) return;
    try { STATUS.meta.updatedAt = Date.now(); writeStatusTo(statusDir(), STATUS); }
    catch (e) { statusFailed = true; warn(`status page write failed (${e.message}); continuing without it.`); }
  }

  function writeArtifactSnapshot(step) {
    if (artFailed || statusFailed || !step.writes) return;
    try { writeArtifactSnapshotTo(statusDir(), step); }
    catch (e) { artFailed = true; warn(`artifact snapshot write failed (${e.message}); viewer disabled for this run.`); }
  }

  function nextRunDirName() {
    const runsRoot = join(getWtPath() || ".", artDir, "runs");
    let max = 0;
    try { for (const e of readdirSync(runsRoot)) { const m = /^(\d{4,})-/.exec(e); if (m) max = Math.max(max, Number(m[1])); } } catch {}
    const t = new Date(), p2 = (n) => String(n).padStart(2, "0");
    return { runsRoot, name: `${String(max + 1).padStart(4, "0")}-${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}` };
  }

  function copyRunFiles(srcDir, destDir, label) {
    let copied = 0;
    try {
      mkdirSync(destDir, { recursive: true });
      for (const e of readdirSync(srcDir, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        try { copyFileSync(join(srcDir, e.name), join(destDir, e.name)); copied++; }
        catch (e2) { warn(`[history] could not copy ${e.name} ${label}: ${e2.message}`); }
      }
    } catch (e) { warn(`[history] ${label} failed: ${e.message}`); }
    return copied;
  }

  function archiveCurrentRun() {
    const dir = join(getWtPath() || ".", artDir);
    let hasFiles = false;
    try { hasFiles = readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile()); } catch { return; }
    if (!hasFiles) return;
    const { runsRoot, name } = nextRunDirName();
    const dest = join(runsRoot, name);
    const n = copyRunFiles(dir, dest, "(archive)");
    if (n > 0) {
      log(`[history] archived previous run's artifacts -> ${artDir}/runs/${name}/ (${n} files)`);
      // Prevent stale ISSUES.json / ISSUES.md from a prior run in this worktree leaking into a fresh run
      if (!opt.from) {
        for (const stale of ["ISSUES.json", "ISSUES.md"]) {
          try { rmSync(join(dir, stale), { force: true }); } catch {}
        }
      }
    } else { try { rmdirSync(dest); } catch {} }
  }

  function listRuns() {
    const dir = join(getWtPath() || ".", artDir);
    const out = [];
    const cur = parseStatusJs(join(dir, "status.js"));
    if (cur) out.push({ label: "(current)", dir: null, S: cur });
    const archived = [];
    try {
      for (const e of readdirSync(join(dir, "runs"), { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const S = parseStatusJs(join(dir, "runs", e.name, "status.js"));
        if (S) archived.push({ label: e.name, dir: join(dir, "runs", e.name), S });
      }
    } catch {}
    archived.sort((a, b) => b.label.localeCompare(a.label));
    return [...out, ...archived].slice(0, 10);
  }

  function printRunList(entries) {
    log("Previous runs in this worktree:");
    entries.forEach((e, i) => {
      const succ = (e.S.steps || []).filter((s) => s.status === "succeeded").length;
      log(`  ${i + 1}) ${e.label} · "${String(e.S.meta?.objective ?? "").slice(0, 60)}" · ${succ}/${(e.S.steps || []).length} steps · ${String(e.S.overall ?? "?").toUpperCase()}`);
    });
  }

  function statusBegin(id) {
    const st = statusOf(id);
    if (!st) return;
    st.status = "running"; st.attempt += 1;
    st.startedAt = Date.now(); st.endedAt = null; st.durationMs = null; st.note = null;
    writeStatus();
  }

  function statusEnd(id, outcome, note) {
    const st = statusOf(id);
    if (!st) return;
    st.status = outcome === "succeeded" ? "succeeded"
      : (outcome === "failed" || outcome === "blocked") ? "failed"
      : outcome === "still-running" ? "running" : "unknown";
    st.endedAt = Date.now();
    if (st.startedAt) st.durationMs = st.endedAt - st.startedAt;
    st.note = note ? sanitizeText(note, { maxLen: 280 }) : null;
    writeStatus();
  }

  function finishStatus(overall) {
    STATUS.overall = overall;
    STATUS.artifacts = getSteps().map((s) => outPath(s.writes));
    writeStatus();
    notifyRun(overall);
  }

  function refreshProgress(step) {
    if (!step.progress) return;
    try {
      const tasks = parseProgress(readFileSync(join(statusDir(), step.progress), "utf8"));
      if (tasks) statusSet(step.id, { tasks });
    } catch {}
  }

  function loadPreviousStatus(dir = statusDir()) {
    try {
      const prev = parseStatusJs(join(dir, "status.js"));
      if (!prev || !Array.isArray(prev.steps) || prev.meta?.config !== STATUS.meta.config) return;
      const isPreviewResume = Boolean(process.env.ORCA_STATUS_PREVIEW_RESUME);
      // P0-03: Require BOTH previous and current objective to exist and match exactly (never adopt objective-less status)
      if (!isPreviewResume) {
        if (!prev.meta?.objective || !STATUS.meta.objective || prev.meta.objective !== STATUS.meta.objective) return;
      }
      if (prev.meta?.ledgerRunKey) resumedLedgerRunKey = prev.meta.ledgerRunKey;
      resumedLineageId = prev.meta?.lineageId || prev.meta?.ledgerRunKey || null;
      if (Array.isArray(prev.meta?.lineageRunKeys) && prev.meta.lineageRunKeys.length) {
        resumedLineageRunKeys = [...new Set(prev.meta.lineageRunKeys.filter((x) => typeof x === "string" && x.trim()))];
      } else if (resumedLedgerRunKey) {
        resumedLineageRunKeys = [resumedLedgerRunKey];
      }
      for (const ps of prev.steps) {
        const cur = statusOf(ps.id);
        if (!cur) continue;
        if (cur.status === "skipped" && TERMINAL_STATUSES.has(ps.status)) {
          Object.assign(cur, {
            status: ps.status,
            agent: ps.agent || cur.agent,
            model: ps.model || cur.model || null,
            family: ps.family || cur.family || null,
            executedFamilies: Array.isArray(ps.executedFamilies) ? ps.executedFamilies : (ps.family ? [ps.family] : []),
            provenanceVerified: false,
            attempt: Math.max(cur.attempt, ps.attempt || 0),
            startedAt: ps.startedAt ?? null,
            endedAt: ps.endedAt ?? null,
            durationMs: ps.durationMs ?? null,
            note: ps.note ?? null,
          });
        } else if (cur.status === "pending" && prev.overall !== "succeeded") {
          cur.attempt = Math.max(cur.attempt, ps.attempt || 0);
          if (Array.isArray(ps.executedFamilies) && ps.executedFamilies.length) {
            cur.executedFamilies = [...ps.executedFamilies];
          }
        }
      }
    } catch {}
  }

  function openStatusPage() {
    if (statusFailed || !shouldOpenStatusPage({ cfg, opt })) return;
    const file = join(statusDir(), "status.html");
    if (process.env.ORCA_STATUS_OPEN_LOG) {
      try { writeFileSync(process.env.ORCA_STATUS_OPEN_LOG, `${file}\n`, { flag: "a" }); } catch {}
      return;
    }
    const r = IS_WIN ? spawnSync("explorer.exe", [file], { timeout: 10000, stdio: "ignore" })
      : process.platform === "darwin" ? spawnSync("open", [file], { timeout: 10000, stdio: "ignore" })
      : spawnSync("xdg-open", [file], { timeout: 10000, stdio: "ignore" });
    if (r.error) warn(`could not auto-open the status page (${r.error.message}) — open it yourself: ${file}`);
  }

  function initStatus() {
    STATUS.meta.runId = getRunId();
    STATUS.meta.worktree = getWt() || getWtPin() || "(auto-detect)";
    STATUS.meta.startedAt = Date.now();
    loadPreviousStatus();
    for (const st of STATUS.steps) refreshProgress(st);
    for (const st of STATUS.steps) if (st.writes && existsSync(join(statusDir(), st.writes))) writeArtifactSnapshot(st);
    try { writeFileSync(join(statusDir(), "status.html"), STATUS_HTML); }
    catch (e) { statusFailed = true; warn(`status page could not be written (${e.message}); continuing without it.`); return; }
    writeStatus();
    openStatusPage();
    log(`Status page: ${join(statusDir(), "status.html")}`);
  }

  function previewStatus() {
    const S = JSON.parse(JSON.stringify(STATUS));
    const t = Date.now();
    Object.assign(S.meta, { runId: "preview-run-0000", worktree: getWt() || getWtPin() || "(preview)", objective: S.meta.objective || "Build a login page with email + Google sign-in (sample)", startedAt: t - 3720000, updatedAt: t });
    S.overall = "running";
    S.steps.forEach((s, idx) => {
      if (s.status === "skipped") return;
      if (idx < 3) {
        s.status = "succeeded"; s.attempt = 1; s.startedAt = t - 3720000 + idx * 600000; s.endedAt = s.startedAt + 240000 + idx * 30000; s.durationMs = s.endedAt - s.startedAt;
        s.usage = { in: 12340 + idx * 800, out: 8900 + idx * 500, cacheRead: 210000 + idx * 1000, cacheWrite: 0, total: 231240 + idx * 2300, note: null };
      } else if (idx === 3) { s.status = "running"; s.attempt = 1; s.startedAt = t - 757000; }
      else if (idx === 5) { s.status = "failed"; s.attempt = 2; s.startedAt = t - 600000; s.endedAt = t - 300000; s.durationMs = 300000; s.note = "tests failed (preview fixture)"; s.usage = { in: 40200, out: 15800, cacheRead: 660000, cacheWrite: 12000, total: 728000, note: "+1 extra attempt" }; }
      else if (idx === 6) { s.status = "waiting-approval"; s.attempt = 1; s.startedAt = t - 120000; s.note = "gate open (preview fixture)"; }
      else if (idx === 7) { s.status = "unknown"; s.attempt = 1; s.note = "no worker_done seen (preview fixture)"; }
      else if (idx === 8) { s.status = "skipped"; }
    });
    const used = S.steps.filter((s) => s.usage);
    if (used.length) S.meta.usage = used.reduce((a, s) => ({ in: a.in + s.usage.in, out: a.out + s.usage.out, cacheRead: a.cacheRead + s.usage.cacheRead, cacheWrite: a.cacheWrite + s.usage.cacheWrite, total: a.total + s.usage.total }), { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    const prog = S.steps.find((s) => s.progress);
    if (prog) prog.tasks = parseProgress("- [x] Project scaffold + config wiring\n- [x] Data layer: schema + migrations\n  - [x] migration scripts\n  - [ ] seed data\n- [~] Auth API (email + Google sign-in)\n- [ ] Session management + middleware\n- [ ] Integration tests\n- [ ] README updates\n");
    return S;
  }

  function runPreviewAndExit(here) {
    const dir = join(here, "status-preview");
    try {
      mkdirSync(dir, { recursive: true });
      const P = previewStatus();
      if (process.env.ORCA_STATUS_PREVIEW_RESUME) {
        writeStatusTo(dir, P);
        STATUS.steps.forEach((s, idx) => { if (idx < 4) s.status = "skipped"; });
        STATUS.meta.worktree = getWt() || getWtPin() || "(preview)";
        STATUS.meta.startedAt = Date.now() - 3720000;
        STATUS.meta.updatedAt = Date.now();
        loadPreviousStatus(dir);
      }
      writeFileSync(join(dir, "status.html"), STATUS_HTML);
      writeStatusTo(dir, process.env.ORCA_STATUS_PREVIEW_RESUME ? STATUS : P);
      for (const s of P.steps) {
        if (!s.writes || !(s.status === "succeeded" || s.status === "running")) continue;
        const sample = `# ${s.title}\n\nSample artifact for the --status-preview fixture (status: ${s.status}).\n\n- deterministic text, written once per preview\n` +
          (s.status === "running" ? "- the agent is still writing…\n" : "- click a step row or artifact chip to read it\n");
        try { writeFileSync(join(dir, s.writes), sample); writeArtifactSnapshotTo(dir, s); } catch {}
      }
      log(`Status preview: ${join(dir, "status.html")}${process.env.ORCA_STATUS_PREVIEW_RESUME ? " (resume merge exercised)" : ""}`);
    } catch (e) { warn(`status preview failed: ${e.message}`); }
    process.exit(0);
  }

  return {
    STATUS, statusDir, statusOf, statusSet, writeStatus, writeArtifactSnapshot,
    copyRunFiles, archiveCurrentRun, listRuns, printRunList,
    statusBegin, statusEnd, finishStatus, refreshProgress, loadPreviousStatus, initStatus, runPreviewAndExit,
    setLedgerRunKey: (rk, { lineageId = null, lineageRunKeys = null } = {}) => {
      STATUS.meta.ledgerRunKey = rk;
      STATUS.meta.lineageId = lineageId || resumedLineageId || rk;
      STATUS.meta.lineageRunKeys = Array.isArray(lineageRunKeys) && lineageRunKeys.length
        ? [...new Set(lineageRunKeys)]
        : [...new Set([...resumedLineageRunKeys, rk].filter(Boolean))];
    },
    getResumedLedgerRunKey: () => resumedLedgerRunKey,
    getResumedLineageId: () => resumedLineageId,
    getResumedLineageRunKeys: () => [...resumedLineageRunKeys],
  };
}
