// E2E test harness for .orca/flow.mjs — proves the workflow runs CORRECTLY
// and NEVER HANGS, without touching a real Orca runtime or spawning agents.
//
// How the Orca CLI is faked (zero changes to flow.mjs):
//   ORCA_CLI_COMMAND = node.exe     — spawnable shell-less on every platform
//   NODE_OPTIONS = --require test/orca-preload.cjs
//     → every "orca" spawn becomes node.exe <subcommand> ...; the preload
//       hands it to test/fake-orca.cjs (stateful, scripted per scenario).
// Every scenario runs under a WATCHDOG: exceeding its budget kills the child
// and the scenario FAILS with HUNG — that is the literal "did not hang" check.
// A FAILING or HUNG scenario keeps its tmp dir for inspection; the runner
// deletes a passing scenario's dirs only after the scenario finishes.
//
// Run: node test/run-tests.mjs [--only <substring>]
// (--only is a case-sensitive substring on scenario names: "--only F" also matches E7's "onFailGoto".)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, rmdirSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const ROOT = resolve(HERE, "..");
const FLOW = join(REPO, ".orca", "flow.mjs");
const NODE = process.execPath;
const PRELOAD = join(HERE, "orca-preload.cjs");
if (/\s/.test(PRELOAD)) {
  console.error(`FAIL - preload path contains whitespace (${PRELOAD}); move the repo to a space-free path.`);
  process.exit(1);
}

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
if (process.argv.includes("--only") && !only) { console.error("FAIL - --only requires a non-empty substring"); process.exit(1); }
let failed = 0; let total = 0;
const ok = (name, cond, extra) => {
  total++;
  if (cond) console.log("ok -", name);
  else { failed++; console.error("FAIL -", name, extra ?? ""); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// Tiny localhost webhook recorder for the notification scenarios (N1).
async function recordHook() {
  const hits = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("error", () => {});   // aborted client must not crash the runner
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      let body = null;
      try { body = b ? JSON.parse(b) : null; } catch { body = `<unparseable: ${b.slice(0, 120)}>`; }
      hits.push({ path: req.url, body });
      res.writeHead(204);
      res.end();
    });
  });
  const listening = new Promise((r) => srv.listen(0, "127.0.0.1", r));
  srv.on("error", (e) => { throw e; });   // failed listen must fail loudly, not hang the suite
  await listening;
  const url = `http://127.0.0.1:${srv.address().port}/hook`;
  const close = () => new Promise((r) => srv.close(r));
  return { hits, url, close };
}

// Tmp dirs survive runFlow; the runner decides their fate AFTER the scenario,
// so failure evidence (calls.jsonl/state.json/status.js) still exists when
// assertions report FAIL. Same for HUNG — runFlow sets the flag when it kills.
let dirsOfCurrentScenario = [];
let hungInCurrentScenario = false;

// Run flow.mjs once under the fake Orca. Config paths are RELATIVE to .orca/
// (flow.mjs joins them with its own directory) — never absolute.
// default budget: well above the configs' hard caps so a slow machine cannot produce a false HUNG
// NOTE: call sites pass the property key "scenario:" — a mismatch silently falls back to default.cjs (the green-path trap this param's name once caused).
async function runFlow({ name, config, scenario: scenarioFile = "default.cjs", args = [], objective = "test objective", seedArtifacts = [], seedWorktree = [], env: extraEnv = null, stdinText = null, budgetMs = 90000, notify = null, reuseDir = null, worktreePin = "name:testlab", omitNoOpenStatus = false, statusOpenLog = null }) {
  const dir = reuseDir ?? mkdtempSync(join(tmpdir(), `orca-flow-${name}-`));
  if (!dirsOfCurrentScenario.includes(dir)) dirsOfCurrentScenario.push(dir);
  const wt = join(dir, "wt"); const home = join(dir, "home");
  mkdirSync(join(wt, ".orca", "artifacts"), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const a of seedArtifacts) writeFileSync(join(wt, ".orca", "artifacts", a.file), a.text ?? "seeded by harness\n");
  // Worktree-ROOT fixtures (agent-config files, stale manifests, user-owned
  // AGENTS.md/.mcp.json) — unlike seedArtifacts, which target .orca/artifacts.
  // No text fallback on purpose: worktree fixtures are typed (JSON/markdown) —
  // a silent default would corrupt them.
  for (const w of seedWorktree) {
    const p = join(wt, w.file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, w.text);
  }
  if (notify) writeFileSync(join(dir, "notify.json"), JSON.stringify(notify, null, 2));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("ORCA_")) delete env[k];
  env.ORCA_CLI_COMMAND = NODE;
  // Per-scenario env (NOT ORCA_*-prefixed — those were stripped above on purpose; harness-owned keys assigned below still win).
  if (extraEnv) Object.assign(env, extraEnv);
  // Backslashes inside NODE_OPTIONS quotes are eaten by Node's POSIX-style
  // tokenizer (C:\Working -> C:Working), so the preload must be forward-slashed.
  env.NODE_OPTIONS = `--require "${PRELOAD.split("\\").join("/")}"`;
  env.ORCA_FAKE_STATE = join(dir, "state.json");
  env.ORCA_FAKE_LOG = join(dir, "calls.jsonl");
  env.ORCA_FAKE_SCENARIO = join(HERE, "scenarios", scenarioFile);
  env.ORCA_FAKE_WT = wt;
  env.ORCA_TEST_MODE = "1";
  // Title -> writes map: lets the fake materialize each step's artifact on
  // success, exactly like a real worker leaving its {out} file behind.
  env.ORCA_FAKE_WRITES = (() => {
    try {
      const cc = JSON.parse(readFileSync(join(REPO, ".orca", config ?? "flow.config.json"), "utf8"));
      return JSON.stringify(Object.fromEntries(
        (cc.pipeline || []).filter((s) => s && s.title && s.writes).map((s) => [s.title, s.writes])));
    } catch { return "{}"; }
  })();
  env.ORCA_FAKE_VERIFY = (() => {
    try {
      const cc = JSON.parse(readFileSync(join(REPO, ".orca", config ?? "flow.config.json"), "utf8"));
      return JSON.stringify(Object.fromEntries(
        (cc.pipeline || []).filter((s) => s && s.title && s.verify).map((s) => [s.title, s.verify])));
    } catch { return "{}"; }
  })();
  // worktreePin: null = no pin at all — the flow's auto-detect path runs.
  // (Must be assigned AFTER extraEnv so the harness default wins over stray env.)
  if (worktreePin !== null) env.ORCA_FLOW_WORKTREE = worktreePin;
  else delete env.ORCA_FLOW_WORKTREE;
  // notify template, when given, is handed to the child via its file's path — the
  // only source, since every inherited ORCA_* key was stripped above.
  if (notify) env.ORCA_FLOW_NOTIFY_FILE = join(dir, "notify.json");
  if (statusOpenLog) env.ORCA_STATUS_OPEN_LOG = statusOpenLog;
  env.USERPROFILE = home;
  env.HOME = home;
  const argv = [FLOW, ...args, ...(omitNoOpenStatus ? [] : ["--no-open-status"])];
  if (config) argv.push("--config", config);
  if (objective) argv.push(objective);
  const child = spawn(NODE, argv, { cwd: REPO, env, stdio: [stdinText == null ? "ignore" : "pipe", "pipe", "pipe"] });
  if (stdinText != null) { child.stdin.on("error", () => {}); child.stdin.write(stdinText); child.stdin.end(); }
  let out = ""; let err = ""; let hung = false;
  const timer = setTimeout(() => { hung = true; hungInCurrentScenario = true; child.kill(); }, budgetMs);
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => child.on("exit", (c) => r(c)));
  clearTimeout(timer);
  const status = (() => {
    try {
      const txt = readFileSync(join(wt, ".orca", "artifacts", "status.js"), "utf8");
      const m = txt.match(/window\.__STATUS=([\s\S]*?);window\.__ON_STATUS/);
      return m ? JSON.parse(m[1]) : null;
    } catch { return null; }
  })();
  const calls = existsSync(join(dir, "calls.jsonl"))
    ? readFileSync(join(dir, "calls.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const by = (cmd) => calls.filter((c) => c.cmd === cmd);
  const state = existsSync(join(dir, "state.json")) ? JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) : null;
  return { code, out, err, hung, status, state, calls, by, wt, dir };
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

// ---------------------------------------------------------------------------
// E1 — happy path, cold start: terminal create FAILS (default) so every step
// falls back to `worker-start`; each worker reports worker_done/succeeded.
// ---------------------------------------------------------------------------
scenario("E1 happy-cold (2 steps, cold start, both succeed)", async () => {
  const r = await runFlow({ name: "e1", config: "../test/configs/cold.config.json" });
  ok("E1 not hung", !r.hung);
  eq("E1 exit code", r.code, 0);
  ok("E1 alpha ok line", /\[ok\] Alpha done -> \.orca\/artifacts\/A\.md/.test(r.out + r.err));
  ok("E1 beta ok line", /\[ok\] Beta done -> \.orca\/artifacts\/B\.md/.test(r.out + r.err));
  ok("E1 pipeline complete", /Pipeline COMPLETE/.test(r.out));
  eq("E1 status overall", r.status?.overall, "succeeded");
  eq("E1 both steps succeeded", r.status?.steps.filter((s) => s.status === "succeeded").length, 2);
  eq("E1 one task-create per step", r.by("orchestration task-create").length, 2);
  eq("E1 worker-release per dispatch", r.by("orchestration worker-release").length, 2);
  ok("E1 artifact materialized", existsSync(join(r.wt, ".orca", "artifacts", "A.md")));
});

// ---------------------------------------------------------------------------
// E1b — auto-detect fails, no create consent (non-TTY): old hard-fail kept,
// and the fix hint now advertises --create-worktree / autoCreateWorktree.
// ---------------------------------------------------------------------------
scenario("E1b no auto-create without consent (non-TTY keeps old die)", async () => {
  // Stray pin via extraEnv: runFlow must DELETE it (worktreePin:null) — if it
  // leaked, WT_PIN would resolve and the run would exit 0, failing this scenario.
  const r = await runFlow({ name: "e1b", config: "../test/configs/cold.config.json", scenario: "no-wt.cjs", worktreePin: null, env: { ORCA_FLOW_WORKTREE: "name:bogus" } });
  ok("E1b not hung", !r.hung);
  eq("E1b exit code", r.code, 1);
  ok("E1b auto-detect error", /Could not auto-detect the worktree/.test(r.err + r.out));
  eq("E1b no create call", r.by("worktree create").length, 0);
  ok("E1b hint mentions --create-worktree", /--create-worktree/.test(r.err + r.out));
  ok("E1b hint mentions autoCreateWorktree", /autoCreateWorktree/.test(r.err + r.out));
});

// ---------------------------------------------------------------------------
// E1a — auto-detect fails, --create-worktree given (non-TTY): the flow creates
// a flow-<slug>-<stamp> worktree from HEAD and runs the whole pipeline in it.
// ---------------------------------------------------------------------------
scenario("E1a auto-create worktree (--create-worktree, non-TTY)", async () => {
  const r = await runFlow({ name: "e1a", config: "../test/configs/cold.config.json", scenario: "no-wt.cjs", worktreePin: null, args: ["--create-worktree"], objective: "Them trang dang nhap" });
  ok("E1a not hung", !r.hung);
  eq("E1a exit code", r.code, 0);
  const created = r.by("worktree create");
  eq("E1a exactly one create call", created.length, 1);
  ok("E1a name = slug + stamp", /^flow-them-trang-dang-nhap-\d{8}-\d{6}$/.test(created[0].flags.name));
  ok("E1a repo selector targets this checkout", (created[0].flags.repo ?? "").split("\\").join("/") === "path:" + REPO.split("\\").join("/"));
  ok("E1a create based on HEAD sha", /^[0-9a-f]{40}$/.test(created[0].flags["base-branch"] ?? ""));
  ok("E1a create used --no-parent", created[0].flags["no-parent"] === true);
  ok("E1a agents run in created worktree", r.calls.some((c) => c.flags && c.flags.worktree === "name:" + created[0].flags.name));
  ok("E1a created log line", /\[worktree\] created /.test(r.out));
  ok("E1a summary cleanup hint", /remove later with: orca worktree rm name:flow-/.test(r.out));
  eq("E1a status overall", r.status?.overall, "succeeded");
  // Second short run locking the diacritic slug: đ (U+0111, no NFD
  // decomposition) must map to "d", not collapse into a dash.
  const d = await runFlow({ name: "e1ad", config: "../test/configs/cold.config.json", scenario: "no-wt.cjs", worktreePin: null, args: ["--create-worktree"], objective: "Thêm trang đăng nhập" });
  ok("E1a đ slug maps to d", /^flow-them-trang-dang-nhap-\d{8}-\d{6}$/.test((d.by("worktree create")[0] || {}).flags?.name ?? ""));
});

// ---------------------------------------------------------------------------
// E1c — config consent: defaults.autoCreateWorktree: true creates without the
// flag (non-TTY), no pin.
// ---------------------------------------------------------------------------
scenario("E1c auto-create via defaults.autoCreateWorktree config", async () => {
  const r = await runFlow({ name: "e1c", config: "../test/configs/autowt.config.json", scenario: "no-wt.cjs", worktreePin: null });
  ok("E1c not hung", !r.hung);
  eq("E1c exit code", r.code, 0);
  eq("E1c one create call", r.by("worktree create").length, 1);
  ok("E1c name = slug + stamp", /^flow-test-objective-\d{8}-\d{6}$/.test((r.by("worktree create")[0] || {}).flags?.name ?? ""));
  eq("E1c status overall", r.status?.overall, "succeeded");
});

// ---------------------------------------------------------------------------
// E4 — hard cap: silent, frozen-preview worker. Must settle as still-running
// with the resume hint; the watchdog proves the process itself ends.
// ---------------------------------------------------------------------------
scenario("E4 hardcap (silent frozen worker settles via hardTimeoutMs)", async () => {
  const r = await runFlow({ name: "e4", config: "../test/configs/hang.config.json", scenario: "hang.cjs", budgetMs: 45000 });
  ok("E4 not hung", !r.hung);
  eq("E4 exit code", r.code, 1);
  ok("E4 hard-cap message", /not settled after \d+min; leaving its terminal open/.test(r.out + r.err));
  ok("E4 resume hint", /--from beta/.test(r.out + r.err));
  eq("E4 status overall", r.status?.overall, "still-running");
  ok("E4 alpha still-running note", /not settled after/.test(r.status?.steps.find((s) => s.id === "alpha")?.note ?? ""));
});

// ---------------------------------------------------------------------------
// E5 — quiet-but-alive: one warning, no premature failure, hard-cap exit.
// ---------------------------------------------------------------------------
scenario("E5 quiet-warn (alive dispatch, one warning, no premature fail)", async () => {
  const r = await runFlow({ name: "e5", config: "../test/configs/hang.config.json", scenario: "stale-heartbeat.cjs", budgetMs: 45000 });
  ok("E5 not hung", !r.hung);
  eq("E5 exit code", r.code, 1);
  const warns = (r.out + r.err).match(/quiet for \d+min but its dispatch is alive/g) || [];
  eq("E5 exactly one quiet warning", warns.length, 1);
  ok("E5 waited to hard cap", /waiting up to the \d+min hard cap/.test(r.out + r.err));
  eq("E5 status overall", r.status?.overall, "still-running");
});

// ---------------------------------------------------------------------------
// E6 — parked on a permission prompt: observe, never answer, hard-cap exit.
// ---------------------------------------------------------------------------
scenario("E6 parked-prompt (frozen dialog: warn, never answer, hard cap)", async () => {
  const r = await runFlow({ name: "e6", config: "../test/configs/hang.config.json", scenario: "parked.cjs", budgetMs: 45000 });
  ok("E6 not hung", !r.hung);
  eq("E6 exit code", r.code, 1);
  ok("E6 parked warning", /PARKED on a permission-rule confirmation/.test(r.out + r.err));
  // The parked diagnosis must SURVIVE the hard cap: the status page is the
  // thing a human opens after the run stops, so the final note must say what
  // the worker was parked on AND that the cap fired (not the generic
  // "not settled after" alone — that loses the actionable diagnosis).
  ok("E6 status note keeps the parked diagnosis", /parked on a permission-rule confirmation — not settled after \d+min/.test(r.status?.steps.find((s) => s.id === "alpha")?.note ?? ""));
  eq("E6 flow never answered the prompt", r.by("terminal send").length, 0);
  eq("E6 status overall", r.status?.overall, "still-running");
});

// ---------------------------------------------------------------------------
// E7 — onFailGoto fix loop: fail once, jump back, reopen (not re-create),
// succeed on the second pass.
// ---------------------------------------------------------------------------
scenario("E7 fail-retry (onFailGoto reopens the fix target once)", async () => {
  const r = await runFlow({ name: "e7", config: "../test/configs/retry.config.json", scenario: "reviewer-fail-once.cjs", budgetMs: 90000 });
  ok("E7 not hung", !r.hung);
  eq("E7 exit code", r.code, 0);
  // Optional note segment: since the nudge engine (v2.1.0 spec, decision table
  // "No resolvable terminal"), a failed step with a missing artifact carries
  // e.g. "(artifact missing (no terminal to nudge))" — outcome stays original.
  ok("E7 fail jump logged", /\[fail\] Reviewer FAILED( \(.*\))? -> back to "Coder" \(attempt 1\/1\)/.test(r.out + r.err));
  eq("E7 one task-create per step (no double dispatch)", r.by("orchestration task-create").length, 2);
  const reopens = r.by("orchestration task-update").filter((c) => c.flags.status === "ready");
  ok("E7 target reopened", reopens.length >= 1);
  ok("E7 fix note recorded", reopens.some((c) => String(c.flags.result ?? "").includes("fix from reviewer")));
  eq("E7 status overall", r.status?.overall, "succeeded");
  eq("E7 coder attempt 2", r.status?.steps.find((s) => s.id === "coder")?.attempt, 2);
});

// ---------------------------------------------------------------------------
// E8 — retries are finite: exhausted maxRetries dies instead of looping.
// ---------------------------------------------------------------------------
scenario("E8 retry-exhaust (loop is finite)", async () => {
  const r = await runFlow({ name: "e8", config: "../test/configs/retry.config.json", scenario: "reviewer-fail-always.cjs", budgetMs: 90000 });
  ok("E8 not hung", !r.hung);
  eq("E8 exit code", r.code, 1);
  ok("E8 exhausted message", /exhausted 1 retries/.test(r.out + r.err));
  eq("E8 worker-start count bounded (2+2)", r.by("orchestration worker-start").length, 4);
});

// ---------------------------------------------------------------------------
// E31 — parallel REVIEW group + onFailGoto: Security Review fails once inside
// the [code-review ∥ security-review] group; the fix loop jumps back to the
// Coder and the retry re-runs the WHOLE group — a second dispatch for BOTH
// review members, not just the failed one. Expected worker-starts: coder,
// both reviews (round 1), coder (fix), both reviews (round 2), testing = 7.
// ---------------------------------------------------------------------------
scenario("E31 parallel-review fail-retry (group re-runs both reviews after fix)", async () => {
  const r = await runFlow({ name: "e31", config: "../test/configs/parallel-review.config.json",
    scenario: "parallel-review-fail-once.cjs", budgetMs: 90000 });
  ok("E31 not hung", !r.hung);
  eq("E31 exit code", r.code, 0);
  const starts = r.calls.map((c, i) => (c.cmd === "orchestration worker-start" ? i : -1)).filter((i) => i > -1);
  const checkAfterFirstReview = r.calls.findIndex((c, i) => c.cmd === "orchestration check" && i > starts[1]);
  ok("E31 both reviews launched before the group's first wait", starts[2] > -1 && checkAfterFirstReview > starts[2]);
  ok("E31 fail jump logged", /\[fail\] Security Review FAILED( \(.*\))? -> back to "Coder" \(attempt 1\/1\)/.test(r.out + r.err));
  eq("E31 one task-create per step (cached tasks reopened, not re-created)", r.by("orchestration task-create").length, 4);
  eq("E31 worker-start total (coder x2, each review x2, testing x1)", r.by("orchestration worker-start").length, 7);
  const reopens = r.by("orchestration task-update").filter((c) => c.flags.status === "ready");
  ok("E31 coder reopened with fix note", reopens.some((c) => String(c.flags.result ?? "").includes("fix from security-review")));
  eq("E31 security-review flagged parallel", r.status?.steps.find((s) => s.id === "security-review")?.parallel, true);
  eq("E31 coder attempt 2", r.status?.steps.find((s) => s.id === "coder")?.attempt, 2);
  eq("E31 security-review attempt 2", r.status?.steps.find((s) => s.id === "security-review")?.attempt, 2);
  const joinCreate = r.calls.findIndex((c) => c.cmd === "orchestration task-create" && String(c.flags.spec ?? "").includes("# Testing"));
  const checkAfterRetry = r.calls.findIndex((c, i) => c.cmd === "orchestration check" && i > starts[5]);
  ok("E31 testing tasked only after the retry round settles", joinCreate > -1 && checkAfterRetry > -1 && joinCreate > checkAfterRetry);
  ok("E31 testing ok line (join after both reviews)", /\[ok\] Testing done -> \.orca\/artifacts\/TEST_REPORT\.md/.test(r.out + r.err));
  eq("E31 status overall", r.status?.overall, "succeeded");
});

// ---------------------------------------------------------------------------
// E32 — per-step maxRetries: the reviewer declares maxRetries:3 over the
// global 1; the fix loop must honor the STEP budget — attempts render n/3,
// exhaustion lands at 3, and the coder is re-dispatched exactly 3 times.
// ---------------------------------------------------------------------------
scenario("E32 retry-per-step (step budget overrides global)", async () => {
  const r = await runFlow({ name: "e32", config: "../test/configs/retry-per-step.config.json", scenario: "reviewer-fail-always.cjs", budgetMs: 90000 });
  ok("E32 not hung", !r.hung);
  eq("E32 exit code", r.code, 1);
  const log = r.out + r.err;
  ok("E32 attempt 1/3", /\[fail\] Reviewer FAILED( \(.*\))? -> back to "Coder" \(attempt 1\/3\)/.test(log));
  ok("E32 attempt 2/3", /\(attempt 2\/3\)/.test(log));
  ok("E32 attempt 3/3", /\(attempt 3\/3\)/.test(log));
  ok("E32 exhausted at step budget", /exhausted 3 retries/.test(log));
  ok("E32 never used the global budget", !/exhausted 1 retries/.test(log));
  eq("E32 worker-start count bounded (4 coder + 4 reviewer)", r.by("orchestration worker-start").length, 8);
});

// ---------------------------------------------------------------------------
// E33 — artifact viewer snapshots: every step's artifact gets a flat JSONP
// twin <writes>.js next to it, so the page can lazy-load it via a classic
// <script> on file:// (same trick as status.js).
// ---------------------------------------------------------------------------
scenario("E33 artifact viewer snapshots (per-step .md.js written)", async () => {
  const r = await runFlow({ name: "e33", config: "../test/configs/cold.config.json" });
  ok("E33 not hung", !r.hung);
  eq("E33 exit code", r.code, 0);
  for (const f of ["A.md", "B.md"]) {
    const jsPath = join(r.wt, ".orca", "artifacts", f + ".js");
    ok(`E33 ${f}.js exists`, existsSync(jsPath));
    const txt = readFileSync(jsPath, "utf8");
    const m = txt.match(/window\.__ARTIFACTS=window\.__ARTIFACTS\|\|\{\};window\.__ARTIFACTS\[.*?\]=([\s\S]*);window\.__ON_ARTIFACT&&window\.__ON_ARTIFACT\(/);
    ok(`E33 ${f}.js JSONP shape`, !!m);
    if (m) {
      const payload = JSON.parse(m[1]);
      eq(`E33 ${f} payload.file`, payload.file, f);
      eq(`E33 ${f} exists flag`, payload.exists, true);
      ok(`E33 ${f} bytes>0`, payload.bytes > 0);
      ok(`E33 ${f} mtime set`, typeof payload.mtime === "number" && payload.mtime > 0);
      eq(`E33 ${f} text round-trips`, payload.text, readFileSync(join(r.wt, ".orca", "artifacts", f), "utf8"));
    }
  }
});

// ---------------------------------------------------------------------------
// E33b — --status-preview demos the viewer offline: sample .md files, their
// JSONP snapshots, and the viewer hooks present in the static page.
// ---------------------------------------------------------------------------
scenario("E33b status-preview includes artifact viewer fixtures", async () => {
  const r = await runFlow({ name: "e33p", args: ["--status-preview"], objective: "" });
  ok("E33b not hung", !r.hung);
  eq("E33b exit code", r.code, 0);
  const pv = join(REPO, ".orca", "status-preview");
  try {
    const html = readFileSync(join(pv, "status.html"), "utf8");
    ok("E33b status.html mentions __ARTIFACTS", /__ARTIFACTS/.test(html));
    ok("E33b status.html has viewer hooks", /data-file/.test(html) && /data-back/.test(html));
    const snap = readdirSync(pv).filter((f) => /\.md\.js$/.test(f));
    ok("E33b snapshot fixtures written", snap.length > 0);
    for (const f of snap) {
      const txt = readFileSync(join(pv, f), "utf8");
      ok(`E33b ${f} JSONP shape`,
        /^window\.__ARTIFACTS=window\.__ARTIFACTS\|\|\{\};window\.__ARTIFACTS\[/.test(txt) &&
        /window\.__ON_ARTIFACT&&window\.__ON_ARTIFACT\(/.test(txt));
    }
  } finally {
    rmSync(pv, { recursive: true, force: true });   // preview dir is repo-side — clean up
  }
});

// ---------------------------------------------------------------------------
// E2 — manual start path: warm the TUI, fetch the preamble, substitute
// ctx_dryrun, paste + bare-Enter, verify consumption, close on settle.
// Also pins the AUTO-RUN claude command wrap.
// ---------------------------------------------------------------------------
scenario("E2 happy-manual (warm-up, paste ladder, claude wrap, close)", async () => {
  const r = await runFlow({ name: "e2", config: "../test/configs/manual.config.json", scenario: "terminal-ok.cjs", budgetMs: 150000 });
  ok("E2 not hung", !r.hung);
  eq("E2 exit code", r.code, 0);
  const create = r.by("terminal create");
  eq("E2 one terminal created", create.length, 1);
  const cmd = String(create[0]?.flags.command ?? "");
  ok("E2 claude wrap: bypass permissions", cmd.includes("--permission-mode bypassPermissions"));
  ok("E2 claude wrap: AFK timeout env", cmd.includes("CLAUDE_AFK_TIMEOUT_MS=60000"));
  const sends = r.by("terminal send");
  ok("E2 preamble sent (spec head present)", sends.some((c) => String(c.flags.text ?? "").includes("# Solo")));
  ok("E2 dry-run placeholder replaced", sends.every((c) => !String(c.flags.text ?? "").includes("ctx_dryrun")));
  ok("E2 real dispatch id substituted", sends.some((c) => /dispatch=disp-\d+/.test(String(c.flags.text ?? ""))));
  ok("E2 bare-enter follow-up sent", sends.some((c) => c.flags.text === ""));
  eq("E2 terminal closed", r.by("terminal close").length, 1);
  eq("E2 status overall", r.status?.overall, "succeeded");
});

// ---------------------------------------------------------------------------
// E3 — parallel group: both members launch BEFORE either settles; the join
// step runs only after both.
// ---------------------------------------------------------------------------
scenario("E3 parallel-happy (group launches together, join waits)", async () => {
  const r = await runFlow({ name: "e3", config: "../test/configs/parallel.config.json", budgetMs: 90000 });
  ok("E3 not hung", !r.hung);
  eq("E3 exit code", r.code, 0);
  eq("E3 three task-creates", r.by("orchestration task-create").length, 3);
  const cmds = r.calls.map((c) => c.cmd);
  const firstStart = cmds.indexOf("orchestration worker-start");
  const secondStart = cmds.indexOf("orchestration worker-start", firstStart + 1);
  const firstCheck = cmds.indexOf("orchestration check");
  ok("E3 both members started before the first wait", firstStart > -1 && secondStart > -1 && firstCheck > secondStart);
  const joinCreate = r.calls.findIndex((c) => c.cmd === "orchestration task-create" && String(c.flags.spec ?? "").includes("Join"));
  ok("E3 join tasked only after the group settles", joinCreate > firstCheck);
  eq("E3 worker-start count (no double dispatch in group)", r.by("orchestration worker-start").length, 3);
  eq("E3 right flagged parallel", r.status?.steps.find((s) => s.id === "right")?.parallel, true);
  ok("E3 join ok line", /\[ok\] Join done -> \.orca\/artifacts\/P3\.md/.test(r.out + r.err));
  eq("E3 status overall", r.status?.overall, "succeeded");
});

// ---------------------------------------------------------------------------
// E9 — manual-mode gate: blocks (waiting-approval), then a yes resolves it.
// ---------------------------------------------------------------------------
scenario("E9 gate-approve (manual mode gate blocks, then resolves yes)", async () => {
  const r = await runFlow({ name: "e9", config: "../test/configs/gate.config.json", scenario: "gate-resolve.cjs", budgetMs: 90000 });
  ok("E9 not hung", !r.hung);
  eq("E9 exit code", r.code, 0);
  ok("E9 gate created", r.by("orchestration gate-create").length === 1);
  const polls = r.by("orchestration gate-list").length;
  ok("E9 gate polled to resolution", polls >= 2);
  ok("E9 gate polled to resolution (bounded)", polls <= 6);
  ok("E9 gate announced", /\[gate\] for "Build"/.test(r.out + r.err));
  eq("E9 build succeeded after gate", r.status?.steps.find((s) => s.id === "build")?.status, "succeeded");
  eq("E9 status overall", r.status?.overall, "succeeded");
});

// ---------------------------------------------------------------------------
// E10 — unknown outcome: no blind retry, exactly one dispatch.
// ---------------------------------------------------------------------------
scenario("E10 unknown-outcome (no blind retry)", async () => {
  const r = await runFlow({ name: "e10", config: "../test/configs/cold.config.json", scenario: "unknown-outcome.cjs", budgetMs: 90000 });
  ok("E10 not hung", !r.hung);
  eq("E10 exit code", r.code, 1);
  ok("E10 no-blind-retry message", /Not retrying without a definite failure/.test(r.out + r.err));
  ok("E10 outcome=unknown surfaced", /outcome=unknown/.test(r.out + r.err));
  eq("E10 exactly one dispatch (no double dispatch)", r.by("orchestration worker-start").length, 1);
});

// ---------------------------------------------------------------------------
// E11 — resume: --from keeps the read chain via the prior artifact file.
// ---------------------------------------------------------------------------
scenario("E11 resume-from (--from keeps the read chain)", async () => {
  const seed = [{ file: "A.md", text: "# Alpha output\nprior run artifact\n" +
    "seeded filler line so the resume seed clears the readiness minimum-size threshold.\n".repeat(4) }];
  const dry = await runFlow({ name: "e11dry", config: "../test/configs/cold.config.json", args: ["--dry-run", "--from", "beta"], seedArtifacts: seed, budgetMs: 30000 });
  eq("E11 dry-run exit", dry.code, 0);
  ok("E11 dry-run reads include prior step", /reads=\[alpha\]/.test(dry.out));

  const run = await runFlow({ name: "e11run", config: "../test/configs/cold.config.json", args: ["--from", "beta"], seedArtifacts: seed, budgetMs: 90000 });
  ok("E11 not hung", !run.hung);
  eq("E11 run exit code", run.code, 0);
  eq("E11 only beta tasked", run.by("orchestration task-create").length, 1);
  ok("E11 beta spec points at prior artifact", String(run.by("orchestration task-create")[0]?.flags.spec ?? "").includes(".orca/artifacts/A.md"));
  eq("E11 alpha skipped on resume", run.status?.steps.find((s) => s.id === "alpha")?.status, "skipped");
  eq("E11 beta succeeded", run.status?.steps.find((s) => s.id === "beta")?.status, "succeeded");
});

// ---------------------------------------------------------------------------
// S — agent skills + MCP materialization. The snapshot scenario records the
// worktree's config surface at task-create time (post-materialize, pre-restore).
// ---------------------------------------------------------------------------
const snapOf = (r, title) => {
  try { return JSON.parse(readFileSync(join(r.dir, "state.json"), "utf8")).extra.cfgSnap?.[title] ?? null; }
  catch { return null; }
};

scenario("S1 claude materialize (mcp.json + SKILL.md + env expand, clean restore)", async () => {
  const r = await runFlow({ name: "s1", config: "../test/configs/agent-skills.config.json",
    scenario: "agent-config-snap.cjs", env: { TEST_GH_TOKEN: "tok-123" }, budgetMs: 90000 });
  ok("S1 not hung", !r.hung);
  eq("S1 exit code", r.code, 0);
  const snap = snapOf(r, "Solo");
  ok("S1 snapshot captured", snap != null);
  const mcp = snap?.[".mcp.json"] ? JSON.parse(snap[".mcp.json"]) : null;
  eq("S1 mcp servers", Object.keys(mcp?.mcpServers ?? {}).sort(), ["docs", "github"]);
  eq("S1 stdio server", mcp?.mcpServers?.github?.command, "npx");
  eq("S1 env expanded", mcp?.mcpServers?.github?.env?.GITHUB_TOKEN, "tok-123");
  ok("S1 unset env -> empty string + warn", (mcp?.mcpServers?.docs?.headers?.Authorization === "Bearer ") &&
    /TEST_MCP_TOKEN.*not set/.test(r.out + r.err));
  eq("S1 skill folder", snap?.[".claude/skills"], ["review-checklist"]);
  ok("S1 SKILL.md frontmatter", /^---\nname: review-checklist\ndescription: Checklist for code review\n---\n\nReview in order/.test(snap?.[".claude/skills/review-checklist/SKILL.md"] ?? ""));
  ok("S1 manifest present during run", snap?.[".orca-agent-config.json"] != null);
  ok("S1 materialize log", /\[agent-config\] claude: 1 skill/.test(r.out + r.err));
  // After the run: worktree restored to its pre-run state.
  ok("S1 .mcp.json removed after run", !existsSync(join(r.wt, ".mcp.json")));
  ok("S1 skills dir removed after run", !existsSync(join(r.wt, ".claude")));
  ok("S1 manifest removed after run", !existsSync(join(r.wt, ".orca-agent-config.json")));
});

scenario("S1b unrestorable leftover manifest dies before materializing", async () => {
  const r = await runFlow({ name: "s1b", config: "../test/configs/agent-skills.config.json",
    scenario: "agent-config-snap.cjs",
    seedWorktree: [
      { file: "stuck/.keep", text: "occupies the path so restore hits a non-empty dir\n" },
      { file: ".orca-agent-config.json",
        text: JSON.stringify({ created: [], modified: [{ path: "stuck", original: "not a dir owner\n" }] }) + "\n" },
    ], budgetMs: 90000 });
  ok("S1b not hung", !r.hung);
  eq("S1b exit code", r.code, 1);
  ok("S1b die message", /leftover manifest could not be fully restored/.test(r.out + r.err));
  ok("S1b manifest kept", existsSync(join(r.wt, ".orca-agent-config.json")));
});

scenario("S1c invalid pre-existing mcp.json rolls back immediately in flow & flushes manifest when rollback disabled", async () => {
  const { materializeAgentConfig } = await import(join(REPO, ".orca", "agent-config.mjs"));
  const unitWt = mkdtempSync(join(tmpdir(), "orca-s1c-unit-"));
  dirsOfCurrentScenario.push(unitWt);
  writeFileSync(join(unitWt, ".mcp.json"), "this is not json");
  let unitDied = false;
  try {
    materializeAgentConfig({
      worktree: unitWt,
      members: [{ id: "solo", agent: "claude", mcp: ["github"], skills: [] }],
      cfg: { mcpServers: { github: { command: "npx", args: ["-y", "srv"] } } },
      configDir: join(REPO, ".orca"),
      die: (m) => { unitDied = true; throw new Error(m); },
      warn: () => {},
      rollbackOnError: false,
    });
  } catch {}
  ok("S1c unit rollbackOnError=false died on invalid .mcp.json", unitDied);
  ok("S1c unit manifest flushed before mutation for crash window self-heal", existsSync(join(unitWt, ".orca-agent-config.json")));

  const r = await runFlow({ name: "s1c", config: "../test/configs/agent-skills.config.json",
    scenario: "agent-config-snap.cjs",
    seedWorktree: [{ file: ".mcp.json", text: "this is not json" }], budgetMs: 90000 });
  ok("S1c not hung", !r.hung);
  eq("S1c exit code", r.code, 1);
  ok("S1c die message", /\.mcp\.json already exists in the worktree and is not valid JSON/.test(r.out + r.err));
  ok("S1c immediate rollback cleaned up manifest in same run", !existsSync(join(r.wt, ".orca-agent-config.json")));
  eq("S1c original file untouched", readFileSync(join(r.wt, ".mcp.json"), "utf8"), "this is not json");
});

scenario("S2 stale manifest self-heals at startup", async () => {
  const r = await runFlow({ name: "s2", config: "../test/configs/nudge-post.config.json",
    seedWorktree: [
      { file: ".mcp.json", text: '{"mcpServers":{"stale":{}}}\n' },
      { file: ".orca-agent-config.json", text: JSON.stringify({ created: [".mcp.json"], modified: [] }) + "\n" },
    ], budgetMs: 90000 });
  ok("S2 not hung", !r.hung);
  eq("S2 exit code", r.code, 0);
  ok("S2 stale .mcp.json removed", !existsSync(join(r.wt, ".mcp.json")));
  ok("S2 manifest removed", !existsSync(join(r.wt, ".orca-agent-config.json")));
  ok("S2 self-heal log", /leftover manifest|restored worktree files/.test(r.out + r.err));
});

scenario("S2b startup self-heal fires before the runtime check", async () => {
  const r = await runFlow({ name: "s2b", config: "../test/configs/nudge-post.config.json",
    scenario: "runtime-down.cjs",
    seedWorktree: [
      { file: ".mcp.json", text: '{"mcpServers":{"stale":{}}}\n' },
      { file: ".orca-agent-config.json", text: JSON.stringify({ created: [".mcp.json"], modified: [] }) + "\n" },
    ], budgetMs: 90000 });
  ok("S2b not hung", !r.hung);
  eq("S2b exit code", r.code, 1);
  ok("S2b died at the runtime check", /Orca runtime not ready/.test(r.out + r.err));
  ok("S2b stale .mcp.json removed anyway", !existsSync(join(r.wt, ".mcp.json")));
  ok("S2b manifest removed anyway", !existsSync(join(r.wt, ".orca-agent-config.json")));
  ok("S2b self-heal log", /restored worktree files left behind/.test(r.out + r.err));
});

scenario("S3 pre-existing files merge, then restore verbatim", async () => {
  const seededMcp = '{"mcpServers":{"keepme":{"command":"keep"}}}\n';
  const seededAgents = "Original agent instructions.\n";
  const r = await runFlow({ name: "s3", config: "../test/configs/agent-skills-merge.config.json",
    scenario: "agent-config-snap.cjs",
    seedWorktree: [
      { file: ".mcp.json", text: seededMcp },
      { file: "AGENTS.md", text: seededAgents },
      { file: ".claude/skills/review-checklist/README.md", text: "user-owned skill\n" },
    ], budgetMs: 90000 });
  ok("S3 not hung", !r.hung);
  eq("S3 exit code", r.code, 0);
  // During the claude step: keepme preserved + github merged in.
  const cl = snapOf(r, "Cl");
  const during = cl?.[".mcp.json"] ? JSON.parse(cl[".mcp.json"]) : {};
  eq("S3 merge keeps user server", Object.keys(during.mcpServers ?? {}).sort(), ["github", "keepme"]);
  // User-owned skill folder kept as-is, ours skipped with a warn.
  ok("S3 user skill folder kept", existsSync(join(r.wt, ".claude", "skills", "review-checklist", "README.md")));
  ok("S3 user skill content intact", readFileSync(join(r.wt, ".claude", "skills", "review-checklist", "README.md"), "utf8") === "user-owned skill\n");
  ok("S3 collision warn", /already exists in the worktree — keeping yours/.test(r.out + r.err));
  eq("S3 no SKILL.md injected into user folder", cl?.[".claude/skills/review-checklist/SKILL.md"] ?? null, null);
  // During the codex step: AGENTS.md = original + marked section; group-1 files already restored.
  const cx = snapOf(r, "Cx");
  const agents = cx?.["AGENTS.md"] ?? "";
  ok("S3 AGENTS.md keeps original", agents.startsWith("Original agent instructions."));
  ok("S3 AGENTS.md has markers", agents.includes("<!-- orca-agent-config BEGIN -->") && agents.includes("review-checklist"));
  ok("S3 group-1 mcp.json restored before group 2", cx?.[".mcp.json"] === seededMcp);
  // After the run: everything back to the seeded originals.
  eq("S3 .mcp.json restored verbatim", readFileSync(join(r.wt, ".mcp.json"), "utf8"), seededMcp);
  eq("S3 AGENTS.md restored verbatim", readFileSync(join(r.wt, "AGENTS.md"), "utf8"), seededAgents);
});

scenario("S4 parallel union + codex skills via AGENTS.md + mcp skip warn", async () => {
  const r = await runFlow({ name: "s4", config: "../test/configs/agent-skills-multi.config.json",
    scenario: "agent-config-snap.cjs", budgetMs: 90000 });
  ok("S4 not hung", !r.hung);
  eq("S4 exit code", r.code, 0);
  // Union: at the FIRST task-create both parallel members' refs are already materialized.
  const left = snapOf(r, "Left");
  const mcp = left?.[".mcp.json"] ? JSON.parse(left[".mcp.json"]) : {};
  eq("S4 union mcp servers", Object.keys(mcp.mcpServers ?? {}).sort(), ["docs", "github"]);
  eq("S4 union skill folders", (left?.[".claude/skills"] ?? []).sort(), ["commit-style", "review-checklist"]);
  ok("S4 union log", /merged skills\/MCP refs from 2 parallel steps/.test(r.out + r.err));
  // The codex join step: skills via marked AGENTS.md section; its mcp ref skipped with a warn.
  // (Named jn so the path `join` below stays reachable.)
  const jn = snapOf(r, "Join");
  const agents = jn?.["AGENTS.md"] ?? "";
  ok("S4 codex skills section", /### commit-style\n\nUse conventional commits\./.test(agents));
  ok("S4 codex mcp skip warn", /agent "codex" does not support MCP servers via worktree — skipping mcp "github"/.test(r.out + r.err));
  // Parallel group restored before the join step runs.
  ok("S4 group-1 files restored before join", jn?.[".mcp.json"] === null && (jn?.[".claude/skills"] === null));
  ok("S4 no leftover-manifest rescue (finally restored, not self-heal)", !/found a leftover manifest/.test(r.out + r.err));
  // Clean at the end.
  ok("S4 AGENTS.md gone after run", !existsSync(join(r.wt, "AGENTS.md")));
  ok("S4 no manifest after run", !existsSync(join(r.wt, ".orca-agent-config.json")));
});

scenario("S4b --agent override switches the materialized harness", async () => {
  const r = await runFlow({ name: "s4b", config: "../test/configs/agent-skills-multi.config.json",
    scenario: "agent-config-snap.cjs", args: ["--agent", "join=claude"], budgetMs: 90000 });
  ok("S4b not hung", !r.hung);
  eq("S4b exit code", r.code, 0);
  const jn = snapOf(r, "Join");
  const mcp = jn?.[".mcp.json"] ? JSON.parse(jn[".mcp.json"]) : {};
  eq("S4b override gets claude mcp file", Object.keys(mcp.mcpServers ?? {}), ["github"]);
  eq("S4b override gets claude skill dir", jn?.[".claude/skills"] ?? [], ["commit-style"]);
  ok("S4b no codex AGENTS.md section", jn?.["AGENTS.md"] === null);
  ok("S4b no skip warn for overridden agent", !/agent "codex" does not support/.test(r.out + r.err));
});

scenario("S5 cursor/gemini/opencode adapters", async () => {
  const r = await runFlow({ name: "s5", config: "../test/configs/agent-skills-harnesses.config.json",
    scenario: "agent-config-snap.cjs", budgetMs: 90000 });
  ok("S5 not hung", !r.hung);
  eq("S5 exit code", r.code, 0);
  // cursor: .cursor/mcp.json + .cursor/rules/<name>.mdc
  const cur = snapOf(r, "Cur");
  const cm = cur?.[".cursor/mcp.json"] ? JSON.parse(cur[".cursor/mcp.json"]) : {};
  eq("S5 cursor mcp key", Object.keys(cm), ["mcpServers"]);
  ok("S5 cursor server present", cm.mcpServers?.github?.command === "npx");
  ok("S5 cursor rule file", /^---\ndescription: How to write commits\n---\n\nUse conventional commits\./.test(cur?.[".cursor/rules/commit-style.mdc"] ?? ""));
  // gemini: .gemini/settings.json (mcpServers key) + GEMINI.md section
  const gem = snapOf(r, "Gem");
  const gs = gem?.[".gemini/settings.json"] ? JSON.parse(gem[".gemini/settings.json"]) : {};
  eq("S5 gemini mcp key", Object.keys(gs), ["mcpServers"]);
  ok("S5 gemini server present", gs.mcpServers?.github?.command === "npx");
  ok("S5 gemini section", (gem?.["GEMINI.md"] ?? "").includes("### commit-style"));
  // opencode: opencode.json (mcp key) + AGENTS.md section
  const opn = snapOf(r, "Opn");
  const oo = opn?.["opencode.json"] ? JSON.parse(opn["opencode.json"]) : {};
  eq("S5 opencode mcp key", Object.keys(oo), ["mcp"]);
  ok("S5 opencode server present", oo.mcp?.github?.command === "npx");
  ok("S5 opencode section", (opn?.["AGENTS.md"] ?? "").includes("### commit-style"));
  // Each step only sees ITS files (prior steps restored).
  ok("S5 cursor files restored before gemini", gem?.[".cursor/mcp.json"] === null);
  ok("S5 cursor rules dir gone before gemini", gem?.[".cursor/rules"] === null);
  ok("S5 gemini files restored before opencode", opn?.[".gemini/settings.json"] === null);
  // Clean at the end.
  for (const f of [".cursor", ".gemini", "opencode.json", "GEMINI.md", "AGENTS.md"])
    ok(`S5 ${f} gone after run`, !existsSync(join(r.wt, f)));
});

scenario("S6 path skills: dir copied verbatim, single .md wrapped", async () => {
  const r = await runFlow({ name: "s6", config: "../test/configs/agent-skills-path.config.json",
    scenario: "agent-config-snap.cjs", budgetMs: 90000 });
  ok("S6 not hung", !r.hung);
  eq("S6 exit code", r.code, 0);
  const tree = snapOf(r, "Dev")?.[".orca/agent-config-tree"] ?? [];
  eq("S6 dir copied with extras", tree.filter((f) => f.startsWith(".claude/skills/team")).sort(),
    [".claude/skills/team/SKILL.md", ".claude/skills/team/helper.txt"]);
  ok("S6 single .md wrapped as SKILL.md", tree.includes(".claude/skills/solo/SKILL.md"));
  ok("S6 worktree clean after run", !existsSync(join(r.wt, ".claude")));
});

scenario("S7 hostile manifest paths contained to the worktree", async () => {
  const r = await runFlow({ name: "s7", config: "../test/configs/agent-skills.config.json",
    scenario: "agent-config-snap.cjs",
    seedWorktree: [
      { file: "victim-bait.txt", text: "inside worktree — must survive\n" },
      { file: ".orca-agent-config.json",
        text: JSON.stringify({ created: ["../escaped"], modified: [{ path: "../escaped/implanted.txt", original: "pwned\n" }] }) + "\n" },
    ], budgetMs: 90000 });
  ok("S7 not hung", !r.hung);
  ok("S7 dies (unguarded state)", r.code === 1);
  ok("S7 containment warn", /escapes the worktree/.test(r.out + r.err));
  ok("S7 in-worktree bait untouched", readFileSync(join(r.wt, "victim-bait.txt"), "utf8") === "inside worktree — must survive\n");
  ok("S7 nothing written outside the worktree", !existsSync(join(r.dir, "escaped")));
  ok("S7 hostile manifest kept for manual resolution", existsSync(join(r.wt, ".orca-agent-config.json")));
});

// ---------------------------------------------------------------------------
// E12 — readiness gate, decline: a declared read with NO artifact on disk must
// stop the run BEFORE dispatching the consumer (stdin EOF = decline).
// ---------------------------------------------------------------------------
scenario("E12 readiness-abort (missing read -> prompt -> decline -> stop)", async () => {
  const r = await runFlow({ name: "e12", config: "../test/configs/cold.config.json", args: ["--only", "beta"], budgetMs: 45000 });
  ok("E12 not hung", !r.hung);
  eq("E12 exit code", r.code, 1);
  ok("E12 missing-input report", /Missing or incomplete input artifact\(s\):/.test(r.out + r.err));
  ok("E12 names the artifact", /Alpha \(`\.orca\/artifacts\/A\.md`\) — missing/.test(r.out + r.err));
  ok("E12 asks the user", /Run the producing step\(s\) now .* \[y\/N\]/.test(r.out + r.err));
  ok("E12 resume hint", /--from alpha/.test(r.out + r.err));
  eq("E12 consumer never dispatched", r.by("orchestration task-create").length, 0);
  eq("E12 status overall", r.status?.overall, "failed");
});

// ---------------------------------------------------------------------------
// E13 — readiness gate, accept: "y" re-runs the producer (out-of-run via
// --only), the fake writes the artifact, the consumer then completes.
// ---------------------------------------------------------------------------
scenario("E13 readiness-repair (prompt yes -> re-run producer -> continue)", async () => {
  const r = await runFlow({ name: "e13", config: "../test/configs/cold.config.json", args: ["--only", "beta"], stdinText: "y\n", budgetMs: 60000 });
  ok("E13 not hung", !r.hung);
  eq("E13 exit code", r.code, 0);
  ok("E13 repair attempt logged", /\[readiness\] re-running "Alpha" \(attempt 1\/3\)/.test(r.out + r.err));
  ok("E13 artifact ready logged", /\[readiness\] "Alpha" artifact ready -> \.orca\/artifacts\/A\.md/.test(r.out + r.err));
  eq("E13 both steps tasked (producer + consumer)", r.by("orchestration task-create").length, 2);
  eq("E13 producer tasked fresh, no reopen needed", r.by("orchestration task-update").filter((c) => c.flags.status === "ready").length, 0);
  eq("E13 alpha succeeded after repair", r.status?.steps.find((s) => s.id === "alpha")?.status, "succeeded");
  eq("E13 beta succeeded", r.status?.steps.find((s) => s.id === "beta")?.status, "succeeded");
  eq("E13 status overall", r.status?.overall, "succeeded");
  ok("E13 pipeline complete", /Pipeline COMPLETE/.test(r.out));
});

// ---------------------------------------------------------------------------
// E14 — readiness retries are finite: producer "succeeds" without writing the
// file; exactly readinessRetries (3) attempts, then the run stops.
// ---------------------------------------------------------------------------
scenario("E14 readiness-exhaust (3 attempts, then stop)", async () => {
  const r = await runFlow({ name: "e14", config: "../test/configs/cold.config.json", scenario: "no-artifact.cjs", args: ["--only", "beta"], stdinText: "y\n", budgetMs: 60000 });
  ok("E14 not hung", !r.hung);
  eq("E14 exit code", r.code, 1);
  eq("E14 exactly 3 repair dispatches", r.by("orchestration worker-start").length, 3);
  ok("E14 attempt 3 logged", /\[readiness\] re-running "Alpha" \(attempt 3\/3\)/.test(r.out + r.err));
  ok("E14 exhausted message", /still has no usable artifact after 3 readiness retries/.test(r.out + r.err));
  eq("E14 consumer never dispatched", r.by("orchestration task-create").length, 1);   // alpha only
  eq("E14 status overall", r.status?.overall, "failed");
});

// ---------------------------------------------------------------------------
// E14b — a repair attempt that settles outcome=unknown WITHOUT the artifact
// must not be blindly re-dispatched (double-dispatch doctrine), even with
// retries remaining.
// ---------------------------------------------------------------------------
scenario("E14b readiness-unknown (no blind retry during repair)", async () => {
  const r = await runFlow({ name: "e14b", config: "../test/configs/cold.config.json", scenario: "repair-unknown.cjs", args: ["--only", "beta"], stdinText: "y\n", budgetMs: 60000 });
  ok("E14b not hung", !r.hung);
  eq("E14b exit code", r.code, 1);
  ok("E14b no-blind-retry message", /not retrying without a definite outcome/.test(r.out + r.err));
  eq("E14b exactly one repair dispatch", r.by("orchestration worker-start").length, 1);
  eq("E14b status overall", r.status?.overall, "failed");
});

// ---------------------------------------------------------------------------
// E15 — min-size verdict: an existing but undersized artifact (5 bytes < the
// 200 default) is unready; declining stops the run with the too-small reason.
// ---------------------------------------------------------------------------
scenario("E15 readiness-min-bytes (undersized artifact is unready)", async () => {
  const r = await runFlow({ name: "e15", config: "../test/configs/cold.config.json", args: ["--only", "beta"], seedArtifacts: [{ file: "A.md", text: "tiny\n" }], budgetMs: 45000 });
  ok("E15 not hung", !r.hung);
  eq("E15 exit code", r.code, 1);
  ok("E15 too-small reason", /too small \(5 bytes < 200 min\)/.test(r.out + r.err));
  ok("E15 resume hint", /--from alpha/.test(r.out + r.err));
  eq("E15 consumer never dispatched", r.by("orchestration task-create").length, 0);
});

// ---------------------------------------------------------------------------
// E16 — readiness repair is TRANSITIVE: repairing a producer whose own reads
// are also missing must repair the whole chain, in pipeline order.
// ---------------------------------------------------------------------------
scenario("E16 readiness-transitive (repair walks the read chain)", async () => {
  const r = await runFlow({ name: "e16", config: "../test/configs/chain.config.json", args: ["--only", "gamma"], stdinText: "y\n", budgetMs: 60000 });
  ok("E16 not hung", !r.hung);
  eq("E16 exit code", r.code, 0);
  eq("E16 whole chain repaired (3 dispatches)", r.by("orchestration worker-start").length, 3);
  const order = r.calls.map((c) => {
    if (c.cmd !== "orchestration task-create") return null;
    return (String(c.flags.spec ?? "").match(/^# (.+)$/m) || [])[1] || "?";
  }).filter(Boolean);
  eq("E16 repair order follows the pipeline", order, ["Alpha", "Beta", "Gamma"]);
  ok("E16 pipeline complete", /Pipeline COMPLETE/.test(r.out));
});

// ---------------------------------------------------------------------------
// E17 — a repair attempt that never settles exits still-running with the
// consumer-group resume hint (terminal left open), like the main loop does.
// ---------------------------------------------------------------------------
scenario("E17 repair-hang (still-running repair keeps the resume hint)", async () => {
  const r = await runFlow({ name: "e17", config: "../test/configs/hang.config.json", scenario: "hang.cjs", args: ["--only", "beta"], stdinText: "y\n", budgetMs: 45000 });
  ok("E17 not hung", !r.hung);
  eq("E17 exit code", r.code, 1);
  ok("E17 still-running message names the producer", /"Alpha" [^\n]*was left OPEN to finish/.test(r.out + r.err));
  ok("E17 resume hint points at the consumer", /--from beta/.test(r.out + r.err));
  eq("E17 one repair dispatch", r.by("orchestration worker-start").length, 1);
  ok("E17 producer hard-cap note", /not settled after \d+min/.test(r.status?.steps.find((s) => s.id === "alpha")?.note ?? ""));
  eq("E17 status overall", r.status?.overall, "still-running");
});

// ---------------------------------------------------------------------------
// E18 — shipped default config on a fresh worktree: reads of config-DISABLED
// steps (grill) are optional inputs — the gate must not prompt or abort.
// ---------------------------------------------------------------------------
scenario("E18 readiness-skips-disabled (shipped config, fresh worktree, no prompt)", async () => {
  const r = await runFlow({ name: "e18", config: "flow-epic.json", args: ["--only", "po-backlog"], budgetMs: 120000 });
  ok("E18 not hung", !r.hung);
  eq("E18 exit code", r.code, 0);
  ok("E18 never reported missing inputs", !/Missing or incomplete input artifact/.test(r.out + r.err));
  ok("E18 never prompted", !/Run the producing step/.test(r.out + r.err));
  eq("E18 grill stays skipped", r.status?.steps.find((s) => s.id === "grill")?.status, "skipped");
  ok("E18 po-backlog dispatched", r.calls.some((c) => c.cmd === "orchestration task-create" && String(c.flags.spec ?? "").includes("# PO Backlog")));
  ok("E18 pipeline complete", /Pipeline COMPLETE/.test(r.out));
});

// ---------------------------------------------------------------------------
// E19 — nudge post-done recovery: worker_done(succeeded) but no artifact =>
// nudge the terminal; the file appears; the step settles with the ORIGINAL
// outcome and a recovered note. A further worker_done while held must not
// settle a member whose file was missing.
// ---------------------------------------------------------------------------
scenario("E19 nudge post-done recovery", async () => {
  const r = await runFlow({ name: "e19", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-recover.cjs", budgetMs: 60000 });
  ok("E19 not hung", !r.hung);
  eq("E19 exit code", r.code, 0);
  const textSends = r.by("terminal send").filter((cx) => String(cx.flags.text ?? "").includes("[orca-flow]"));
  eq("E19 exactly one nudge text", textSends.length, 1);
  ok("E19 nudge names the artifact path", /\.orca\/artifacts\/A\.md/.test(String(textSends[0]?.flags.text ?? "")));
  eq("E19 status overall", r.status?.overall, "succeeded");
  ok("E19 recovered note", /artifact recovered via nudge \(1 sent\)/.test(r.status?.steps[0]?.note ?? ""));
  ok("E19 artifact exists", existsSync(join(r.wt, ".orca", "artifacts", "A.md")));
  ok("E19 terminal closed at settlement", r.by("terminal close").length === 1);
});

// ---------------------------------------------------------------------------
// E24 — a mid-run nudge send FAILURE closes the budget without a delivered
// nudge; done-without-artifact then settles with the ORIGINAL outcome and an
// "(nudge undeliverable)" note — never "failed after 0 nudge(s)".
// ---------------------------------------------------------------------------
scenario("E24 nudge undeliverable keeps original outcome", async () => {
  const r = await runFlow({ name: "e24", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-undeliverable.cjs", budgetMs: 60000 });
  ok("E24 not hung", !r.hung);
  eq("E24 exit code", r.code, 0);
  ok("E24 a send was attempted", r.by("terminal send").length >= 1);
  eq("E24 status overall", r.status?.overall, "succeeded");
  ok("E24 undeliverable note", /artifact missing \(nudge undeliverable\)/.test(r.status?.steps[0]?.note ?? ""));
});

// ---------------------------------------------------------------------------
// E25 — post-done nudge safety: a terminal parked on a dialog after
// worker_done is NEVER typed into; the step keeps the original outcome.
// ---------------------------------------------------------------------------
scenario("E25 post-done parked terminal is not nudged", async () => {
  const r = await runFlow({ name: "e25", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-post-parked.cjs", budgetMs: 60000 });
  ok("E25 not hung", !r.hung);
  eq("E25 zero terminal sends", r.by("terminal send").length, 0);
  eq("E25 exit code", r.code, 0);
  eq("E25 status overall", r.status?.overall, "succeeded");
  ok("E25 parked note", /artifact missing \(terminal parked on the folder-trust check\)/.test(r.status?.steps[0]?.note ?? ""));
});

// ---------------------------------------------------------------------------
// E26 — post-done RE-nudge safety: a dialog that parks BETWEEN nudges is
// never typed into; the step keeps the original outcome (parked note).
// ---------------------------------------------------------------------------
scenario("E26 re-nudge spared when terminal reparks", async () => {
  const r = await runFlow({ name: "e26", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-post-reparked.cjs", budgetMs: 60000 });
  ok("E26 not hung", !r.hung);
  eq("E26 exit code", r.code, 0);
  const textSends = r.by("terminal send").filter((cx) => String(cx.flags.text ?? "").includes("[orca-flow]"));
  eq("E26 exactly one nudge text (re-nudge suppressed)", textSends.length, 1);
  eq("E26 status overall", r.status?.overall, "succeeded");
  ok("E26 parked note", /artifact missing \(terminal parked on the folder-trust check\)/.test(r.status?.steps[0]?.note ?? ""));
});

// ---------------------------------------------------------------------------
// E27 — run history: starting a NEW run snapshots the previous run's flat
// artifacts into runs/<seq>-<ts>/ (copy, not move — flat files stay for
// readiness/resume). A marker written between runs discriminates the
// archived copy from the run-2 overwrite.
// ---------------------------------------------------------------------------
scenario("E27 archive previous run on new run", async () => {
  const cfg = "../test/configs/cold.config.json";
  const r1 = await runFlow({ name: "e27", config: cfg });
  ok("E27 run1 ok", r1.code === 0 && !r1.hung);
  writeFileSync(join(r1.wt, ".orca", "artifacts", "A.md"), "RUN1 MARKER\n");
  const r2 = await runFlow({ name: "e27", config: cfg, reuseDir: r1.dir });
  ok("E27 run2 ok", r2.code === 0 && !r2.hung);
  const runsRoot = join(r2.wt, ".orca", "artifacts", "runs");
  const entries = existsSync(runsRoot) ? readdirSync(runsRoot) : [];
  eq("E27 exactly one archive folder", entries.length, 1);
  ok("E27 folder named seq-ts", /^0001-\d{8}-\d{6}$/.test(entries[0] ?? ""));
  eq("E27 archived A.md holds the marker", readFileSync(join(runsRoot, entries[0], "A.md"), "utf8"), "RUN1 MARKER\n");
  ok("E27 archived status.js exists", existsSync(join(runsRoot, entries[0], "status.js")));
  ok("E27 flat A.md overwritten by run 2", !/RUN1 MARKER/.test(readFileSync(join(r2.wt, ".orca", "artifacts", "A.md"), "utf8")));
});

// ---------------------------------------------------------------------------
// E28 — chooser defaults & bypass: with previous runs present the flow lists
// them; EOF/Enter/0 starts a NEW run (archive created, no restore); --new
// skips the prompt; dry-run lists read-only and archives nothing.
// ---------------------------------------------------------------------------
scenario("E28 chooser: EOF=new, --new bypass, dry-run lists only", async () => {
  const cfg = "../test/configs/cold.config.json";
  const r1 = await runFlow({ name: "e28", config: cfg });
  ok("E28 run1 ok (no prompt on empty worktree)", r1.code === 0 && !r1.hung);
  const r2 = await runFlow({ name: "e28", config: cfg, reuseDir: r1.dir });   // stdin=ignore => EOF => new
  ok("E28 run2 ok (EOF chose new)", r2.code === 0 && !r2.hung);
  ok("E28 run2 listed previous runs", /Previous runs in this worktree:/.test(r2.out + r2.err));
  ok("E28 run2 archived run1", existsSync(join(r2.wt, ".orca", "artifacts", "runs")));
  const r3 = await runFlow({ name: "e28", config: cfg, reuseDir: r1.dir, args: ["--new"] });
  ok("E28 run3 --new ok", r3.code === 0 && !r3.hung);
  ok("E28 run3 no prompt", !/Choose: <n>/.test(r3.out + r3.err));
  const rJunk = await runFlow({ name: "e28", config: cfg, reuseDir: r1.dir, stdinText: "1x\n" });
  ok("E28 junk input '1x' starts a new run", rJunk.code === 0 && !/resuming|restored/.test(rJunk.out + rJunk.err));
  const before = readdirSync(join(r3.wt, ".orca", "artifacts", "runs")).length;
  const r4 = await runFlow({ name: "e28", config: cfg, reuseDir: r1.dir, args: ["--dry-run"] });
  ok("E28 dry-run lists runs", /Previous runs in this worktree:/.test(r4.out));
  eq("E28 dry-run archives nothing", readdirSync(join(r3.wt, ".orca", "artifacts", "runs")).length, before);
});

// ---------------------------------------------------------------------------
// E28b — chooser: resuming the (current) incomplete run — no archive, no
// restore, the succeeded producer is NOT re-dispatched, run resumes from
// the failed step and completes.
// ---------------------------------------------------------------------------
scenario("E28b resume current incomplete run", async () => {
  const cfg = "../test/configs/cold.config.json";
  const r1 = await runFlow({ name: "e28b", config: cfg, scenario: "chooser-fail-beta.cjs" });
  eq("E28b run1 exit (beta failed)", r1.code, 1);
  const taskCreateAfterRun1 = r1.by("orchestration task-create").length;
  const r2 = await runFlow({ name: "e28b", config: cfg, reuseDir: r1.dir, stdinText: "1\n" });
  ok("E28b run2 ok", r2.code === 0 && !r2.hung);
  ok("E28b chose current", /resuming the current run from "beta"/.test(r2.out + r2.err));
  eq("E28b only beta re-tasked", r2.by("orchestration task-create").length - taskCreateAfterRun1, 1);
  ok("E28b no archive folder", !existsSync(join(r2.wt, ".orca", "artifacts", "runs")));
});

// ---------------------------------------------------------------------------
// E29 — chooser: resuming an ARCHIVED run. Run 1 fails at beta; its flat
// state (with a marker) is archived when run 2 starts fresh; run 3 picks the
// archived entry: run-2 state archived first, run-1 artifacts RESTORED
// (marker back), producer skipped, resume from beta.
// ---------------------------------------------------------------------------
scenario("E29 resume archived run restores and skips producer", async () => {
  const cfg = "../test/configs/cold.config.json";
  const r1 = await runFlow({ name: "e29", config: cfg, scenario: "chooser-fail-beta.cjs" });
  eq("E29 run1 exit", r1.code, 1);
  // The marker must clear readinessMinBytes (200, cf. E15): the restore path
  // SKIPS the producer, so beta reads this very file — an 11-byte marker
  // would (correctly) be rejected as "too small" and stop the run.
  const run1Marker = "RUN1 STATE\n" + "archived-run marker filler line to clear the readiness minimum\n".repeat(8);
  writeFileSync(join(r1.wt, ".orca", "artifacts", "A.md"), run1Marker);
  const r2 = await runFlow({ name: "e29", config: cfg, reuseDir: r1.dir });   // EOF => new; archives RUN1 STATE
  ok("E29 run2 ok", r2.code === 0 && !r2.hung);
  const taskCreateAfterRun2 = r2.by("orchestration task-create").length;      // 2 more (alpha+beta)
  const r3 = await runFlow({ name: "e29", config: cfg, reuseDir: r1.dir, stdinText: "2\n" }); // 1=current(run2), 2=archived 0001
  ok("E29 run3 ok", r3.code === 0 && !r3.hung);
  ok("E29 restored run 0001", /restored run 0001-\d{8}-\d{6}/.test(r3.out + r3.err));
  eq("E29 flat A.md restored to run-1 state", readFileSync(join(r3.wt, ".orca", "artifacts", "A.md"), "utf8"), run1Marker);
  eq("E29 only beta re-tasked", r3.by("orchestration task-create").length - taskCreateAfterRun2, 1);
  const runsEntries = readdirSync(join(r3.wt, ".orca", "artifacts", "runs"));
  eq("E29 two archive folders (run1 then run2 states)", runsEntries.length, 2);
});

// ---------------------------------------------------------------------------
// E30 — chooser: picking a COMPLETED run notes it and runs fresh (archive of
// the completed state + full re-dispatch from step 1).
// ---------------------------------------------------------------------------
scenario("E30 completed-run choice starts a new run", async () => {
  const cfg = "../test/configs/cold.config.json";
  const r1 = await runFlow({ name: "e30", config: cfg });
  ok("E30 run1 ok", r1.code === 0 && !r1.hung);
  const taskCreateAfterRun1 = r1.by("orchestration task-create").length;      // 2
  const r2 = await runFlow({ name: "e30", config: cfg, reuseDir: r1.dir, stdinText: "1\n" }); // pick (current), completed
  ok("E30 run2 ok", r2.code === 0 && !r2.hung);
  ok("E30 already-completed note", /already completed — starting a new run/.test(r2.out + r2.err));
  eq("E30 full fresh run (both steps re-tasked)", r2.by("orchestration task-create").length - taskCreateAfterRun1, 2);
  eq("E30 completed state archived", readdirSync(join(r2.wt, ".orca", "artifacts", "runs")).length, 1);
});

// ---------------------------------------------------------------------------
// E20 — nudge budget exhaustion: worker_done(succeeded) but no artifact and
// the terminal never complies => exactly nudgeRetries nudges, then the step
// settles FAILED (the artifact file is ground truth, not worker_done).
// ---------------------------------------------------------------------------
scenario("E20 nudge exhausted settles failed", async () => {
  const r = await runFlow({ name: "e20", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-exhaust.cjs", budgetMs: 60000 });
  ok("E20 not hung", !r.hung);
  eq("E20 exit code", r.code, 1);
  const textSends = r.by("terminal send").filter((cx) => String(cx.flags.text ?? "").includes("[orca-flow]"));
  eq("E20 exactly two nudge texts", textSends.length, 2);
  eq("E20 step failed", r.status?.steps[0]?.status, "failed");
  ok("E20 exhaustion note", /artifact missing after 2 nudge\(s\)/.test(r.status?.steps[0]?.note ?? ""));
});

// ---------------------------------------------------------------------------
// E21 — mid-run nudge: frozen preview + stale heartbeat + missing artifact +
// no worker_done => nudge fires; the recovered worker_done then settles the
// step succeeded. Pins the double-idle-evidence path.
// ---------------------------------------------------------------------------
scenario("E21 nudge mid-run idle recovery", async () => {
  const r = await runFlow({ name: "e21", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-midrun.cjs", budgetMs: 60000 });
  ok("E21 not hung", !r.hung);
  eq("E21 exit code", r.code, 0);
  const textSends = r.by("terminal send").filter((cx) => String(cx.flags.text ?? "").includes("[orca-flow]"));
  eq("E21 exactly one nudge text", textSends.length, 1);
  eq("E21 status overall", r.status?.overall, "succeeded");
  ok("E21 artifact exists", existsSync(join(r.wt, ".orca", "artifacts", "A.md")));
});

// ---------------------------------------------------------------------------
// E22 — parked-prompt safety: a nudge-eligible member parked on a dialog is
// NEVER nudged (zero terminal sends) and keeps the parked semantics (warn +
// hold to the hard cap). The hard safety rule of the nudge feature.
// ---------------------------------------------------------------------------
scenario("E22 parked dialog is never nudged", async () => {
  const r = await runFlow({ name: "e22", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-parked.cjs", budgetMs: 90000 });
  ok("E22 not hung", !r.hung);
  eq("E22 zero terminal sends", r.by("terminal send").length, 0);
  ok("E22 parked warn present", /PARKED on a permission-rule confirmation/.test(r.out + r.err));
  eq("E22 status overall", r.status?.overall, "still-running");
  ok("E22 exit code (hard cap stop)", r.code === 1);
});

// ---------------------------------------------------------------------------
// E23 — nudgeRetries: 0 disables nudging for the step: done-without-artifact
// settles with the ORIGINAL outcome (legacy) and a "(nudge disabled)" note;
// zero terminal sends. The consumer-side readiness gate remains the net.
// ---------------------------------------------------------------------------
scenario("E23 nudgeRetries 0 disables nudging", async () => {
  const r = await runFlow({ name: "e23", config: "../test/configs/nudge-off.config.json",
    scenario: "nudge-exhaust.cjs", budgetMs: 45000 });
  ok("E23 not hung", !r.hung);
  eq("E23 exit code", r.code, 0);
  eq("E23 zero terminal sends", r.by("terminal send").length, 0);
  eq("E23 status overall", r.status?.overall, "succeeded");
  ok("E23 disabled note", /artifact missing \(nudge disabled\)/.test(r.status?.steps[0]?.note ?? ""));
});

// N3 — default-off: an EMPTY notify template sends nothing and stays silent.
// Baseline pin recorded BEFORE the engine feature lands; it must hold after.
// ---------------------------------------------------------------------------
scenario("N3 notify default-off (empty template: zero sends, zero warns)", async () => {
  const hook = await recordHook();
  try {
    const r = await runFlow({ name: "n3", config: "../test/configs/cold.config.json",
      notify: { enabled: true, provider: "", url: "", token: "", chatId: "", to: "", events: ["step", "run"] },
      budgetMs: 90000 });
    ok("N3 not hung", !r.hung);
    eq("N3 exit code", r.code, 0);
    eq("N3 zero notifications", hook.hits.length, 0);
    ok("N3 no notify output", !/\[notify\]/.test(r.out + r.err));
  } finally { await hook.close(); }
});

// ---------------------------------------------------------------------------
// N1 — happy: every step settlement and the run summary are POSTed to the
// webhook in order, with the right text; dry-run announces notify state and
// sends nothing.
// ---------------------------------------------------------------------------
scenario("N1 notify happy (2 step + 1 run POSTs, dry-run sends nothing)", async () => {
  const hook = await recordHook();
  try {
    const cfg = { enabled: true, provider: "slack", url: hook.url, token: "", chatId: "", to: "", events: ["step", "run"] };
    const dry = await runFlow({ name: "n1dry", config: "../test/configs/cold.config.json", args: ["--dry-run"], notify: cfg, budgetMs: 30000 });
    eq("N1 dry-run exit", dry.code, 0);
    ok("N1 dry-run announces notify", /Notifications: on \(slack, events: step,run\)/.test(dry.out));
    eq("N1 dry-run sent nothing", hook.hits.length, 0);

    const r = await runFlow({ name: "n1", config: "../test/configs/cold.config.json", notify: cfg, budgetMs: 90000 });
    ok("N1 not hung", !r.hung);
    eq("N1 exit code", r.code, 0);
    eq("N1 three notifications (2 steps + run)", hook.hits.length, 3);
    ok("N1 alpha step text", /Step "Alpha" SUCCEEDED in .+ \(attempt 1\) -> \.orca\/artifacts\/A\.md/.test(hook.hits[0]?.body?.text ?? ""));
    ok("N1 beta step text", /Step "Beta" SUCCEEDED/.test(hook.hits[1]?.body?.text ?? ""));
    ok("N1 run text", /Run run-\d+ SUCCEEDED in .+ — "test objective"/.test(hook.hits[2]?.body?.text ?? ""));
  } finally { await hook.close(); }
});

// ---------------------------------------------------------------------------
// N2 — degradation: a dead webhook warns exactly once (latch), never blocks
// and never changes the outcome.
// ---------------------------------------------------------------------------
scenario("N2 notify degradation (dead webhook: one warn, run unaffected)", async () => {
  const r = await runFlow({ name: "n2", config: "../test/configs/cold.config.json",
    notify: { enabled: true, provider: "slack", url: "http://127.0.0.1:1/hook", token: "", chatId: "", to: "", events: ["step", "run"] },
    budgetMs: 90000 });
  ok("N2 not hung", !r.hung);
  eq("N2 exit code", r.code, 0);
  const warns = (r.out + r.err).match(/\[notify\] disabled: delivery failed/g) || [];
  eq("N2 exactly one delivery warn (latch works)", warns.length, 1);
  eq("N2 pipeline unaffected (both steps ok)", (r.out + r.err).match(/\[ok\] /g)?.length, 2);
  eq("N2 status overall", r.status?.overall, "succeeded");
});

// ---------------------------------------------------------------------------
// N4 — the still-running chat hint must point PAST the live worker (re-
// dispatching it is the double-dispatch the kit forbids), matching the
// console's advice; a FAILED step resumes from itself (unpinned — shares notifyRun with the pinned path).
// ---------------------------------------------------------------------------
scenario("N4 notify still-running hint (points at the NEXT step)", async () => {
  const hook = await recordHook();
  try {
    const r = await runFlow({ name: "n4", config: "../test/configs/hang.config.json", scenario: "hang.cjs",
      notify: { enabled: true, provider: "slack", url: hook.url, token: "", chatId: "", to: "", events: ["step", "run"] },
      budgetMs: 45000 });
    eq("N4 exit code", r.code, 1);
    eq("N4 two notifications (alpha step + run)", hook.hits.length, 2);
    const runText = hook.hits[1]?.body?.text ?? "";
    ok("N4 run names the stuck step", /stuck at: alpha/.test(runText));
    ok("N4 hint points past the live worker", /--from beta/.test(runText));
    ok("N4 never suggests re-dispatching the live worker", !/--from alpha/.test(runText));
  } finally { await hook.close(); }
});

// ---------------------------------------------------------------------------
// N5 — mixed parallel group (one live worker + one failed sibling): the chat
// hint must point past the whole group, never at the failed sibling — re-
// running its group would re-dispatch the live worker.
// ---------------------------------------------------------------------------
scenario("N5 notify mixed group (hint points past the live group)", async () => {
  const hook = await recordHook();
  try {
    const r = await runFlow({ name: "n5", config: "../test/configs/parallel-hang.config.json", scenario: "parallel-mixed.cjs",
      notify: { enabled: true, provider: "slack", url: hook.url, token: "", chatId: "", to: "", events: ["step", "run"] },
      budgetMs: 45000 });
    eq("N5 exit code", r.code, 1);
    eq("N5 three notifications (right failed, left still-running, run)", hook.hits.length, 3);
    const runText = hook.hits[2]?.body?.text ?? "";
    ok("N5 run names the live worker as stuck", /stuck at: left/.test(runText));
    ok("N5 hint points past the group", /--from join/.test(runText));
    ok("N5 never suggests re-running the failed sibling's group", !/--from right/.test(runText));
  } finally { await hook.close(); }
});

// ---------------------------------------------------------------------------
// F — fast validation: shipped configs + CLI/config guards. These die (or
// dry-run) before any agent work; budgets are tight.
// ---------------------------------------------------------------------------
scenario("F1 shipped configs dry-run cleanly", async () => {
  for (const cfg of [null, "flow-hotfix.json", "flow-feature.json", "flow-epic.json"]) {
    const label = cfg || "flow.config.json (default)";
    const r = await runFlow({ name: "f1", config: cfg, args: ["--dry-run"], objective: "suite smoke", budgetMs: 30000 });
    ok(`F1 ${label} not hung`, !r.hung);
    eq(`F1 ${label} exit`, r.code, 0);
    ok(`F1 ${label} prints dry-run banner`, /Dry-run — no agents called/.test(r.out));
    ok(`F1 ${label} lists steps`, /^\s+1\. /m.test(r.out));
  }
});

// fixtures are deliberately defaults-free: they die during load-time validation, before any timing applies
const BAD_CONFIGS = [
  ["F2 unknown parallelWith target", "bad-parallel-unknown.json", /parallelWith "ghost" is not a known step id/],
  ["F3 chained parallelWith", "bad-parallel-chain.json", /parallelWith chains are not allowed/],
  ["F4 non-contiguous parallel group", "bad-parallel-gap.json", /must be contiguous/],
  ["F5 member reads its target", "bad-parallel-reads.json", /dependent steps cannot run in parallel with what they read/],
  ["F10 forward read", "bad-forward-read.json", /reads "late" which has not run yet — reorder the pipeline/],
  ["F11 read of a writes-less step", "bad-reads-no-writes.json", /reads "ghost" which has no "writes" — nothing to read/],
  ["F12 negative nudgeRetries", "bad-nudge-negative.json", /nudgeRetries must be a non-negative integer/],
  ["F12b zero nudgeTimeoutMs", "bad-nudge-zero-timeout.json", /nudgeTimeoutMs must be a positive integer/],
  ["F13 negative step maxRetries", "bad-retry-per-step.json", /step "reviewer": maxRetries must be a non-negative integer \(got -1\)/],
  ["F13b fractional global maxRetries", "bad-retry-global.json", /config: maxRetries must be a non-negative integer \(got 1.5\)/],
  // Agent-config validation (F20-F26 — renamed from the feature branch's F13-F19:
  // main's v2.3.1 took F13/F13b for the retry-budget rules).
  ["F20 unknown skill ref", "bad-skill-unknown-ref.json", /references unknown skill "ghost"/],
  ["F21 unknown mcp ref", "bad-mcp-unknown-ref.json", /references unknown mcp server "ghost"/],
  ["F22 skill with both path and prompt", "bad-skill-both.json", /skill "broken": "path" and "prompt" are mutually exclusive/],
  ["F23 mcp with neither command nor url", "bad-mcp-none.json", /mcp server "broken": must have either "command" or "url"/],
  ["F24 skill path not found", "bad-skill-path-missing.json", /skill "broken": path "skills\/nope-does-not-exist" not found/],
  ["F20b skill with neither path nor prompt", "bad-skill-none.json", /skill "broken": must have either "path" or "prompt"/],
  ["F20c inline skill missing description", "bad-skill-no-desc.json", /skill "broken": inline skill requires "description"/],
  ["F23b mcp with both command and url", "bad-mcp-both.json", /mcp server "broken": "command" and "url" are mutually exclusive/],
  ["F25 skill name with path separators", "bad-skill-name.json", /names must not contain path separators/],
  ["F26 step skills not an array", "bad-skills-type.json", /"skills" must be an array of registry names/],
];
for (const [name, file, re] of BAD_CONFIGS) {
  scenario(name, async () => {
    const r = await runFlow({ name: file.replace(".json", ""), config: `../test/configs/${file}`, objective: "validate", budgetMs: 15000 });
    ok(`${name} not hung`, !r.hung);
    eq(`${name} exit code`, r.code, 1);
    ok(`${name} message`, re.test(r.out + r.err));
  });
}

scenario("F6 --grill-me and --no-grill-me are mutually exclusive", async () => {
  const r = await runFlow({ name: "f6", args: ["--grill-me", "--no-grill-me"], objective: "x", budgetMs: 15000 });
  ok("F6 not hung", !r.hung);
  eq("F6 exit code", r.code, 1);
  ok("F6 message", /mutually exclusive/.test(r.out + r.err));
});

scenario("F7 --status-preview refuses real-run mixes", async () => {
  const r = await runFlow({ name: "f7", args: ["--status-preview"], objective: "build it", budgetMs: 15000 });
  ok("F7 not hung", !r.hung);
  eq("F7 exit code", r.code, 1);
  ok("F7 message", /renders a SAMPLE status page/.test(r.out + r.err));
});

scenario("F8 objective is required for real runs", async () => {
  const r = await runFlow({ name: "f8", objective: "", budgetMs: 15000 });
  ok("F8 not hung", !r.hung);
  eq("F8 exit code", r.code, 1);
  ok("F8 message", /An objective is required/.test(r.out + r.err));
});

scenario("F9 --from must name an enabled step", async () => {
  const r = await runFlow({ name: "f9", args: ["--from", "ghost"], objective: "x", budgetMs: 15000 });
  ok("F9 not hung", !r.hung);
  eq("F9 exit code", r.code, 1);
  ok("F9 message", /is not among the enabled steps/.test(r.out + r.err));
});

scenario("F14 dry-run shows per-step retry budget", async () => {
  const r = await runFlow({ name: "f14", config: "../test/configs/retry-per-step.config.json", args: ["--dry-run"], objective: "suite smoke", budgetMs: 30000 });
  ok("F14 not hung", !r.hung);
  eq("F14 exit code", r.code, 0);
  ok("F14 step budget flag rendered", /\{onFail->coder x3\}/.test(r.out));
  ok("F14 bare flag not left behind", !/\{onFail->coder\}/.test(r.out));
  ok("F14 global budget not suffixed", !/x1\}/.test(r.out));
});

// ---------------------------------------------------------------------------
// I — installer (bin/init.mjs, the npx entry). I1 runs it for real in an empty
// temp "user project" — the exact repro of the v2.0.0 ENOENT (the whitelist
// gained .orca/workflow-template/* files but only .orca itself was mkdir'd).
// I2 guards the documented invariant: FILES must mirror package.json "files"
// (a drift either corrupts the package or makes init die on a missing source).
// ---------------------------------------------------------------------------
async function runInit({ name, dir: existingDir = null, args = [], budgetMs = 15000 }) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), `orca-init-${name}-`));
  if (!dirsOfCurrentScenario.includes(dir)) dirsOfCurrentScenario.push(dir);
  const child = spawn(NODE, [join(REPO, "bin", "init.mjs"), ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; let err = ""; let hung = false;
  const timer = setTimeout(() => { hung = true; hungInCurrentScenario = true; child.kill(); }, budgetMs);
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => child.on("exit", (c) => r(c)));
  clearTimeout(timer);
  return { code, out, err, hung, dir };
}

scenario("I1 installer (empty project: every whitelisted file lands)", async () => {
  const r = await runInit({ name: "i1" });
  ok("I1 not hung", !r.hung);
  eq("I1 exit code", r.code, 0);
  ok("I1 no copy failure", !/copy failed/.test(r.out + r.err), (r.out + r.err).trim());
  for (const f of [
    "flow.mjs", "agent-config.mjs", "agent-scanner.mjs", "strategy-wizard.mjs",
    "gate-verify.mjs", "worktree-isolation.mjs", "merge-danger.mjs", "health.mjs", "watchdog.mjs", "preflight.mjs", "issue-tracker.mjs", "ci-generator.mjs", "ledger.mjs",
    "lib/orca-cli.mjs", "lib/sanitize.mjs", "lib/status.mjs", "lib/status-template.html", "lib/usage.mjs", "lib/notify.mjs", "lib/nudge.mjs", "lib/runner.mjs",
    "flow.config.json", "flow-hotfix.json", "flow-feature.json", "flow-epic.json",
    "CONFIGURATION.md", "README.md", "notify.json",
  ])
    ok(`I1 installed .orca/${f}`, existsSync(join(r.dir, ".orca", f)));
  ok("I1 legacy designer.mjs NOT shipped", !existsSync(join(r.dir, ".orca", "designer.mjs")));
  ok("I1 legacy designer.html NOT shipped", !existsSync(join(r.dir, ".orca", "designer.html")));
  ok("I1 installed orca.yaml", existsSync(join(r.dir, "orca.yaml")));
  ok("I1 .gitignore got the artifacts line", readFileSync(join(r.dir, ".gitignore"), "utf8").includes(".orca/artifacts/"));
});

scenario("I2 FILES whitelist mirrors package.json files", async () => {
  const src = readFileSync(join(REPO, "bin", "init.mjs"), "utf8");
  const files = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).files
    .filter((f) => f !== "bin/").sort();
  const whitelist = src.slice(src.indexOf("const FILES = ["), src.indexOf("];", src.indexOf("const FILES = [")))
    .match(/"[^"]+"/g)?.map((s) => s.slice(1, -1)).sort() ?? [];
  eq("I2 whitelist matches package.json files", whitelist, files);
});

// ---------------------------------------------------------------------------
// W — Local Agent & Subscription Scanner + Pre-Dev Strategy Wizard (replaces
// the legacy web designer with terminal-first scan + conversational confirm).
// ---------------------------------------------------------------------------
scenario("W1 agent-scanner recommends cross-family routing & never leaks secrets", async () => {
  const { scanLocalAgents, recommendStrategy, formatScanReport } = await import(join(REPO, ".orca", "agent-scanner.mjs"));
  const mockOrcaData = {
    opencode: { accounts: [{ id: "acc-secret-1", label: "opencode" }] },
    codex: { systemDefault: { hasAuth: true, email: "private-secret@example.com" } },
    rateLimits: {
      codex: { status: "ok", planType: "plus", session: { usedPercent: 5 }, weekly: { usedPercent: 12 } },
      opencodeGo: { status: "ok", session: { usedPercent: 0 }, weekly: { usedPercent: 10 }, monthly: { usedPercent: 30 } },
      antigravity: { status: "ok", session: { usedPercent: 40 }, weekly: { usedPercent: 20 } },
      claude: { status: "unavailable", error: "No subscription plan — API key billing" },
    },
  };
  const scan = scanLocalAgents({
    mockOrcaData,
    mockBins: { orca: "/bin/orca", agy: "/bin/agy", codex: "/bin/codex", claude: "/bin/claude", opencode2: "/bin/opencode2", opencode: "/bin/opencode", zcode: "/bin/zcode" },
    mockConfigs: { agy: true, codex: true, claude: true, opencode2: true, opencode: true, zcode: true },
  });
  const rec = recommendStrategy(scan);
  const report = formatScanReport(scan, rec);
  eq("W1 coder prefers opencode2 over opencode", rec.roles.coder, "opencode2");
  eq("W1 coordinator prefers agy", rec.roles.coordinator, "agy");
  eq("W1 visual gate prefers agy", rec.roles.visual, "agy");
  eq("W1 reviewer is cross-family (codex)", rec.roles.reviewer, "codex");
  ok("W1 crossFamily=true", rec.crossFamily);
  ok("W1 report never leaks email", !report.includes("private-secret@example.com"));
  ok("W1 report never leaks account id", !report.includes("acc-secret-1"));
  ok("W1 serialized scan never leaks email", !JSON.stringify(scan).includes("private-secret@example.com"));

  // Single-family degradation emits warning
  const singleScan = scanLocalAgents({
    mockOrcaData: null,
    mockBins: { orca: "/bin/orca", opencode2: "/bin/opencode2" },
    mockConfigs: { opencode2: true },
  });
  const singleRec = recommendStrategy(singleScan);
  ok("W1 single-family sets crossFamily=false", !singleRec.crossFamily);
  ok("W1 single-family warns user", singleRec.warnings.some((w) => /one model family/i.test(w)));
});

scenario("W2 strategy-wizard updates all 3 tracks, flow.config.json, and writes STRATEGY.md", async () => {
  const { applyStrategyToProject } = await import(join(REPO, ".orca", "strategy-wizard.mjs"));
  const r = await runInit({ name: "w2", args: ["--no-interactive"] });
  eq("W2 init exit", r.code, 0);
  const res = applyStrategyToProject(r.dir, {
    defaultTrack: "flow-epic.json",
    targetBranch: "staging",
    protectedBranches: ["main", "master", "release"],
    projectNote: "pnpm test && pnpm lint",
    roles: { coordinator: "agy", visual: "agy", coder: "opencode2", coderAlt: "zcode", reviewer: "codex", release: "codex" },
  });
  ok("W2 updated STRATEGY.md", existsSync(res.strategyPath));
  const stratMd = readFileSync(res.strategyPath, "utf8");
  ok("W2 STRATEGY.md mentions flow-epic.json", stratMd.includes("flow-epic.json"));
  ok("W2 STRATEGY.md mentions staging", stratMd.includes("staging"));
  ok("W2 STRATEGY.md mentions pnpm test", stratMd.includes("pnpm test && pnpm lint"));
  const epic = JSON.parse(readFileSync(join(r.dir, ".orca", "flow-epic.json"), "utf8"));
  eq("W2 epic targetBranch updated", epic.defaults.targetBranch, "staging");
  eq("W2 epic worker-backend agent", epic.pipeline.find((s) => s.id === "worker-backend").agent, "opencode2");
  eq("W2 epic worker-frontend agent", epic.pipeline.find((s) => s.id === "worker-frontend").agent, "zcode");
  eq("W2 epic senior-audit agent", epic.pipeline.find((s) => s.id === "senior-audit").agent, "codex");
  eq("W2 epic visual-gate agent", epic.pipeline.find((s) => s.id === "visual-gate").agent, "agy");
  ok("W2 epic preserves // metadata comments", typeof epic["//"] === "string" && typeof epic["//usage"] === "string");
  const defCfg = JSON.parse(readFileSync(join(r.dir, ".orca", "flow.config.json"), "utf8"));
  ok("W2 flow.config.json synced from chosen defaultTrack (epic)", defCfg.pipeline.some((s) => s.id === "worker-backend"));
});

scenario("W3 flow.mjs --scan --json --no-orca works offline without objective", async () => {
  const r = await runFlow({ name: "w3", args: ["--scan", "--json", "--no-orca"], objective: "", budgetMs: 15000 });
  ok("W3 not hung", !r.hung);
  eq("W3 exit code", r.code, 0);
  const parsed = JSON.parse(r.out);
  ok("W3 returns scan object", Boolean(parsed.scan && Array.isArray(parsed.scan.agents)));
  ok("W3 returns recommendation roles", Boolean(parsed.recommendation && parsed.recommendation.roles && parsed.recommendation.roles.coder));
});

scenario("W4 bin/init.mjs --scan and --apply-recommended --no-orca work end-to-end", async () => {
  const s = await runInit({ name: "w4-scan", args: ["--scan", "--json", "--no-orca"] });
  ok("W4 scan not hung", !s.hung);
  eq("W4 scan exit code", s.code, 0);
  ok("W4 scan valid JSON", Boolean(JSON.parse(s.out).recommendation));

  const a = await runInit({ name: "w4-apply", args: ["--apply-recommended", "--no-orca"] });
  ok("W4 apply not hung", !a.hung);
  eq("W4 apply exit code", a.code, 0);
  ok("W4 STRATEGY.md generated", existsSync(join(a.dir, ".orca", "STRATEGY.md")));
});

// ---------------------------------------------------------------------------
// P1 — Isolated per-step Worktrees for parallel coding workers:
// worker-backend ∥ worker-frontend each receive their own physically separate
// worktree, task branch, isolated agent-config files, synced upstream reads,
// synced-back reports, and WORKTREES.json handoff manifest.
// ---------------------------------------------------------------------------
scenario("P1 isolated-worktree parallel workers (separate dirs, branches, skills, WORKTREES.json)", async () => {
  const HEAD_SHA = "1111111111111111111111111111111111111111";
  const r = await runFlow({
    name: "p1",
    config: "../test/configs/isolated-parallel.config.json",
    scenario: "isolated-snap.cjs",
    objective: "Exam Workbench",
    env: { ORCA_VERIFY_HEAD_SHA: HEAD_SHA },
    budgetMs: 90000,
  });
  ok("P1 not hung", !r.hung);
  eq("P1 exit code", r.code, 0);
  eq("P1 status overall", r.status?.overall, "succeeded");
  const creates = r.by("worktree create");
  eq("P1 created two isolated worktrees", creates.length, 2);
  ok("P1 backend branch created", creates.some((c) => String(c.flags.branch ?? "").includes("worker-backend")));
  ok("P1 frontend branch created", creates.some((c) => String(c.flags.branch ?? "").includes("worker-frontend")));
  const snaps = r.state?.extra?.snaps || {};
  const beSnap = snaps["Worker Backend"];
  const feSnap = snaps["Worker Frontend"];
  ok("P1 backend snapshot captured", Boolean(beSnap));
  ok("P1 frontend snapshot captured", Boolean(feSnap));
  ok("P1 backend & frontend ran in DIFFERENT physical directories", beSnap && feSnap && beSnap.wtDir !== feSnap.wtDir && beSnap.wtDir !== r.wt && feSnap.wtDir !== r.wt);
  ok("P1 backend & frontend used DIFFERENT --worktree selectors", beSnap && feSnap && beSnap.worktreeFlag !== feSnap.worktreeFlag && beSnap.worktreeFlag !== "name:testlab");
  ok("P1 backend got synced CONTRACT_REVIEW.md", beSnap?.hasSyncedContractReview === true);
  ok("P1 frontend got synced CONTRACT_REVIEW.md", feSnap?.hasSyncedContractReview === true);
  ok("P1 backend skills isolated (no fe-skill leak)", beSnap?.agentsText.includes("be-skill") && !beSnap?.agentsText.includes("fe-skill"));
  ok("P1 frontend skills isolated (no be-skill leak)", feSnap?.agentsText.includes("fe-skill") && !feSnap?.agentsText.includes("be-skill"));
  ok("P1 backend worktree restored AGENTS.md after run", beSnap && !existsSync(join(beSnap.wtDir, "AGENTS.md")));
  ok("P1 frontend worktree restored AGENTS.md after run", feSnap && !existsSync(join(feSnap.wtDir, "AGENTS.md")));
  ok("P1 BACKEND_CHANGES.md synced back to integration wt", existsSync(join(r.wt, ".orca", "artifacts", "BACKEND_CHANGES.md")));
  ok("P1 FRONTEND_CHANGES.md synced back to integration wt", existsSync(join(r.wt, ".orca", "artifacts", "FRONTEND_CHANGES.md")));
  const mfPath = join(r.wt, ".orca", "artifacts", "WORKTREES.json");
  ok("P1 WORKTREES.json manifest written", existsSync(mfPath));
  const mf = existsSync(mfPath) ? JSON.parse(readFileSync(mfPath, "utf8")) : {};
  eq("P1 manifest records both isolated tasks as succeeded", [mf.tasks?.["worker-backend"]?.status, mf.tasks?.["worker-frontend"]?.status], ["succeeded", "succeeded"]);
  const mergeTask = r.by("orchestration task-create").find((c) => String(c.flags.spec ?? "").includes("# Task Review Merge"));
  ok("P1 Reviewer merge spec resolves {worktreesManifest} and {targetBranch}", Boolean(mergeTask && String(mergeTask.flags.spec).includes("WORKTREES.json") && String(mergeTask.flags.spec).includes("dev")));
});

// ---------------------------------------------------------------------------
// P2 — Hard Verdict Gate on live settlement:
// Reviewer exits outcome=succeeded while writing VERDICT: FAIL on attempt 1 ->
// flow.mjs MUST override outcome to failed and loop back via onFailGoto!
// ---------------------------------------------------------------------------
scenario("P2 hard verdict gate overrides outcome=succeeded when artifact has VERDICT: FAIL", async () => {
  const HEAD_SHA = "2222222222222222222222222222222222222222";
  const r = await runFlow({
    name: "p2",
    config: "../test/configs/verdict-gate.config.json",
    scenario: "verdict-fail-once.cjs",
    env: { ORCA_VERIFY_HEAD_SHA: HEAD_SHA },
    budgetMs: 90000,
  });
  ok("P2 not hung", !r.hung);
  eq("P2 exit code", r.code, 0);
  ok("P2 logged gate-verify override warning", /\[gate-verify\].*overriding outcome to failed/.test(r.out + r.err));
  ok("P2 triggered onFailGoto retry loop", /FAILED.*back to "Contract Arch"/.test(r.out));
  eq("P2 Contract Review ran twice", r.state?.extra?.reviewRuns, 2);
  eq("P2 status overall succeeded after retry", r.status?.overall, "succeeded");
});

// ---------------------------------------------------------------------------
// P3 — Hard Verdict Gate on --from resume:
// Seeded CONTRACT_REVIEW.md > 200B with VERDICT: FAIL MUST hard-block --from worker!
// ---------------------------------------------------------------------------
scenario("P3 --from resume hard-blocks when CONTRACT_REVIEW.md (>200B) has VERDICT: FAIL", async () => {
  const HEAD_SHA = "3333333333333333333333333333333333333333";
  const r = await runFlow({
    name: "p3",
    config: "../test/configs/verdict-gate.config.json",
    args: ["--from", "worker"],
    env: { ORCA_VERIFY_HEAD_SHA: HEAD_SHA },
    seedArtifacts: [{
      file: "CONTRACT_REVIEW.md",
      text: `# Contract Review\n\nContract-Commit: ${HEAD_SHA}\n\n` + "Blocker details exceeding 200 bytes easily.\n".repeat(6) + "\nVERDICT: FAIL\n",
    }],
    stdinText: "n\n",
    budgetMs: 60000,
  });
  ok("P3 not hung", !r.hung);
  ok("P3 refused to run (non-zero exit)", r.code !== 0);
  ok("P3 reported verdict mismatch", /verdict is "FAIL", required "PASS"/.test(r.out + r.err));
  eq("P3 zero workers dispatched", r.by("orchestration worker-start").length, 0);
});

// ---------------------------------------------------------------------------
// P4 — Hard Contract-Commit SHA Gate on --from resume:
// Stale SHA, short SHA, and duplicate headers MUST block; exact 40-char HEAD SHA + VERDICT: PASS succeeds!
// ---------------------------------------------------------------------------
scenario("P4 Contract-Commit SHA gate rejects stale/short/duplicate SHAs and accepts exact 40-char HEAD", async () => {
  const HEAD_SHA = "4444444444444444444444444444444444444444";
  const STALE_SHA = "5555555555555555555555555555555555555555";
  const filler = "Contract review details clearing 200 bytes.\n".repeat(6);

  const stale = await runFlow({
    name: "p4-stale", config: "../test/configs/verdict-gate.config.json", args: ["--from", "worker"],
    env: { ORCA_VERIFY_HEAD_SHA: HEAD_SHA }, stdinText: "n\n",
    seedArtifacts: [{ file: "CONTRACT_REVIEW.md", text: `# Review\nContract-Commit: ${STALE_SHA}\n\n${filler}\nVERDICT: PASS\n` }],
  });
  ok("P4 stale SHA blocked", stale.code !== 0 && /stale Contract-Commit/.test(stale.out + stale.err));
  eq("P4 stale SHA zero dispatches", stale.by("orchestration worker-start").length, 0);

  const shortSha = await runFlow({
    name: "p4-short", config: "../test/configs/verdict-gate.config.json", args: ["--from", "worker"],
    env: { ORCA_VERIFY_HEAD_SHA: HEAD_SHA }, stdinText: "n\n",
    seedArtifacts: [{ file: "CONTRACT_REVIEW.md", text: `# Review\nContract-Commit: 44444444\n\n${filler}\nVERDICT: PASS\n` }],
  });
  ok("P4 short SHA blocked", shortSha.code !== 0 && /full 40-char lowercase hex SHA/.test(shortSha.out + shortSha.err));

  const dupSha = await runFlow({
    name: "p4-dup", config: "../test/configs/verdict-gate.config.json", args: ["--from", "worker"],
    env: { ORCA_VERIFY_HEAD_SHA: HEAD_SHA }, stdinText: "n\n",
    seedArtifacts: [{ file: "CONTRACT_REVIEW.md", text: `# Review\nContract-Commit: ${HEAD_SHA}\nContract-Commit: ${STALE_SHA}\n\n${filler}\nVERDICT: PASS\n` }],
  });
  ok("P4 duplicate Contract-Commit blocked", dupSha.code !== 0 && /ambiguous Contract-Commit/.test(dupSha.out + dupSha.err));

  const prep = await runFlow({
    name: "p4-prep", config: "../test/configs/verdict-gate.config.json",
    args: ["--only", "contract-arch,contract-review"],
    env: { ORCA_VERIFY_HEAD_SHA: HEAD_SHA },
  });
  eq("P4 prep contract-arch + contract-review succeeded", prep.code, 0);
  rmSync(join(prep.dir, "calls.jsonl"), { force: true });

  const valid = await runFlow({
    name: "p4-valid", reuseDir: prep.dir, config: "../test/configs/verdict-gate.config.json", args: ["--from", "worker"],
    env: { ORCA_VERIFY_HEAD_SHA: HEAD_SHA },
  });
  eq("P4 exact 40-char HEAD SHA + VERDICT: PASS allowed", valid.code, 0);
  eq("P4 worker dispatched once", valid.by("orchestration worker-start").length, 1);
});

// ---------------------------------------------------------------------------
// P5 — 3-Track dry-run validation & bad verify / isolatedWorktree config errors
// ---------------------------------------------------------------------------
scenario("P5 3-track dry-run & verify/isolation config validation", async () => {
  for (const cfg of ["flow-hotfix.json", "flow-feature.json", "flow-epic.json"]) {
    const r = await runFlow({ name: `p5-${cfg}`, config: cfg, args: ["--dry-run"], objective: "smoke" });
    eq(`P5 ${cfg} dry-run exit`, r.code, 0);
    ok(`P5 ${cfg} shows target branch dev`, /Target branch: dev/.test(r.out));
  }
  const epic = await runFlow({ name: "p5-epic", config: "flow-epic.json", args: ["--dry-run"], objective: "smoke" });
  ok("P5 flow-epic shows isolated-wt flag", /isolated-wt/.test(epic.out));
  ok("P5 flow-epic shows contract-review verify flag", /verify=verdict:PASS,commit:HEAD/.test(epic.out));

  const badVerify = await runFlow({ name: "p5-badv", config: "../test/configs/bad-verify-key.json", args: ["--dry-run"], objective: "x" });
  ok("P5 bad verify key rejected", badVerify.code !== 0 && /unknown verify rule/.test(badVerify.out + badVerify.err));

  const badIso = await runFlow({ name: "p5-badi", config: "../test/configs/bad-isolated-type.json", args: ["--dry-run"], objective: "x" });
  ok("P5 bad isolatedWorktree type rejected", badIso.code !== 0 && /isolatedWorktree must be a boolean/.test(badIso.out + badIso.err));
});

// ---------------------------------------------------------------------------
// P6 — Installer ships new engine modules & --upgrade-engine preserves custom AGENTS.md
// ---------------------------------------------------------------------------
scenario("P6 installer ships gate-verify & worktree-isolation and --upgrade-engine preserves AGENTS.md", async () => {
  const r = await runInit({ name: "p6" });
  eq("P6 fresh install exit", r.code, 0);
  ok("P6 installed gate-verify.mjs", existsSync(join(r.dir, ".orca", "gate-verify.mjs")));
  ok("P6 installed worktree-isolation.mjs", existsSync(join(r.dir, ".orca", "worktree-isolation.mjs")));
  writeFileSync(join(r.dir, "AGENTS.md"), "# CUSTOM PROJECT AGENTS\n");
  writeFileSync(join(r.dir, ".orca", "flow.mjs"), "// stale engine\n");
  const up = await runInit({ name: "p6-up", dir: r.dir, args: ["--upgrade-engine"] });
  eq("P6 upgrade-engine exit", up.code, 0);
  ok("P6 upgrade-engine refreshed flow.mjs", !readFileSync(join(r.dir, ".orca", "flow.mjs"), "utf8").includes("stale engine"));
  eq("P6 upgrade-engine preserved custom AGENTS.md", readFileSync(join(r.dir, "AGENTS.md"), "utf8"), "# CUSTOM PROJECT AGENTS\n");
});

// ---------------------------------------------------------------------------
// P7 — Post-merge retry loop (B1), protected targetBranch guard (M6),
// heading/quote conflicting verdict rejection, and bold Contract-Commit parsing
// ---------------------------------------------------------------------------
scenario("P7 post-merge retry loop succeeds without Contract-Commit deadlock + protected branch guard", async () => {
  const CONTRACT_SHA = "6666666666666666666666666666666666666666";
  const r = await runFlow({
    name: "p7-retry",
    config: "../test/configs/post-merge-retry.config.json",
    scenario: "post-merge-retry.cjs",
    objective: "#epic 中文模块测试",
    env: { ORCA_VERIFY_HEAD_SHA: CONTRACT_SHA },
    budgetMs: 90000,
  });
  ok("P7 not hung", !r.hung);
  eq("P7 exit code", r.code, 0);
  eq("P7 worker-backend ran twice (reused isolated wt on retry)", r.state?.extra?.beRuns, 2);
  eq("P7 only 1 worktree created (reused on retry)", r.by("worktree create").length, 1);
  eq("P7 serial-integration ran twice and passed", r.state?.extra?.intRuns, 2);
  const mf = JSON.parse(readFileSync(join(r.wt, ".orca", "artifacts", "WORKTREES.json"), "utf8"));
  eq("P7 manifest recorded verifiedContractCommit", mf.verifiedContractCommit, CONTRACT_SHA);
  eq("P7 manifest recorded mergedAfterContract", mf.mergedAfterContract, true);
  ok("P7 Chinese objective got unique hashed worktree name", /^wt-epic-worker-backend-[0-9a-f]{6}$/.test(mf.tasks?.["worker-backend"]?.wtName || ""));

  // Protected targetBranch must be refused at load time
  const badTarget = await runFlow({ name: "p7-prot", config: "../test/configs/bad-protected-target.json", args: ["--dry-run"], objective: "x" });
  ok("P7 protected targetBranch main refused", badTarget.code !== 0 && /protectedBranches/.test(badTarget.out + badTarget.err));

  // Heading-style conflicting VERDICT: FAIL before trailing VERDICT: PASS must be rejected
  const headingConflict = await runFlow({
    name: "p7-head", config: "../test/configs/verdict-gate.config.json", args: ["--from", "worker"],
    env: { ORCA_VERIFY_HEAD_SHA: CONTRACT_SHA }, stdinText: "n\n",
    seedArtifacts: [{
      file: "CONTRACT_REVIEW.md",
      text: `# Review\n**Contract-Commit:** ${CONTRACT_SHA}\n\n## VERDICT: FAIL\n\n` + "Details.\n".repeat(25) + "\nVERDICT: PASS\n",
    }],
  });
  ok("P7 heading conflicting VERDICT: FAIL rejected", headingConflict.code !== 0 && /conflicting verdict/.test(headingConflict.out + headingConflict.err));
});

// ---------------------------------------------------------------------------
// P8 — One-Way Door / Merge Danger Guard (real git repo with main + dev)
// ---------------------------------------------------------------------------
scenario("P8 Merge Danger Guard blocks one-way contradictions & rogue dev merges, holds PENDING_HUMAN_MERGE", async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const initRepoWithDiff = (dir, addFile, content) => {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@orca.local"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Orca Test"], { cwd: dir });
    writeFileSync(join(dir, "README.md"), "base\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    execFileSync("git", ["branch", "dev"], { cwd: dir });
    execFileSync("git", ["checkout", "-b", "epic/test-door", "dev"], { cwd: dir });
    mkdirSync(dirname(join(dir, addFile)), { recursive: true });
    writeFileSync(join(dir, addFile), content);
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "feature change"], { cwd: dir });
  };

  // Helper: run flow against a custom real-git wtDir by pre-seeding via ORCA_FAKE_WT override
  const runInGitRepo = async (tag, addFile, fileContent, extraEnv = {}, extraArgs = []) => {
    const dir = mkdtempSync(join(tmpdir(), `orca-p8-${tag}-`));
    dirsOfCurrentScenario.push(dir);
    const wt = join(dir, "repo");
    const ledger = join(dir, "ledger");
    mkdirSync(wt, { recursive: true });
    initRepoWithDiff(wt, addFile, fileContent);
    const r = await runFlow({
      name: `p8-${tag}`,
      config: "../test/configs/merge-danger.config.json",
      scenario: "merge-danger-report.cjs",
      args: ["--ledger-home", ledger, ...extraArgs],
      env: { ...extraEnv },
      budgetMs: 30000,
    });
    return { r, wt, ledger, dir };
  };

  // Direct test via standalone merge-danger CLI + flow with real git worktree
  const repoDir = mkdtempSync(join(tmpdir(), "orca-p8-git-"));
  dirsOfCurrentScenario.push(repoDir);
  initRepoWithDiff(repoDir, "migrations/001_init.sql", "CREATE TABLE grades(id INT);\nALTER TABLE grades ADD COLUMN tier TEXT;\n");
  const ledgerDir = mkdtempSync(join(tmpdir(), "orca-p8-ledger-"));
  dirsOfCurrentScenario.push(ledgerDir);

  const mdCli = spawnSync(NODE, [join(REPO, ".orca", "merge-danger.mjs"), "--base", "dev", "--dir", repoDir, "--json"], { encoding: "utf8" });
  eq("P8 CLI detects schema_migration exit", mdCli.status, 0);
  const mdJson = JSON.parse(mdCli.stdout);
  eq("P8 CLI classified .sql migration as one-way", mdJson.door, "one-way");
  ok("P8 CLI triggered schema_migration", mdJson.classification.triggers.includes("schema_migration"));

  // Run flow with ORCA_MERGE_DANGER_MOCK=one-way (contradicted two-way claim -> must FAIL)
  const filler = "Release details line.\n".repeat(15);
  const badTwoWay = await runFlow({
    name: "p8-contradict",
    config: "../test/configs/merge-danger.config.json",
    scenario: "merge-danger-report.cjs",
    args: ["--ledger-home", ledgerDir],
    env: {
      ORCA_MERGE_DANGER_MOCK: JSON.stringify({ door: "one-way", triggers: ["schema_migration"] }),
      ORCA_FAKE_RELEASE_BODY: `# Release\nDoor: two-way\nMerge-Status: MERGED\n${filler}VERDICT: PASS\n`,
    },
  });
  ok("P8 contradicted two-way claim hard-blocked", badTwoWay.code !== 0 && /merge-danger contradiction/.test(badTwoWay.out + badTwoWay.err));

  // Unauthorized MERGED on one-way door -> must FAIL
  const badMerged = await runFlow({
    name: "p8-unauth-merge",
    config: "../test/configs/merge-danger.config.json",
    scenario: "merge-danger-report.cjs",
    args: ["--ledger-home", ledgerDir],
    env: {
      ORCA_MERGE_DANGER_MOCK: JSON.stringify({ door: "one-way", triggers: ["auth_secrets"] }),
      ORCA_FAKE_RELEASE_BODY: `# Release\nDoor: one-way\nMerge-Status: MERGED\n${filler}VERDICT: PASS\n`,
    },
  });
  ok("P8 unauthorized Merge-Status: MERGED hard-blocked", badMerged.code !== 0 && /one-way door violation/.test(badMerged.out + badMerged.err));

  // Lawful one-way door hold -> exits 0 with pending-human-merge recorded in out-of-repo ledger
  const held = await runFlow({
    name: "p8-hold",
    config: "../test/configs/merge-danger.config.json",
    scenario: "merge-danger-report.cjs",
    args: ["--ledger-home", ledgerDir],
    env: {
      ORCA_MERGE_DANGER_MOCK: JSON.stringify({ door: "one-way", triggers: ["schema_migration", "deploy_infra"] }),
      ORCA_FAKE_RELEASE_BODY: `# Release\nDoor: one-way\nMerge-Status: PENDING_HUMAN_MERGE\n${filler}VERDICT: PASS\n`,
    },
  });
  eq("P8 lawful one-way door hold exits cleanly", held.code, 0);
  eq("P8 status overall is pending-human-merge", held.status?.overall, "pending-human-merge");
  ok("P8 printed PENDING HUMAN MERGE banner", /PENDING HUMAN MERGE/.test(held.out));
  const pendCli = spawnSync(NODE, [join(REPO, ".orca", "ledger.mjs"), "pending", "--ledger-home", ledgerDir, "--json"], { encoding: "utf8" });
  const pendData = JSON.parse(pendCli.stdout);
  ok("P8 ledger pending CLI lists unresolved human_merge", pendData.pending.length >= 1 && pendData.pending[0].pending.triggers.includes("schema_migration"));

  // Explicit --allow-one-way-merge authorization allows one-way merge
  const allowed = await runFlow({
    name: "p8-allow",
    config: "../test/configs/merge-danger.config.json",
    scenario: "merge-danger-report.cjs",
    args: ["--ledger-home", ledgerDir, "--allow-one-way-merge"],
    env: {
      ORCA_MERGE_DANGER_MOCK: JSON.stringify({ door: "one-way", triggers: ["schema_migration"] }),
      ORCA_FAKE_RELEASE_BODY: `# Release\nDoor: one-way\nMerge-Status: MERGED\n${filler}VERDICT: PASS\n`,
    },
  });
  eq("P8 --allow-one-way-merge permits merge", allowed.code, 0);
  eq("P8 authorized merge overall succeeded", allowed.status?.overall, "succeeded");

  // Clean two-way diff in real git repo
  const cleanDir = mkdtempSync(join(tmpdir(), "orca-p8-clean-"));
  dirsOfCurrentScenario.push(cleanDir);
  initRepoWithDiff(cleanDir, "src/helper.js", "export const x = 42;\n");
  const cleanCli = spawnSync(NODE, [join(REPO, ".orca", "merge-danger.mjs"), "--base", "dev", "--dir", cleanDir, "--json"], { encoding: "utf8" });
  eq("P8 clean diff classified as two-way", JSON.parse(cleanCli.stdout).door, "two-way");

  // B1/B2: Rogue worker runs `git branch -f dev HEAD` on a one-way diff -> pinned preStepTargetSha STILL catches it!
  const { pathToFileURL } = await import("node:url");
  const { snapshotTargetRefs, verifyMergeDangerGate, classifyMergeDanger } = await import(pathToFileURL(join(REPO, ".orca", "merge-danger.mjs")).href);
  const preRefs = snapshotTargetRefs(repoDir, "dev");
  const epicSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  execFileSync("git", ["branch", "-f", "dev", epicSha], { cwd: repoDir }); // rogue merge/move of dev!
  const b1Check = verifyMergeDangerGate({
    text: `# Release\nDoor: one-way\nMerge-Status: PENDING_HUMAN_MERGE\n${filler}VERDICT: PASS\n`,
    gitDir: repoDir,
    targetBranch: "dev",
    allowOneWayMerge: false,
    preStepTargetSha: preRefs.localSha,
    preStepOriginTargetSha: preRefs.originSha,
  });
  eq("P8 B1/B2 rogue git branch -f dev HEAD hard-blocked", b1Check.ok, false);
  ok("P8 B1/B2 reported target ref moved violation", /moved from/.test(b1Check.reason || ""));

  // R2-B1: Rogue worker moves dev -> epicSha AND resets HEAD back to preRefs.localSha (making pinned...HEAD empty!)
  execFileSync("git", ["reset", "--hard", preRefs.localSha], { cwd: repoDir });
  const r2b1Check = verifyMergeDangerGate({
    text: `# Release\nDoor: two-way\nMerge-Status: MERGED\n${filler}VERDICT: PASS\n`,
    gitDir: repoDir,
    targetBranch: "dev",
    allowOneWayMerge: false,
    preStepTargetSha: preRefs.localSha,
    preStepOriginTargetSha: preRefs.originSha,
    preStepHeadSha: preRefs.headSha,
  });
  eq("P8 R2-B1 rogue merge+reset-HEAD hide trick STILL blocked", r2b1Check.ok, false);
  ok("P8 R2-B1 classified hidden one-way content as one-way", r2b1Check.door === "one-way");
  // F1: Lying "Door: two-way" must NEVER mask targetRefMoved violation!
  ok("P8 F1 structured targetRefMoved exposed despite lying Door: two-way", Boolean(r2b1Check.targetRefMoved) && Array.isArray(r2b1Check.movedRefs) && r2b1Check.movedRefs.length >= 1);
  ok("P8 F1 reason reports targetRefMoved violation (not contradiction)", /one-way door violation.*moved from/.test(r2b1Check.reason || ""));

  // M9: Renaming auth/login.ts -> lib/helper.ts MUST still trigger auth_secrets
  const renDir = mkdtempSync(join(tmpdir(), "orca-p8-ren-"));
  dirsOfCurrentScenario.push(renDir);
  execFileSync("git", ["init", "-b", "main"], { cwd: renDir });
  execFileSync("git", ["config", "user.email", "test@orca.local"], { cwd: renDir });
  execFileSync("git", ["config", "user.name", "Orca Test"], { cwd: renDir });
  mkdirSync(join(renDir, "auth"), { recursive: true });
  writeFileSync(join(renDir, "auth", "login.ts"), "export function login() { return true; }\n");
  execFileSync("git", ["add", "."], { cwd: renDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: renDir });
  execFileSync("git", ["branch", "dev"], { cwd: renDir });
  execFileSync("git", ["checkout", "-b", "epic/ren", "dev"], { cwd: renDir });
  mkdirSync(join(renDir, "lib"), { recursive: true });
  execFileSync("git", ["mv", "auth/login.ts", "lib/helper.ts"], { cwd: renDir });
  execFileSync("git", ["commit", "-m", "rename out of auth"], { cwd: renDir });
  const renCls = classifyMergeDanger(renDir, "dev");
  eq("P8 M9 rename out of auth/ still triggers one-way", renCls.door, "one-way");
  ok("P8 M9 rename triggered auth_secrets", renCls.triggers.includes("auth_secrets"));
});

// ---------------------------------------------------------------------------
// P9 — turnStart: observed Start Proof & 5-State Health State Machine
// ---------------------------------------------------------------------------
scenario("P9 turnStart unobserved triggers unknown warning & early stop + health:lost stops without blind retry", async () => {
  const t0 = Date.now();
  const r = await runFlow({
    name: "p9-unobserved",
    config: "../test/configs/turn-start-unobserved.config.json",
    scenario: "turn-start-unobserved.cjs",
    budgetMs: 15000,
  });
  const dt = Date.now() - t0;
  ok("P9 not hung", !r.hung);
  eq("P9 exit code (stopped cleanly)", r.code, 1);
  ok("P9 stopped far earlier than 30s hardTimeoutMs", dt < 8000);
  ok("P9 logged turnStart unobserved warning", /turnStart=unobserved/.test(r.out + r.err));
  eq("P9 status step health is unknown", r.status?.steps[0]?.health, "unknown");
  eq("P9 status step turnStart is unobserved", r.status?.steps[0]?.turnStart, "unobserved");
  eq("P9 overall is still-running (resume hint)", r.status?.overall, "still-running");

  // Dispatch lost without worker_done -> health:lost -> stops as unknown without retry
  const lost = await runFlow({
    name: "p9-lost",
    config: "../test/configs/turn-start-unobserved.config.json",
    scenario: "dispatch-lost.cjs",
    budgetMs: 15000,
  });
  ok("P9 lost not hung", !lost.hung);
  eq("P9 lost exit code", lost.code, 1);
  ok("P9 lost logged health:lost", /\[health:lost\]/.test(lost.out + lost.err));
  eq("P9 lost never blind-retried (1 worker-start)", lost.by("orchestration worker-start").length, 1);
  eq("P9 lost step health is lost", lost.status?.steps[0]?.health, "lost");
});

// ---------------------------------------------------------------------------
// P10 — Out-of-Repo Ledger, In-Repo Path Refusal, 4-Level Acceptance & Closeout Reconcile
// ---------------------------------------------------------------------------
scenario("P10 out-of-repo ledger refuses in-repo paths, tracks 4-level acceptance & reconciles closeout after human merge", async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const { createRunLedger, assertOutOfRepoPath } = await import(pathToFileURL(join(REPO, ".orca", "ledger.mjs")).href);

  const root = mkdtempSync(join(tmpdir(), "orca-p10-"));
  dirsOfCurrentScenario.push(root);
  const repoDir = join(root, "repo");
  const outLedger = join(root, "pod-ledger");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@orca.local"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Orca Test"], { cwd: repoDir });
  writeFileSync(join(repoDir, "app.txt"), "v1\n");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  execFileSync("git", ["branch", "dev"], { cwd: repoDir });
  execFileSync("git", ["checkout", "-b", "epic/demo", "dev"], { cwd: repoDir });
  mkdirSync(join(repoDir, "migrations"), { recursive: true });
  writeFileSync(join(repoDir, "migrations", "001.sql"), "CREATE TABLE t(id INT);\n");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "add migration"], { cwd: repoDir });
  const epicHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

  // Refuses ledger inside git repo
  let threwInRepo = false;
  try { assertOutOfRepoPath(join(repoDir, ".orca", "ledger"), repoDir); } catch { threwInRepo = true; }
  ok("P10 refuses ledgerHome inside git repo", threwInRepo);

  // Create out-of-repo ledger, record implemented + pending_human_merge
  const ledger = createRunLedger({
    runKey: "p10-run",
    repoDir,
    ledgerHome: outLedger,
    objective: "demo migration",
    targetBranch: "dev",
    protectedBranches: ["main"],
  });
  let threwNoEv = false;
  try { ledger.recordAcceptanceLevel("implemented", { status: true, evidenceRef: "" }); } catch { threwNoEv = true; }
  ok("P10 acceptance level refuses status=true without evidenceRef", threwNoEv);

  ledger.recordAcceptanceLevel("implemented", { status: true, evidenceRef: `commit:${epicHead}` });
  ledger.recordPendingHumanMerge({ targetBranch: "dev", door: "one-way", triggers: ["schema_migration"], headSha: epicHead });
  const c1 = ledger.reconcileCloseout({ wtDir: repoDir, overall: "pending-human-merge" });
  eq("P10 initial closeout overall pending-human-merge", c1.overall, "pending-human-merge");
  eq("P10 initial implemented=true", c1.acceptance.implemented.status, true);
  eq("P10 initial merged=false before human merge", c1.acceptance.merged.status, false);
  eq("P10 initial synced=false before human merge", c1.acceptance.synced.status, false);
  eq("P10 protected branch main untouched", c1.protectedViolations.length, 0);

  // M7: Checking out dev BEFORE merging epic/demo MUST NOT falsely mark merged=true!
  execFileSync("git", ["checkout", "dev"], { cwd: repoDir });
  const preMergeCli = spawnSync(NODE, [
    join(REPO, ".orca", "ledger.mjs"), "closeout",
    "--run", "p10-run", "--repo", repoDir, "--target-branch", "dev", "--ledger-home", outLedger, "--json",
  ], { encoding: "utf8" });
  const preMergeJson = JSON.parse(preMergeCli.stdout);
  eq("P10 M7 checkout on dev before merge stays merged=false", preMergeJson.acceptance.merged.status, false);
  eq("P10 M7 checkout on dev before merge stays pendingResolved=false", preMergeJson.pendingResolved, false);

  // M3: Symlinked ledgerHome/runs pointing inside repo MUST be refused
  const { symlinkSync } = await import("node:fs");
  const symLedger = join(root, "sym-ledger");
  mkdirSync(symLedger, { recursive: true });
  symlinkSync(join(repoDir, ".git"), join(symLedger, "runs"));
  let threwSym = false;
  try { assertOutOfRepoPath(symLedger, repoDir); } catch { threwSym = true; }
  ok("P10 M3 symlinked runs/ pointing into repo refused", threwSym);

  // Now simulate human merging epic/demo into dev (main untouched!)
  execFileSync("git", ["checkout", "dev"], { cwd: repoDir });
  execFileSync("git", ["merge", "--no-ff", "epic/demo", "-m", "human merge"], { cwd: repoDir });
  execFileSync("git", ["checkout", "epic/demo"], { cwd: repoDir });

  // Run standalone ledger.mjs closeout CLI
  const cCli = spawnSync(NODE, [
    join(REPO, ".orca", "ledger.mjs"), "closeout",
    "--run", "p10-run", "--repo", repoDir, "--target-branch", "dev", "--ledger-home", outLedger, "--json",
  ], { encoding: "utf8" });
  eq("P10 closeout CLI exits 0 after human merge", cCli.status, 0);
  const c2 = JSON.parse(cCli.stdout);
  eq("P10 closeout resolved pending human merge", c2.pendingResolved, true);
  eq("P10 closeout merged=true", c2.acceptance.merged.status, true);
  eq("P10 closeout synced=true", c2.acceptance.synced.status, true);
  eq("P10 closeout main untouched", c2.protectedViolations.length, 0);

  // Now simulate rogue mutation of main -> closeout MUST detect violation and exit 1!
  execFileSync("git", ["branch", "-f", "main", "dev"], { cwd: repoDir });
  const badMain = spawnSync(NODE, [
    join(REPO, ".orca", "ledger.mjs"), "closeout",
    "--run", "p10-run", "--repo", repoDir, "--target-branch", "dev", "--ledger-home", outLedger, "--json",
  ], { encoding: "utf8" });
  eq("P10 closeout CLI fails (exit 1) if protected branch main mutated", badMain.status, 1);
  ok("P10 closeout reports main violation", JSON.parse(badMain.stdout).protectedViolations.some((v) => v.branch === "main"));
});

// ---------------------------------------------------------------------------
// P11 — Bot Anti-Collision Dedup Lock & Installer v0.3.0 Engine Upgrade
// ---------------------------------------------------------------------------
scenario("P11 Bot anti-collision --dedup-key lock blocks live dup, reclaims stale lock, and installer ships v0.3.0 modules", async () => {
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const { acquireRunLock, checkRunLock } = await import(pathToFileURL(join(REPO, ".orca", "ledger.mjs")).href);

  const root = mkdtempSync(join(tmpdir(), "orca-p11-"));
  dirsOfCurrentScenario.push(root);
  const ledgerDir = join(root, "ledger");

  // Hold a live lock with current process.pid
  const lock1 = acquireRunLock({ dedupKey: "gh:shown1985/sxcj#101", runKey: "holder-run", repoDir: REPO, ledgerHome: ledgerDir });
  eq("P11 first lock acquired", lock1.acquired, true);

  // CLI check-lock reports ACTIVE (exit 2)
  const chk = spawnSync(NODE, [
    join(REPO, ".orca", "ledger.mjs"), "check-lock", "--dedup-key", "gh:shown1985/sxcj#101", "--ledger-home", ledgerDir, "--json",
  ], { encoding: "utf8" });
  eq("P11 check-lock exits 2 on live lock", chk.status, 2);
  eq("P11 check-lock locked=true", JSON.parse(chk.stdout).locked, true);

  // Second flow invocation with same --dedup-key MUST exit 2 without dispatching any worker
  const dup = await runFlow({
    name: "p11-dup",
    config: "../test/configs/cold.config.json",
    args: ["--dedup-key", "gh:shown1985/sxcj#101", "--ledger-home", ledgerDir],
  });
  eq("P11 duplicate runner blocked with exit 2", dup.code, 2);
  ok("P11 duplicate runner printed DUPLICATE RUN BLOCKED", /DUPLICATE RUN BLOCKED/.test(dup.err));
  eq("P11 duplicate runner dispatched zero workers", dup.by("orchestration worker-start").length, 0);

  // Overwrite lock with a definitely-dead PID -> next flow run auto-reclaims stale lock and succeeds!
  writeFileSync(lock1.file, JSON.stringify({ dedupKey: "gh:shown1985/sxcj#101", runKey: "dead-run", pid: 99999999, startedAt: new Date().toISOString() }));
  const staleChk = checkRunLock({ dedupKey: "gh:shown1985/sxcj#101", repoDir: REPO, ledgerHome: ledgerDir });
  eq("P11 dead PID detected as stale", staleChk.stale, true);

  const reclaimed = await runFlow({
    name: "p11-reclaim",
    config: "../test/configs/cold.config.json",
    args: ["--dedup-key", "gh:shown1985/sxcj#101", "--ledger-home", ledgerDir],
  });
  eq("P11 reclaimed stale lock and succeeded", reclaimed.code, 0);
  ok("P11 logged stale lock reclamation", /reclaimed stale lock/.test(reclaimed.out + reclaimed.err));

  // Verify bin/init.mjs installs & upgrades all 3 new v0.3.0 modules
  const inst = await runInit({ name: "p11-init" });
  eq("P11 init exit 0", inst.code, 0);
  ok("P11 installed merge-danger.mjs", existsSync(join(inst.dir, ".orca", "merge-danger.mjs")));
  ok("P11 installed health.mjs", existsSync(join(inst.dir, ".orca", "health.mjs")));
  ok("P11 installed ledger.mjs", existsSync(join(inst.dir, ".orca", "ledger.mjs")));
});

// ---------------------------------------------------------------------------
// V1 — Activity-Aware Watchdog: healthy active worker survives past fixed
// timeout; output dead-loop fails fast; gateway ECONNREFUSED triggers fallback.
// ---------------------------------------------------------------------------
scenario("V1 Watchdog (active extension, dead-loop, trust-prompt, gateway fallback)", async () => {
  const {
    detectGatewayDisconnect,
    detectPromptBlocked,
    detectOutputLoop,
    createWatchdogTracker,
    evaluateWatchdog,
  } = await import(join(REPO, ".orca", "watchdog.mjs"));

  // Unit assertions
  ok("V1 detectGatewayDisconnect catches ECONNREFUSED", Boolean(detectGatewayDisconnect("Error: connect ECONNREFUSED 127.0.0.1:3425")));
  ok("V1 detectGatewayDisconnect ignores normal output", detectGatewayDisconnect("All 42 pytest cases passed") === null);
  const pb = detectPromptBlocked("Do you trust the contents of this project?\n[y/N]");
  ok("V1 detectPromptBlocked catches agy workspace trust dialog", Boolean(pb && pb.matched && /agent_prompt_blocked/.test(pb.label)));
  const loopIntra = detectOutputLoop([], [
    "Retrying invalid tool call payload against gateway...",
    "Retrying invalid tool call payload against gateway...",
    "Retrying invalid tool call payload against gateway...",
    "Retrying invalid tool call payload against gateway...",
    "Retrying invalid tool call payload against gateway...",
  ], { threshold: 4 });
  ok("V1 detectOutputLoop catches intra-preview repeat", Boolean(loopIntra && loopIntra.pattern === "intra_preview_repeat"));
  const loopOsc = detectOutputLoop([
    "Step A failed with syntax error in handler.py",
    "Step B reverting handler.py and retrying build",
    "Step A failed with syntax error in handler.py",
    "Step B reverting handler.py and retrying build",
  ], [], { threshold: 4 });
  ok("V1 detectOutputLoop catches period-2 oscillation", Boolean(loopOsc && loopOsc.pattern === "period2_cycle"));

  // Stall detection unit test
  const t0 = 1000000;
  const wTracker = createWatchdogTracker({
    step: { watchdog: { stallTimeoutMs: 5000, extendOnActivity: true } },
    startedAt: t0,
    probeFn: () => ({ gitFingerprint: "same", artifactFingerprint: "same", artifactSize: 0 }),
  });
  const stallRes = evaluateWatchdog(wTracker, { now: t0 + 6000, preview: "idle", previewChanged: false, previewSeenBefore: true, fallbackAvailable: false });
  eq("V1 stall detected when silent past stallTimeoutMs", stallRes.kind, "stalled_hang");
  eq("V1 stall action without fallback is escalate", stallRes.action, "escalate");

  // E2E V1a: actively progressing worker survives past short hardTimeoutMs (2500ms)
  const tmpV1 = mkdtempSync(join(tmpdir(), "orca-v1-"));
  dirsOfCurrentScenario.push(tmpV1);
  const activeCfgPath = join(REPO, ".orca", "_tmp-v1a.config.json");
  const loopCfgPath = join(REPO, ".orca", "_tmp-v1b.config.json");
  const gwCfgPath = join(REPO, ".orca", "_tmp-v1c.config.json");
  try {
    writeFileSync(activeCfgPath, JSON.stringify({
      defaults: {
        timeoutMs: 1200,
        hardTimeoutMs: 2200,
        watchdog: { enabled: true, extendOnActivity: true, extendStepMs: 5000, activityFreshMs: 10000, stallTimeoutMs: 0, maxRuntimeMs: 0 },
      },
      pipeline: [{ id: "alpha", title: "Alpha", agent: "stub", spec: "Long work writing {out}.", writes: "A.md" }],
    }));
    const rActive = await runFlow({
      name: "v1a-active",
      config: "_tmp-v1a.config.json",
      scenario: "v5-watchdog-active.cjs",
      args: ["--ledger-home", join(tmpV1, "ledger-a")],
      budgetMs: 45000,
    });
    eq("V1a active worker succeeded despite crossing initial hardTimeoutMs", rActive.code, 0);
    ok("V1a watchdog logged deadline extension", /[watchdog].*extending deadline/.test(rActive.out + rActive.err));
    eq("V1a status overall succeeded", rActive.status?.overall, "succeeded");

    // E2E V1b: output dead-loop without fallback -> fails fast with diagnosis + ledger event
    writeFileSync(loopCfgPath, JSON.stringify({
      defaults: {
        timeoutMs: 10000,
        hardTimeoutMs: 30000,
        watchdog: { enabled: true, loopThreshold: 4 },
      },
      pipeline: [{ id: "alpha", title: "Alpha", agent: "stub", spec: "Looping work writing {out}.", writes: "A.md" }],
    }));
    const ledgerB = join(tmpV1, "ledger-b");
    const rLoop = await runFlow({
      name: "v1b-loop",
      config: "_tmp-v1b.config.json",
      scenario: "v5-watchdog-loop.cjs",
      args: ["--ledger-home", ledgerB],
      budgetMs: 30000,
    });
    eq("V1b dead-loop exited non-zero", rLoop.code, 1);
    ok("V1b logged watchdog output_loop", /[watchdog:output_loop]/.test(rLoop.out + rLoop.err));

    // E2E V1c: mid-run gateway ECONNREFUSED triggers seamless fallback from opencode2 -> agy
    writeFileSync(gwCfgPath, JSON.stringify({
      defaults: {
        timeoutMs: 5000,
        hardTimeoutMs: 25000,
        preflight: { enabled: false },
        watchdog: { enabled: true, fallbackOnGatewayError: true },
      },
      pipeline: [{
        id: "backend",
        title: "Backend Worker",
        agent: "opencode2",
        model: "magpie/remote-magpie/opencode-go/deepseek-v4.1-flash",
        fallback: { agent: "agy", model: "claude-sonnet-5-5", effort: "medium" },
        spec: "Implement API writing {out}.",
        writes: "BACKEND.md",
      }],
    }));
    const ledgerC = join(tmpV1, "ledger-c");
    const rGw = await runFlow({
      name: "v1c-gw-fallback",
      config: "_tmp-v1c.config.json",
      scenario: "v5-watchdog-gw-fallback.cjs",
      args: ["--ledger-home", ledgerC],
      budgetMs: 45000,
    });
    eq("V1c gateway fallback succeeded", rGw.code, 0);
    ok("V1c logged watchdog gateway_disconnect", /\[watchdog:gateway_disconnect\]/.test(rGw.out + rGw.err));
    ok("V1c logged fallback to agy", /\[fallback\].*downgrading from "opencode2" to "agy"/.test(rGw.out + rGw.err));
    const starts = rGw.state?.extra?.starts || [];
    eq("V1c dispatched primary then normalized antigravity fallback", starts.map((s) => s.agent), ["opencode2", "antigravity"]);
    eq("V1c fallback received model claude-sonnet-5-5", starts[1]?.model, "claude-sonnet-5-5");
    eq("V1c fallback received effort medium", starts[1]?.effort, "medium");
    eq("V1c fallback used --retry-of pointing to stopped primary dispatch", starts[1]?.retryOf, starts[0]?.id);
    eq("V1c called worker-stop on broken primary dispatch before fallback", rGw.state?.extra?.stoppedDispatches, [starts[0]?.id]);
    ok("V1c ignored stale worker_done from superseded primary dispatch", /\[stale-dispatch\] ignoring late worker_done/.test(rGw.out + rGw.err));
    ok("V1c redacted Bearer token from logs", !(rGw.out + rGw.err).includes("sk-secret1234567890abcdef"));
    const { listLedgerSummaries } = await import(join(REPO, ".orca", "ledger.mjs"));
    const sumsC = listLedgerSummaries({ ledgerHome: ledgerC });
    ok("V1c ledger recorded fallback event", (sumsC[0]?.fallbacks?.length || 0) >= 1);
    eq("V1c ledger fallback toAgent=agy", sumsC[0]?.fallbacks?.[0]?.toAgent, "agy");
    ok("V1c ledger recorded watchdog gateway_disconnect", sumsC[0]?.watchdogEvents?.some((e) => e.kind === "gateway_disconnect"));
    ok("V1c ledger redacted Bearer token", !JSON.stringify(sumsC[0]).includes("sk-secret1234567890abcdef"));
  } finally {
    for (const f of [activeCfgPath, loopCfgPath, gwCfgPath]) { try { rmSync(f, { force: true }); } catch {} }
  }
});

// ---------------------------------------------------------------------------
// V2 — Pre-flight Primary/Fallback Health Check + agy Isolated Worktree Trust
// ---------------------------------------------------------------------------
scenario("V2 Preflight auto-downgrade (ECONNREFUSED) + agy --settings trustedWorkspaces", async () => {
  const { buildAgentCommand, buildAgySettingsArg, isAgyCmd } = await import(join(REPO, ".orca", "lib", "orca-cli.mjs"));
  const { discoverOpencodeLocalEndpoints, buildCandidateChain, selectHealthyCandidate } = await import(join(REPO, ".orca", "preflight.mjs"));
  const net = await import("node:net");

  // Unit assertions for agy command builder (session-scoped --settings, never mutates global file)
  ok("V2 isAgyCmd detects agy", isAgyCmd("agy"));
  ok("V2 isAgyCmd detects antigravity", isAgyCmd("antigravity --model gemini"));
  const agyCmd = buildAgentCommand("agy", "claude-sonnet-5-5", {
    autoRun: true,
    effort: "medium",
    worktreePath: "/tmp/sxcj-wt-backend",
    isWin: false,
  });
  ok("V2 agy command includes --model", agyCmd.includes("--model claude-sonnet-5-5"));
  ok("V2 agy command includes --effort", agyCmd.includes("--effort medium"));
  ok("V2 agy command includes --dangerously-skip-permissions", agyCmd.includes("--dangerously-skip-permissions"));
  ok("V2 agy command injects session-scoped trustedWorkspaces", agyCmd.includes(`--settings '{"trustedWorkspaces":["/tmp/sxcj-wt-backend"]}'`));
  ok("V2 buildAgySettingsArg handles single dir", buildAgySettingsArg("/a/b", { isWin: false }).includes('{"trustedWorkspaces":["/a/b"]}'));

  // Unit assertion for opencode.json localhost Magpie discovery
  const tmpV2 = mkdtempSync(join(tmpdir(), "orca-v2-"));
  dirsOfCurrentScenario.push(tmpV2);
  writeFileSync(join(tmpV2, "opencode.json"), JSON.stringify({
    provider: {
      magpie: { options: { baseURL: "http://127.0.0.1:3425/v1" } },
      cloud: { options: { baseURL: "https://api.example.com/v1" } },
    },
  }));
  const eps = discoverOpencodeLocalEndpoints({ projectDir: tmpV2, model: "magpie/remote-magpie/opencode-go/deepseek-v4.1-flash" });
  eq("V2 discovered local magpie endpoint", eps.length, 1);
  eq("V2 magpie port is 3425", eps[0]?.port, 3425);

  // Allocate a guaranteed-closed ephemeral port for ECONNREFUSED preflight test
  const closedPort = await new Promise((resolvePort) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });

  const chain = buildCandidateChain(
    { id: "w1", agent: "opencode2", model: "magpie/ds", preflight: { tcp: `127.0.0.1:${closedPort}`, timeoutMs: 500 }, fallback: { agent: "agy", model: "claude-sonnet-5-5", effort: "medium" } },
    { defaults: { preflight: { enabled: true, timeoutMs: 500 } } }
  );
  const sel = await selectHealthyCandidate(chain, { projectDir: tmpV2 });
  eq("V2 preflight downgraded to fallback", sel.downgraded, true);
  eq("V2 selected fallback agent agy", sel.candidate?.agent, "agy");
  ok("V2 failure reason recorded ECONNREFUSED", /ECONNREFUSED/i.test(sel.failures[0]?.reason || ""));

  // E2E: runFlow with terminal-ok.cjs -> primary opencode2 fails TCP preflight -> agy launches via manualStart with --settings trustedWorkspaces!
  const pfCfgPath = join(REPO, ".orca", "_tmp-v2-pf.config.json");
  const ledgerV2 = join(tmpV2, "ledger");
  try {
    writeFileSync(pfCfgPath, JSON.stringify({
      defaults: {
        timeoutMs: 15000,
        hardTimeoutMs: 30000,
        warmupTimeoutMs: 25000,
        startGraceMs: 4000,
        preflight: { enabled: true, timeoutMs: 500 },
        agentFallbacks: {
          opencode2: [{ agent: "agy", model: "claude-sonnet-5-5", effort: "medium" }],
        },
      },
      pipeline: [{
        id: "backend",
        title: "Backend Worker",
        agent: "opencode2",
        model: "magpie/remote-magpie/opencode-go/deepseek-v4.1-flash",
        preflight: { tcp: `127.0.0.1:${closedPort}`, timeoutMs: 500 },
        spec: "Build backend writing {out}.",
        writes: "BACKEND.md",
      }],
    }));
    const r = await runFlow({
      name: "v2-preflight-agy",
      config: "_tmp-v2-pf.config.json",
      scenario: "terminal-ok.cjs",
      args: ["--ledger-home", ledgerV2],
      budgetMs: 60000,
    });
    eq("V2 E2E preflight downgrade succeeded", r.code, 0);
    ok("V2 E2E logged preflight downgrade", /[preflight].*auto-downgrading to fallback "agy"/.test(r.out + r.err));
    const tcCalls = r.by("terminal create");
    eq("V2 E2E created 1 terminal (skipped dead primary)", tcCalls.length, 1);
    const launchedCmd = tcCalls[0]?.flags?.command || "";
    ok("V2 E2E terminal command uses agy", launchedCmd.startsWith("agy "));
    ok("V2 E2E terminal command has model & effort", launchedCmd.includes("--model claude-sonnet-5-5") && launchedCmd.includes("--effort medium"));
    ok("V2 E2E terminal command injects trustedWorkspaces for worktree", launchedCmd.includes(`--settings '{"trustedWorkspaces":[`) && launchedCmd.includes(r.wt));
    const { listLedgerSummaries } = await import(join(REPO, ".orca", "ledger.mjs"));
    const sums = listLedgerSummaries({ ledgerHome: ledgerV2 });
    eq("V2 E2E ledger recorded preflight fallback", sums[0]?.fallbacks?.[0]?.phase, "preflight");
    eq("V2 E2E ledger fallback toAgent=agy", sums[0]?.fallbacks?.[0]?.toAgent, "agy");
  } finally {
    try { rmSync(pfCfgPath, { force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// V3 — GitHub / Gitea Issue + PR Full Traceability Loop
// ---------------------------------------------------------------------------
scenario("V3 Issue Tracker (BACKLOG_DAG -> Epic/Task Issues -> Ledger -> PR Closes/Refs)", async () => {
  const { parseBacklogTasks, parseRemoteHost, formatIssuePrBlock } = await import(join(REPO, ".orca", "issue-tracker.mjs"));

  // Unit assertions
  const parsed = parseBacklogTasks([
    "# Backlog",
    "### T1: Migrate SQLite schema to MySQL",
    "- [ ] T2: Add pytest suite and GitHub Actions CI",
    "| T3 | Build Vue dashboard filter | frontend |",
    "| id | title | owner |",
    "| --- | --- | --- |",
  ].join("\n"));
  eq("V3 parsed 3 backlog tasks", parsed.length, 3);
  eq("V3 task 1 id", parsed[0].id, "T1");
  eq("V3 task 2 id", parsed[1].id, "T2");
  eq("V3 task 3 owner", parsed[2].owner, "frontend");
  eq("V3 parseRemoteHost rejects local path", parseRemoteHost("/tmp/origin.git").isRemote, false);
  eq("V3 parseRemoteHost parses GitHub SSH", parseRemoteHost("git@github.com:shown1985/sxcj.git").repoSlug, "shown1985/sxcj");

  const fmt = formatIssuePrBlock({ epic: { number: 10 }, tasks: [{ number: 11 }, { number: 12 }] });
  eq("V3 issueCloses includes Closes tasks + Refs epic", fmt.issueCloses, "Closes #11, Closes #12\nRefs #10");

  // E2E with fake gh CLI executable
  const tmpV3 = mkdtempSync(join(tmpdir(), "orca-v3-"));
  dirsOfCurrentScenario.push(tmpV3);
  const ghStateFile = join(tmpV3, "gh-state.json");
  const fakeGhPath = join(tmpV3, "fake-gh.mjs");
  writeFileSync(fakeGhPath, `#!/usr/bin/env node
import fs from "node:fs";
const sf = ${JSON.stringify(ghStateFile)};
const st = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : { next: 101, created: [], comments: [] };
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("gh version 2.60.0 (fake)"); process.exit(0); }
if (a[0] === "auth" && a[1] === "status") { console.log("Logged in to github.com as tester"); process.exit(0); }
if (a[0] === "issue" && a[1] === "create") {
  const num = st.next++;
  const ti = a.indexOf("--title"), bi = a.indexOf("--body");
  st.created.push({ number: num, title: ti >= 0 ? a[ti + 1] : "", body: bi >= 0 ? a[bi + 1] : "" });
  fs.writeFileSync(sf, JSON.stringify(st, null, 2));
  console.log("https://github.com/example/sxcj/issues/" + num);
  process.exit(0);
}
if (a[0] === "issue" && a[1] === "comment") {
  const bi = a.indexOf("--body");
  st.comments.push({ number: Number(a[2]), body: bi >= 0 ? a[bi + 1] : "" });
  fs.writeFileSync(sf, JSON.stringify(st, null, 2));
  console.log("comment ok");
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });

  const issCfgPath = join(REPO, ".orca", "_tmp-v3-issues.config.json");
  const ledgerV3 = join(tmpV3, "ledger");
  try {
    writeFileSync(issCfgPath, JSON.stringify({
      defaults: {
        timeoutMs: 10000,
        issueTracking: { mode: true, provider: "gh", closeOnPr: true },
      },
      pipeline: [
        { id: "po-backlog", title: "PO Backlog", agent: "stub", spec: "Plan tasks into {out}.", writes: "BACKLOG_DAG.md" },
        { id: "pr-release-dev", title: "Release PR", agent: "stub", reads: ["po-backlog"], spec: "Open PR and include: {issueCloses}. Write {out}.", writes: "EPIC_RELEASE_GATE.md" },
      ],
    }));
    const r = await runFlow({
      name: "v3-issues",
      config: "_tmp-v3-issues.config.json",
      scenario: "v5-issues.cjs",
      objective: "Migrate sxcj to MySQL and CI/CD",
      args: ["--ledger-home", ledgerV3],
      env: { ORCA_ISSUE_CLI: fakeGhPath, ORCA_ISSUE_ALLOW_LOCAL: "1" },
      budgetMs: 45000,
    });
    eq("V3 E2E issue traceability run succeeded", r.code, 0);
    const ghState = JSON.parse(readFileSync(ghStateFile, "utf8"));
    eq("V3 created 1 Epic + 2 Task issues", ghState.created.length, 3);
    eq("V3 Epic issue is #101", ghState.created[0].number, 101);
    ok("V3 Task #102 references Epic #101", ghState.created[1].body.includes("Part of Epic #101"));
    eq("V3 posted checklist comment on Epic #101", ghState.comments.length, 1);
    ok("V3 checklist comment links #102 and #103", ghState.comments[0].body.includes("#102") && ghState.comments[0].body.includes("#103"));

    const issuesJson = JSON.parse(readFileSync(join(r.wt, ".orca", "artifacts", "ISSUES.json"), "utf8"));
    eq("V3 ISSUES.json records epic #101", issuesJson.epic?.number, 101);
    eq("V3 ISSUES.json records 2 tasks", issuesJson.tasks?.length, 2);
    ok("V3 ISSUES.md generated", existsSync(join(r.wt, ".orca", "artifacts", "ISSUES.md")));

    const prTask = Object.values(r.state?.tasks || {}).find((t) => (t.spec || "").includes("# Release PR"));
    ok("V3 PR step spec contains Closes #102, Closes #103", (prTask?.spec || "").includes("Closes #102, Closes #103"));
    ok("V3 PR step spec contains Refs #101", (prTask?.spec || "").includes("Refs #101"));

    const { listLedgerSummaries } = await import(join(REPO, ".orca", "ledger.mjs"));
    const sums = listLedgerSummaries({ ledgerHome: ledgerV3 });
    eq("V3 ledger recorded epic #101", sums[0]?.issues?.epic?.number, 101);
    eq("V3 ledger recorded 2 tasks", sums[0]?.issues?.tasks?.length, 2);
  } finally {
    try { rmSync(issCfgPath, { force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// V4 — Stack-Aware CI Generator (Hybrid Python+Vue+Docker) & Intranet CD
// ---------------------------------------------------------------------------
scenario("V4 CI/CD Generator (hybrid Python+Vue+Docker CI + Self-Hosted Intranet CD)", async () => {
  const { detectProjectStacks } = await import(join(REPO, ".orca", "ci-generator.mjs"));
  const { spawnSync } = await import("node:child_process");

  const tmpV4 = mkdtempSync(join(tmpdir(), "orca-v4-sxcj-"));
  dirsOfCurrentScenario.push(tmpV4);
  mkdirSync(join(tmpV4, "backend", "tests"), { recursive: true });
  mkdirSync(join(tmpV4, "frontend"), { recursive: true });
  writeFileSync(join(tmpV4, "backend", "requirements.txt"), "fastapi==0.115.0\npytest==8.3.0\nruff==0.7.0\n");
  writeFileSync(join(tmpV4, "backend", "Dockerfile"), "FROM python:3.12-slim\n");
  writeFileSync(join(tmpV4, "backend", "tests", "test_health.py"), "def test_ok(): assert True\n");
  writeFileSync(join(tmpV4, "frontend", "package.json"), JSON.stringify({
    name: "sxcj-web",
    scripts: { lint: "eslint .", test: "vitest run", build: "vite build" },
    dependencies: { vue: "^3.5.0" },
    devDependencies: { vite: "^5.4.0", vitest: "^2.1.0" },
  }, null, 2));
  writeFileSync(join(tmpV4, "frontend", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(tmpV4, "docker-compose.yml"), "services:\n  api:\n    build: ./backend\n");

  const det = detectProjectStacks(tmpV4);
  eq("V4 detected 1 Python stack (backend)", det.python.length, 1);
  eq("V4 Python dir is backend", det.python[0].dir, "backend");
  eq("V4 Python hasPytest=true & hasRuff=true", [det.python[0].hasPytest, det.python[0].hasRuff], [true, true]);
  eq("V4 detected 1 Node stack (frontend)", det.node.length, 1);
  eq("V4 Node dir is frontend & pm is pnpm", [det.node[0].dir, det.node[0].packageManager], ["frontend", "pnpm"]);
  eq("V4 detected docker-compose.yml", det.composeFile, "docker-compose.yml");

  // Run CLI generator with --self-hosted-cd
  const gen = spawnSync(NODE, [
    join(REPO, ".orca", "ci-generator.mjs"),
    "--dir", tmpV4, "--write", "--self-hosted-cd",
    "--health-url", "http://127.0.0.1:8000/api/health",
    "--deploy-branch", "main",
  ], { encoding: "utf8" });
  eq("V4 ci-generator CLI exited 0", gen.status, 0);

  const ciYml = readFileSync(join(tmpV4, ".github", "workflows", "ci-release.yml"), "utf8");
  ok("V4 CI has verify-python-backend job", ciYml.includes("verify-python-backend:"));
  ok("V4 CI runs ruff and pytest", ciYml.includes("ruff check .") && ciYml.includes("pytest -q"));
  ok("V4 CI has verify-node-frontend job", ciYml.includes("verify-node-frontend:"));
  ok("V4 CI runs pnpm install & pnpm run build", ciYml.includes("pnpm install") && ciYml.includes("pnpm run build"));
  ok("V4 CI has verify-docker compose config validation", ciYml.includes('docker compose -f "docker-compose.yml" config --quiet'));
  ok("V4 CI tokenhub review waits for all verify jobs", ciYml.includes("needs: [verify-python-backend, verify-node-frontend, verify-docker]"));

  const cdYml = readFileSync(join(tmpV4, ".github", "workflows", "cd-selfhosted.yml"), "utf8");
  ok("V4 CD runs on self-hosted runner", cdYml.includes("runs-on: [self-hosted, linux]"));
  ok("V4 CD documents outbound HTTPS / zero public SSH", /OUTBOUND HTTPS/.test(cdYml) && /ZERO public SSH/.test(cdYml));
  ok("V4 CD deploys via docker compose up -d --build", cdYml.includes('COMPOSE_FILE="docker-compose.yml"') && /docker compose -f "\$COMPOSE_FILE"(?: -f [^\s]+)? up -d --build/.test(cdYml));
  ok("V4 CD has automated health check against configured URL", cdYml.includes("http://127.0.0.1:8000/api/health") && cdYml.includes("curl -fsS"));

  // Verify bin/init.mjs on a fresh hybrid project auto-tailors CI workflow!
  const tmpV4Init = mkdtempSync(join(tmpdir(), "orca-v4-init-"));
  dirsOfCurrentScenario.push(tmpV4Init);
  mkdirSync(join(tmpV4Init, "backend"), { recursive: true });
  writeFileSync(join(tmpV4Init, "backend", "requirements.txt"), "pytest\n");
  const initRes = await runInit({ name: "v4-init", dir: tmpV4Init, args: ["--no-interactive", "--self-hosted-cd"] });
  eq("V4 init with --self-hosted-cd exited 0", initRes.code, 0);
  const tailoredCi = readFileSync(join(tmpV4Init, ".github", "workflows", "ci-release.yml"), "utf8");
  ok("V4 init auto-tailored CI for Python backend", tailoredCi.includes("verify-python-backend:"));
  ok("V4 init created cd-selfhosted.yml", existsSync(join(tmpV4Init, ".github", "workflows", "cd-selfhosted.yml")));
});

// ---------------------------------------------------------------------------
// V5 — P0-01 + P1-04 + P2-01: Safe Stop Verification, Partial ColdStart Cleanup,
// Windows agy Settings File, and Accurate Multi-Hop Ledger Routing
// ---------------------------------------------------------------------------
scenario("V5 Safe stop verification, Windows agy settings file & accurate fallback ledger", async () => {
  const { buildAgySettingsArg, normalizeOrcaWorkerAgent } = await import(join(REPO, ".orca", "lib", "orca-cli.mjs"));
  const { listLedgerSummaries } = await import(join(REPO, ".orca", "ledger.mjs"));

  // 1) Agent alias normalization & Windows session settings file
  eq("V5 normalizeOrcaWorkerAgent maps agy -> antigravity", normalizeOrcaWorkerAgent("agy"), "antigravity");
  eq("V5 normalizeOrcaWorkerAgent keeps codex", normalizeOrcaWorkerAgent("codex"), "codex");

  const tmpV5 = mkdtempSync(join(tmpdir(), "orca-v5-"));
  dirsOfCurrentScenario.push(tmpV5);
  const winSettingsDir = join(tmpV5, "win-settings");
  const winArg = buildAgySettingsArg(["C:\\Users\\Dev User\\wt-backend"], { isWin: true, settingsDir: winSettingsDir });
  const winFileMatch = winArg.match(/^--settings "([^"]+)"$/);
  ok("V5 Windows agy settings uses quoted file path without inner escaped quotes", Boolean(winFileMatch));
  const winSettingsJson = JSON.parse(readFileSync(winFileMatch[1], "utf8"));
  eq("V5 Windows agy settings file stores exact trustedWorkspaces path with spaces", winSettingsJson.trustedWorkspaces, ["C:\\Users\\Dev User\\wt-backend"]);

  // 2) Unconfirmed worker-stop (`stop_unknown`) MUST refuse blind fallback onto same worktree
  const stopCfgPath = join(REPO, ".orca", "_tmp-v5-stop.config.json");
  const multiCfgPath = join(REPO, ".orca", "_tmp-v5-multihop.config.json");
  try {
    writeFileSync(stopCfgPath, JSON.stringify({
      defaults: {
        timeoutMs: 4000,
        hardTimeoutMs: 15000,
        preflight: { enabled: false },
        watchdog: { enabled: true, fallbackOnGatewayError: true },
      },
      skills: {
        "clean-check": { description: "Cleanup check", prompt: "Verify finally restores worktree." },
      },
      pipeline: [{
        id: "backend",
        title: "Backend Worker",
        agent: "claude",
        skills: ["clean-check"],
        fallback: { agent: "codex" },
        spec: "Write {out}.",
        writes: "BACKEND.md",
      }],
    }));
    const rStop = await runFlow({
      name: "v5-stop-unconfirmed",
      config: "_tmp-v5-stop.config.json",
      scenario: "v51-stop-unconfirmed.cjs",
      args: ["--ledger-home", join(tmpV5, "ledger-stop")],
      budgetMs: 30000,
    });
    eq("V5 unconfirmed stop exits non-zero (still-running)", rStop.code, 1);
    eq("V5 refused to launch fallback candidate when worker-stop failed", (rStop.state?.extra?.starts || []).length, 1);
    ok("V5 logged refusal to reuse worktree", /could not prove old worker stopped.*pausing without reusing worktree/.test(rStop.out + rStop.err));
    ok("V5 runGroup finally restored .claude/skills cleanly", !existsSync(join(rStop.wt, ".orca-agent-config.json")) && !existsSync(join(rStop.wt, ".claude", "skills", "clean-check")));

    // 3) P2-01: Multi-hop fallback (watchdog -> dead preflight hop -> default-model fallback) records both hops & model="default"
    const net = await import("node:net");
    const deadPort = await new Promise((resPort) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resPort(p)); });
    });
    writeFileSync(multiCfgPath, JSON.stringify({
      defaults: {
        timeoutMs: 4000,
        hardTimeoutMs: 20000,
        preflight: { enabled: true, timeoutMs: 400 },
        watchdog: { enabled: true, fallbackOnGatewayError: true },
      },
      pipeline: [{
        id: "backend",
        title: "Backend Worker",
        agent: "opencode2",
        model: "magpie/deepseek-v4.1-flash",
        preflight: { enabled: false },
        fallbacks: [
          { agent: "zcode", model: "glm-5.3", preflight: { tcp: `127.0.0.1:${deadPort}`, timeoutMs: 400 } },
          { agent: "agy", model: "default" },
        ],
        spec: "Write {out}.",
        writes: "BACKEND.md",
      }],
    }));
    const ledgerMulti = join(tmpV5, "ledger-multi");
    const rMulti = await runFlow({
      name: "v5-multihop",
      config: "_tmp-v5-multihop.config.json",
      scenario: "v5-watchdog-gw-fallback.cjs",
      args: ["--ledger-home", ledgerMulti],
      budgetMs: 45000,
    });
    eq("V5 multi-hop fallback succeeded", rMulti.code, 0);
    const sumMulti = listLedgerSummaries({ ledgerHome: ledgerMulti })[0];
    eq("V5 ledger recorded both watchdog hop and preflight hop", sumMulti?.fallbacks?.map((f) => f.phase), ["watchdog", "preflight"]);
    eq("V5 ledger final step model is 'default' (did NOT leak primary's magpie model)", sumMulti?.steps?.backend?.model, "default");
  } finally {
    for (const f of [stopCfgPath, multiCfgPath]) { try { rmSync(f, { force: true }); } catch {} }
  }
});

// ---------------------------------------------------------------------------
// V6 — P0-03 + sxcj #2: Hard Cross-Family Review Isolation (Static, Mid-Run Fallback & Resume)
// ---------------------------------------------------------------------------
scenario("V6 Hard Cross-Family Review Isolation (blocks author-family fallback & preserves across --from resume)", async () => {
  const { classifyModelFamily, buildCandidateChain, filterCrossFamilyCandidates } = await import(join(REPO, ".orca", "preflight.mjs"));
  const { applyStrategyToProject } = await import(join(REPO, ".orca", "strategy-wizard.mjs"));
  const { listLedgerSummaries } = await import(join(REPO, ".orca", "ledger.mjs"));

  // 1) Model family classification
  eq("V6 agy + claude-sonnet-5-5 -> anthropic", classifyModelFamily("agy", "claude-sonnet-5-5"), "anthropic");
  eq("V6 claude + claude-opus-5-5 -> anthropic", classifyModelFamily("claude", "claude-opus-5-5"), "anthropic");
  eq("V6 agy + gpt-5.4 -> openai", classifyModelFamily("agy", "gpt-5.4"), "openai");
  eq("V6 agy default (unpinned router) -> unknown", classifyModelFamily("agy", null), "unknown");
  eq("V6 opencode2 + magpie/deepseek-v4.1 -> deepseek", classifyModelFamily("opencode2", "magpie/remote/deepseek-v4.1"), "deepseek");
  eq("V6 zcode -> zhipu", classifyModelFamily("zcode", null), "zhipu");
  eq("V6 codex -> openai", classifyModelFamily("codex", "gpt-6.2-sol"), "openai");

  // 2) Review step never inherits unrestricted global defaults.fallback
  const revChain = buildCandidateChain(
    { id: "contract-review", agent: "codex", crossFamilyWith: ["contract-architecture"], verify: { requireVerdict: "PASS" } },
    { defaults: { fallback: { agent: "gemini" } } }
  );
  eq("V6 contract-review ignores global defaults.fallback", revChain.map((c) => c.agent), ["codex"]);

  const filtered = filterCrossFamilyCandidates(
    [
      { agent: "codex", model: "gpt-6.2-sol", family: "openai", isPrimary: true },
      { agent: "claude", model: "claude-opus-5-5", family: "anthropic", isPrimary: false },
    ],
    new Map([["anthropic", [{ stepId: "coding", agent: "agy", model: "claude-sonnet-5-5" }]]])
  );
  eq("V6 filterCrossFamilyCandidates strips anthropic fallback", filtered.allowed.map((c) => c.agent), ["codex"]);
  eq("V6 filterCrossFamilyCandidates records rejected anthropic candidate", filtered.rejected.length, 1);

  // 3) Strategy wizard scopes fallback via agentFallbacks and never overrides reviewer into coordinator/coder
  const wizInit = await runInit({ name: "v6-wiz", args: ["--no-interactive"] });
  applyStrategyToProject(wizInit.dir, {
    defaultTrack: "flow-epic.json",
    targetBranch: "dev",
    protectedBranches: ["main", "master"],
    fallbackAgent: "agy",
    roles: { coordinator: "agy", visual: "agy", coder: "opencode2", coderAlt: "zcode", reviewer: "codex", release: "codex" },
  });
  const wizEpic = JSON.parse(readFileSync(join(wizInit.dir, ".orca", "flow-epic.json"), "utf8"));
  eq("V6 strategy-wizard did NOT write unrestricted defaults.fallback", wizEpic.defaults.fallback, undefined);
  eq("V6 strategy-wizard scoped fallback to coder in agentFallbacks", wizEpic.defaults.agentFallbacks?.opencode2?.[0]?.agent, "agy");
  eq("V6 strategy-wizard did NOT attach agy fallback to codex reviewer", wizEpic.defaults.agentFallbacks?.codex, undefined);

  // 4) E2E sxcj #2 scenario: coder falls back mid-run `opencode2 -> agy(claude-sonnet-5-5)` [anthropic];
  //    reviewer primary `codex` fails, fallback `claude(claude-opus-5-5)` [anthropic] MUST BE REJECTED & BLOCKED!
  const tmpV6 = mkdtempSync(join(tmpdir(), "orca-v6-"));
  dirsOfCurrentScenario.push(tmpV6);
  const cfCfgPath = join(REPO, ".orca", "_tmp-v6-crossfamily.config.json");
  try {
    writeFileSync(cfCfgPath, JSON.stringify({
      defaults: {
        timeoutMs: 4000,
        hardTimeoutMs: 20000,
        startRetries: 0,
        preflight: { enabled: false },
        watchdog: { enabled: true, fallbackOnGatewayError: true },
      },
      skills: {
        "fe-check": { description: "Frontend skill", prompt: "Follow DESIGN.md." },
      },
      pipeline: [
        {
          id: "coding",
          title: "Coding",
          agent: "opencode2",
          model: "magpie/deepseek-v4.1-flash",
          skills: ["fe-check"],
          fallback: { agent: "agy", model: "claude-sonnet-5-5", effort: "medium" },
          spec: "Implement feature in {out}.",
          writes: "CHANGES.md",
        },
        {
          id: "code-review",
          title: "Cross-Family Code Review",
          agent: "codex",
          model: "gpt-6.2-sol",
          crossFamilyWith: ["coding"],
          fallback: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
          reads: ["coding"],
          onFailGoto: "coding",
          verify: { requireVerdict: "PASS" },
          spec: "Review {reads} into {out}.",
          writes: "REVIEW.md",
        },
      ],
    }));

    const ledgerV6 = join(tmpV6, "ledger");
    const rCf = await runFlow({
      name: "v6-midrun-cf",
      config: "_tmp-v6-crossfamily.config.json",
      scenario: "v51-midrun-crossfamily.cjs",
      args: ["--ledger-home", ledgerV6],
      budgetMs: 45000,
    });
    eq("V6 mid-run self-review fallback blocked (exit 1)", rCf.code, 1);
    eq("V6 coding fallback mounted .agents/skills/fe-check for agy", rCf.state?.extra?.agySkillMountedDuringFallback, true);
    ok("V6 .agents/skills cleaned up after group exit", !existsSync(join(rCf.wt, ".agents", "skills", "fe-check")));
    const cfStarts = rCf.state?.extra?.starts || [];
    ok("V6 claude-opus-5-5 was NEVER dispatched for code-review", !cfStarts.some((s) => s.agent === "claude" || s.model === "claude-opus-5-5"));
    ok("V6 logged explicit cross-family violation diagnostic", /\[cross-family\].*family "anthropic" matches upstream author coding\[agy:claude-sonnet-5-5\]/.test(rCf.out + rCf.err));

    // 5) Resume with `--from code-review` in the same worktree/ledger: must STILL remember coding ran as anthropic!
    const rResume = await runFlow({
      name: "v6-resume-cf",
      config: "_tmp-v6-crossfamily.config.json",
      scenario: "v51-midrun-crossfamily.cjs",
      reuseDir: rCf.dir,
      args: ["--from", "code-review", "--ledger-home", ledgerV6],
      budgetMs: 30000,
    });
    eq("V6 --from resume still blocks anthropic self-review", rResume.code, 1);
    ok("V6 --from resume rejected claude-opus-5-5 against persisted coding family", /\[cross-family\].*family "anthropic" matches upstream author coding/.test(rResume.out + rResume.err));
    const sumsV6 = listLedgerSummaries({ ledgerHome: ledgerV6 });
    ok("V6 ledger persisted step family=anthropic on coding", sumsV6.some((s) => s.steps?.coding?.family === "anthropic"));
  } finally {
    try { rmSync(cfCfgPath, { force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// V7 — P1-01 + P1-02 + P1-03: Watchdog Precision, Content-Hashed Fingerprints,
// Strict maxRuntimeMs Ceiling, JSONC/IPv6/Port Preflight & HTTP Body Cleanup
// ---------------------------------------------------------------------------
scenario("V7 Watchdog precision, content-hashed git fingerprint, maxRuntimeMs ceiling & preflight IPv6/JSONC/HTTP", async () => {
  const {
    detectPromptBlocked,
    detectOutputLoop,
    probeWorktreeActivity,
    createWatchdogTracker,
    evaluateWatchdog,
  } = await import(join(REPO, ".orca", "watchdog.mjs"));
  const {
    discoverOpencodeLocalEndpoints,
    parseHostPort,
    checkCandidateHealth,
    probeHttp,
  } = await import(join(REPO, ".orca", "preflight.mjs"));
  const { spawnSync } = await import("node:child_process");

  // 1) P1-01: Tail-only gateway error scan + recovery + dedup + approval vs trust + exact loopThreshold=4
  const wt0 = 2000000;
  const tracker = createWatchdogTracker({
    step: { watchdog: { loopThreshold: 4, fallbackOnGatewayError: true, fallbackOnPromptBlocked: true } },
    startedAt: wt0,
    probeFn: () => ({ gitFingerprint: "fp1", gitOk: true, artifactFingerprint: "af1", artifactSize: 0 }),
  });
  const gw1 = evaluateWatchdog(tracker, {
    now: wt0 + 1000,
    preview: "Connecting...\nError: connect ECONNREFUSED 127.0.0.1:3425",
    previewChanged: true,
    previewSeenBefore: false,
    fallbackAvailable: false,
  });
  eq("V7 initial ECONNREFUSED triggers gateway_disconnect", gw1.kind, "gateway_disconnect");
  eq("V7 first anomaly is not deduplicated", gw1.deduplicated, false);

  // Historic ECONNREFUSED still in scrollback, but new lines show recovery + git fingerprint advanced!
  const gwRecovered = evaluateWatchdog(tracker, {
    now: wt0 + 3000,
    preview: "Connecting...\nError: connect ECONNREFUSED 127.0.0.1:3425\nReconnected to backup!\nEdited handler.py and passed 12 tests.",
    previewChanged: true,
    previewSeenBefore: true,
    fallbackAvailable: true,
    probeOverride: { gitFingerprint: "fp2", gitOk: true, artifactFingerprint: "af1", artifactSize: 0 },
  });
  eq("V7 historic ECONNREFUSED after recovery + git progress stays healthy (no false fallback)", gwRecovered.status, "healthy");

  // Human approval (`user_approval` / permission prompt) blocks instead of falling back!
  const waitApproval = evaluateWatchdog(tracker, {
    now: wt0 + 4000,
    preview: "Running deployment...",
    previewChanged: false,
    previewSeenBefore: true,
    agentWait: { kind: "user_approval", reason: "Approve command?" },
    fallbackAvailable: true,
    probeOverride: { gitFingerprint: "fp2", gitOk: true, artifactFingerprint: "af1", artifactSize: 0 },
  });
  eq("V7 user_approval sets action=block (NEVER fallback)", waitApproval.action, "block");
  const waitApprovalDup = evaluateWatchdog(tracker, {
    now: wt0 + 5000,
    preview: "Running deployment...",
    previewChanged: false,
    previewSeenBefore: true,
    agentWait: { kind: "user_approval", reason: "Approve command?" },
    fallbackAvailable: true,
    probeOverride: { gitFingerprint: "fp2", gitOk: true, artifactFingerprint: "af1", artifactSize: 0 },
  });
  eq("V7 repeated user_approval anomaly is deduplicated", waitApprovalDup.deduplicated, true);

  const trustPb = detectPromptBlocked("Do you trust the contents of this project?\n[y/N]");
  const permPb = detectPromptBlocked("Do you want to proceed?\n[y/N]");
  eq("V7 workspace trust has trustBlock=true", trustPb?.trustBlock, true);
  eq("V7 normal permission prompt has trustBlock=false (humanApproval=true)", [permPb?.trustBlock, permPb?.humanApproval], [false, true]);

  // Exact loopThreshold=4 triggers on 4 identical consecutive lines (not 5!)
  const exact4 = detectOutputLoop([], [
    "Retrying broken schema tool call...",
    "Retrying broken schema tool call...",
    "Retrying broken schema tool call...",
    "Retrying broken schema tool call...",
  ], { threshold: 4 });
  eq("V7 detectOutputLoop triggers at exact 4 repeats for threshold=4", exact4?.repeats, 4);

  // Static unchanged preview does NOT trigger output_loop in evaluateWatchdog
  const staticLoopCheck = evaluateWatchdog(tracker, {
    now: wt0 + 6000,
    preview: Array.from({ length: 5 }, () => "Retrying broken schema tool call...").join("\n"),
    previewChanged: false,
    previewSeenBefore: true,
    fallbackAvailable: false,
    probeOverride: { gitFingerprint: "fp2", gitOk: true, artifactFingerprint: "af1", artifactSize: 0 },
  });
  eq("V7 unchanged static preview does not fire output_loop", staticLoopCheck.status, "healthy");

  // 2) P1-02: Real git content-hash fingerprinting + non-git unknown + sharedWorktree isolation + maxRuntimeMs ceiling
  const tmpGit = mkdtempSync(join(tmpdir(), "orca-v7-git-"));
  const tmpNonGit = mkdtempSync(join(tmpdir(), "orca-v7-nongit-"));
  dirsOfCurrentScenario.push(tmpGit, tmpNonGit);
  eq("V7 non-git dir returns gitFingerprint=null (unknown)", probeWorktreeActivity(tmpNonGit).gitFingerprint, null);

  spawnSync("git", ["init", tmpGit], { encoding: "utf8" });
  spawnSync("git", ["-C", tmpGit, "config", "user.email", "test@local"], { encoding: "utf8" });
  spawnSync("git", ["-C", tmpGit, "config", "user.name", "Tester"], { encoding: "utf8" });
  writeFileSync(join(tmpGit, "app.py"), "x = 1\ny = 2\n");
  spawnSync("git", ["-C", tmpGit, "add", "app.py"], { encoding: "utf8" });
  spawnSync("git", ["-C", tmpGit, "commit", "-m", "init"], { encoding: "utf8" });

  writeFileSync(join(tmpGit, "app.py"), "x = 2\ny = 2\n");
  const fpEdit1 = probeWorktreeActivity(tmpGit).gitFingerprint;
  writeFileSync(join(tmpGit, "app.py"), "x = 3\ny = 2\n"); // Same line count & diff shortstat!
  const fpEdit2 = probeWorktreeActivity(tmpGit).gitFingerprint;
  ok("V7 content hash catches equal-line-count edit (x=2 -> x=3)", Boolean(fpEdit1 && fpEdit2 && fpEdit1 !== fpEdit2));

  writeFileSync(join(tmpGit, "untracked.py"), "step = 1\n");
  const fpUntracked1 = probeWorktreeActivity(tmpGit).gitFingerprint;
  writeFileSync(join(tmpGit, "untracked.py"), "step = 2\nmore = True\n");
  const fpUntracked2 = probeWorktreeActivity(tmpGit).gitFingerprint;
  ok("V7 content hash catches repeated writes to same untracked file", fpUntracked1 !== fpUntracked2);

  // Shared worktree artifact scoping
  const sharedArtDir = join(tmpGit, ".orca", "artifacts");
  mkdirSync(sharedArtDir, { recursive: true });
  writeFileSync(join(sharedArtDir, "OWN.md"), "initial");
  writeFileSync(join(sharedArtDir, "SIBLING.md"), "s1");
  const sfp1 = probeWorktreeActivity(tmpGit, { artifactPath: join(sharedArtDir, "OWN.md"), artDirPath: sharedArtDir, sharedWorktree: true }).artifactFingerprint;
  writeFileSync(join(sharedArtDir, "SIBLING.md"), "s2-modified-by-other-worker");
  const sfp2 = probeWorktreeActivity(tmpGit, { artifactPath: join(sharedArtDir, "OWN.md"), artDirPath: sharedArtDir, sharedWorktree: true }).artifactFingerprint;
  eq("V7 sharedWorktree=true ignores sibling worker artifact edits", sfp1, sfp2);

  // E2E strict maxRuntimeMs ceiling
  const ceilCfgPath = join(REPO, ".orca", "_tmp-v7-ceil.config.json");
  try {
    writeFileSync(ceilCfgPath, JSON.stringify({
      defaults: {
        timeoutMs: 1000,
        hardTimeoutMs: 1500,
        watchdog: { enabled: true, extendOnActivity: true, extendStepMs: 10000, activityFreshMs: 10000, maxRuntimeMs: 2400 },
      },
      pipeline: [{ id: "alpha", title: "Alpha", agent: "stub", spec: "Work {out}.", writes: "A.md" }],
    }));
    const rCeil = await runFlow({
      name: "v7-maxruntime-ceil",
      config: "_tmp-v7-ceil.config.json",
      scenario: "v5-watchdog-active.cjs",
      budgetMs: 25000,
    });
    eq("V7 active worker stopped at strict maxRuntimeMs ceiling (exit 1)", rCeil.code, 1);
    ok("V7 logged maxRuntimeMs ceiling reached", /reached maxRuntimeMs ceiling/.test(rCeil.out + rCeil.err));
  } finally {
    try { rmSync(ceilCfgPath, { force: true }); } catch {}
  }

  // 3) P1-03: JSONC opencode.jsonc, cloud default model skips localhost, IPv6 [::1], invalid port 70000, HTTP body cancel
  const tmpOc = mkdtempSync(join(tmpdir(), "orca-v7-oc-"));
  dirsOfCurrentScenario.push(tmpOc);
  writeFileSync(join(tmpOc, "opencode.jsonc"), `{
    // Cloud model configured as default
    "model": "anthropic/claude-sonnet-4-5",
    "provider": {
      /* Unused local gateway should NOT be probed when cloud model is active */
      "magpie": { "options": { "baseURL": "http://[::1]:3425/v1", }, },
    },
  }`);
  const cloudEps = discoverOpencodeLocalEndpoints({ projectDir: tmpOc, model: null });
  eq("V7 JSONC with default cloud model skips unrelated localhost provider", cloudEps.length, 0);
  const ipv6Eps = discoverOpencodeLocalEndpoints({ projectDir: tmpOc, model: "magpie/deepseek-v4.1" });
  eq("V7 bracketed IPv6 [::1] normalized & discovered when magpie model selected", [ipv6Eps.length, ipv6Eps[0]?.host, ipv6Eps[0]?.port], [1, "::1", 3425]);
  eq("V7 parseHostPort rejects port 70000", parseHostPort("127.0.0.1:70000"), null);

  const badPortHealth = await checkCandidateHealth({ agent: "opencode2", preflight: { tcp: "127.0.0.1:70000" } });
  eq("V7 out-of-range TCP port returns structured INVALID_ENDPOINT configError without throwing", [badPortHealth.ok, badPortHealth.configError, badPortHealth.code], [false, true, "INVALID_ENDPOINT"]);

  // HTTP probe socket/body release verification against a streaming server that never finishes body
  let activeSockets = 0;
  const streamSrv = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("header-ok\n");
    // Deliberately never call res.end() — cancelling resp.body must abort the stream & close socket!
  });
  streamSrv.on("connection", (sock) => {
    activeSockets++;
    sock.on("close", () => { activeSockets--; });
  });
  await new Promise((r) => streamSrv.listen(0, "127.0.0.1", r));
  const streamPort = streamSrv.address().port;
  try {
    const httpRes = await probeHttp(`http://user:supersecret@127.0.0.1:${streamPort}/health?api_key=tok123`, 1500);
    eq("V7 probeHttp succeeded on headers", httpRes.ok, true);
    ok("V7 probeHttp sanitized URL credentials & api_key", !httpRes.url.includes("supersecret") && !httpRes.url.includes("tok123"));
    await new Promise((r) => setTimeout(r, 120));
    eq("V7 probeHttp cancelled body & closed underlying socket cleanly", activeSockets, 0);
  } finally {
    streamSrv.close();
  }
});

// ---------------------------------------------------------------------------
// V8 — P1-05..P1-08 + sxcj #3: Scoped ISSUES.json, --no-issues Isolation,
// Hardened Backlog Parser, Safe Label-Only Retry, Atomic Save & dev Close Rule
// ---------------------------------------------------------------------------
scenario("V8 Hardened Issue Tracker (fences, CJK, --no-issues, label-only retry, atomic save & dev branch close)", async () => {
  const {
    parseBacklogTasks,
    loadIssueState,
    saveIssueState,
    createIssueViaCli,
    syncPlanIssues,
    formatIssuePrBlock,
  } = await import(join(REPO, ".orca", "issue-tracker.mjs"));

  // 1) P1-06: Fenced code blocks, checked [x] items, non-task [bracket] headings, cross-repo #17, CJK short titles
  const trickyMd = [
    "# Backlog",
    "### [Architecture] System Overview",
    "- [x] T0: Already finished task should be skipped",
    "```markdown",
    "### T99: Fake task inside code fence referencing other/repo#17",
    "- [ ] T98: Another fenced item #88",
    "```",
    "### T1: 建表迁移",
    "- [ ] T2: Adapt parser inspired by upstream/repo#17",
    "- [ ] T3: Fix local bug (Issue: #42)",
    "| T4 | 登录页 | frontend |",
    "- [ ] T5: Retry step #2 on transient timeout",
  ].join("\n");
  const tasks = parseBacklogTasks(trickyMd);
  eq("V8 parsed only the 5 real open tasks", tasks.map((t) => t.id), ["T1", "T2", "T3", "T4", "T5"]);
  eq("V8 preserved 4-char CJK title '建表迁移' & inferred backend", [tasks[0].title, tasks[0].owner], ["建表迁移", "backend"]);
  eq("V8 ignored cross-repo upstream/repo#17 as local issue number", tasks[1].number, null);
  eq("V8 extracted explicit (Issue: #42) as local issue number", tasks[2].number, 42);
  eq("V8 preserved 3-char CJK title '登录页' & inferred frontend", [tasks[3].title, tasks[3].owner], ["登录页", "frontend"]);
  eq("V8 ignored bare prose '#2' in 'Retry step #2'", tasks[4].number, null);

  // 2) P1-05 & P1-06: Epic number validation, scope mismatch isolation, and mode=false isolation
  const tmpV8 = mkdtempSync(join(tmpdir(), "orca-v8-"));
  dirsOfCurrentScenario.push(tmpV8);
  writeFileSync(join(tmpV8, "ISSUES.json"), JSON.stringify({
    provider: "gh",
    repo: "shown1985/sxcj",
    objective: "Old Run A",
    epic: { number: -5, title: "Invalid negative epic" },
    tasks: [{ id: "T1", title: "Old task", number: 77 }],
  }));
  const loadedInvalidEpic = loadIssueState(tmpV8);
  eq("V8 invalid negative epic.number sanitized to null", loadedInvalidEpic.epic, null);
  eq("V8 loadIssueState returns null when mode===false (--no-issues)", loadIssueState(tmpV8, { mode: false }), null);
  eq("V8 loadIssueState returns null on different objective", loadIssueState(tmpV8, { provider: "gh", repo: "shown1985/sxcj", objective: "New Run B" }), null);
  eq("V8 loadIssueState returns null on different repo", loadIssueState(tmpV8, { provider: "gh", repo: "other/repo", objective: "Old Run A" }), null);

  // 3) P1-07: Explicit --repo binding, label-only retry (never on timeout!), and atomic per-issue persistence
  const cliCalls = [];
  const labelRetryRes = createIssueViaCli({
    provider: "gh",
    bin: "gh",
    repoDir: tmpV8,
    repo: "shown1985/sxcj",
    title: "Test issue",
    body: "Body",
    labels: ["missing-label"],
    execFn: (_bin, args) => {
      cliCalls.push(args);
      if (args.includes("--label")) {
        return { ok: false, status: 1, stdout: "", stderr: "could not add label: 'missing-label' not found", timedOut: false };
      }
      return { ok: true, status: 0, stdout: "https://github.com/shown1985/sxcj/issues/55", stderr: "", timedOut: false };
    },
  });
  eq("V8 label error retried without labels & succeeded (#55)", [labelRetryRes.ok, labelRetryRes.number, cliCalls.length], [true, 55, 2]);
  ok("V8 explicit --repo passed to gh issue create", cliCalls[0].includes("--repo") && cliCalls[0][cliCalls[0].indexOf("--repo") + 1] === "shown1985/sxcj");

  let timeoutAttempts = 0;
  const timeoutRes = createIssueViaCli({
    provider: "gh",
    bin: "gh",
    repoDir: tmpV8,
    repo: "shown1985/sxcj",
    title: "Timeout issue",
    body: "Body",
    labels: ["orca-pod"],
    execFn: () => {
      timeoutAttempts++;
      return { ok: false, status: -1, stdout: "", stderr: "request timed out", error: "ETIMEDOUT", timedOut: true };
    },
  });
  eq("V8 timeout NEVER retries (prevents duplicate remote issues)", [timeoutRes.ok, timeoutAttempts], [false, 1]);

  // Mid-batch failure atomic persistence test: Epic + T1 succeed, T2 crashes -> Epic + T1 are already saved on disk!
  const midArtDir = join(tmpV8, "mid-art");
  mkdirSync(midArtDir, { recursive: true });
  const planFile = join(midArtDir, "PLAN.md");
  writeFileSync(planFile, "### T1: First task\n### T2: Second task crashes\n");
  let createSeq = 0;
  try {
    syncPlanIssues({
      providerInfo: { enabled: true, provider: "gh", bin: "gh", repo: "shown1985/sxcj", host: "github.com", defaultBranch: "main" },
      repoDir: tmpV8,
      artDirAbs: midArtDir,
      objective: "Atomic Persistence Test",
      artifactPath: planFile,
      execFn: (_bin, args) => {
        if (args[0] === "issue" && args[1] === "create") {
          createSeq++;
          if (createSeq === 1) return { ok: true, status: 0, stdout: "https://github.com/shown1985/sxcj/issues/200", stderr: "" };
          if (createSeq === 2) return { ok: true, status: 0, stdout: "https://github.com/shown1985/sxcj/issues/201", stderr: "" };
          throw new Error("simulated mid-batch crash on T2");
        }
        return { ok: true, status: 0, stdout: "", stderr: "" };
      },
    });
  } catch {}
  const survivedState = loadIssueState(midArtDir);
  eq("V8 atomic per-issue persistence saved Epic #200 & T1 #201 before T2 crash", [survivedState?.epic?.number, survivedState?.tasks?.[0]?.number], [200, 201]);

  // 4) P1-08 + sxcj #3: Non-default targetBranch (`dev` != `main`) explicit post-merge gh issue close guidance
  const devPrFmt = formatIssuePrBlock(
    { provider: "gh", repo: "shown1985/sxcj", epic: { number: 10 }, tasks: [{ number: 11 }] },
    { closeOnPr: true, targetBranch: "dev", defaultBranch: "main" }
  );
  ok("V8 dev!=main block warns Closes #N only auto-closes on default branch main", devPrFmt.block.includes("default branch (`main`)"));
  ok("V8 dev!=main block instructs post-merge gh issue close 11", devPrFmt.block.includes('gh issue close 11 --repo "shown1985/sxcj"'));

  // 5) E2E `--no-issues` isolation with pre-seeded stale ISSUES.json in worktree
  const noIssCfgPath = join(REPO, ".orca", "_tmp-v8-noissues.config.json");
  try {
    writeFileSync(noIssCfgPath, JSON.stringify({
      defaults: { timeoutMs: 10000, targetBranch: "dev" },
      pipeline: [{
        id: "pr-submit",
        title: "Submit PR",
        agent: "stub",
        linkIssues: true,
        spec: "Create PR. Trailers: {issueCloses}",
        writes: "PR.md",
      }],
    }));
    const rNoIss = await runFlow({
      name: "v8-no-issues",
      config: "_tmp-v8-noissues.config.json",
      args: ["--no-issues"],
      seedArtifacts: [{
        file: "ISSUES.json",
        text: JSON.stringify({ provider: "gh", repo: "shown1985/sxcj", epic: { number: 999 }, tasks: [{ id: "T1", title: "Stale", number: 888 }] }),
      }],
      budgetMs: 30000,
    });
    eq("V8 --no-issues E2E succeeded", rNoIss.code, 0);
    const prSpec = Object.values(rNoIss.state?.tasks || {})[0]?.spec || "";
    ok("V8 --no-issues prevented stale #999/#888 from entering PR prompt", !prSpec.includes("#999") && !prSpec.includes("#888") && prSpec.includes("(no linked issues)"));
  } finally {
    try { rmSync(noIssCfgPath, { force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// V9 — P0-02 + P1-09..P1-12 + sxcj #1: Real Bash Failing-Pytest Exit Code,
// YAML Psych Validation, Unique Job IDs, CD Preservation, prod Compose, PII & Gitea API
// ---------------------------------------------------------------------------
scenario("V9 CI/CD hardening (real bash pytest failure exit!=0, Psych YAML, cd-selfhosted preservation, prod compose, PII & Gitea API)", async () => {
  const {
    detectProjectStacks,
    generateCiCdFiles,
    renderCiWorkflow,
    renderSelfHostedCdWorkflow,
  } = await import(join(REPO, ".orca", "ci-generator.mjs"));
  const { sanitizeText } = await import(join(REPO, ".orca", "lib", "sanitize.mjs"));
  const { spawnSync } = await import("node:child_process");

  // 1) P1-09: Secret & PII redaction unit assertions
  const dirtyDiag = "POST https://admin:pa55word@intranet.local/v1?api_key=sk-1234567890abcdef failed for student_zhang@university.edu.cn with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  const redacted = sanitizeText(dirtyDiag);
  ok("V9 redacted URL basic-auth password", !redacted.includes("pa55word"));
  ok("V9 redacted query api_key", !redacted.includes("sk-1234567890abcdef"));
  ok("V9 redacted student email PII", !redacted.includes("student_zhang@university.edu.cn") && redacted.includes("[REDACTED_EMAIL]"));
  ok("V9 redacted Bearer & GitHub PAT tokens", !redacted.includes("eyJhbGciOiJIUzI1NiJ9") && !redacted.includes("ghp_ABCDEF"));
  eq("V9 preserved git SCP remote git@github.com:org/repo", sanitizeText("git@github.com:shown1985/orca-pod.git"), "git@github.com:shown1985/orca-pod.git");

  // 2) P0-02: REAL executable bash test proving failing pytest exits NON-ZERO in BOTH bundled & generated CI!
  const extractStepScript = (yml, stepName) => {
    const lines = yml.split(/\r?\n/);
    const startIdx = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
    if (startIdx < 0) return null;
    let runIdx = -1;
    for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + 12); i++) {
      if (/^\s+run:\s*\|\s*$/.test(lines[i])) { runIdx = i; break; }
    }
    if (runIdx < 0) return null;
    const baseIndent = lines[runIdx + 1]?.match(/^(\s*)/)?.[1]?.length || 10;
    const body = [];
    for (let i = runIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) { body.push(""); continue; }
      const ind = l.match(/^(\s*)/)[1].length;
      if (ind < baseIndent) break;
      body.push(l.slice(baseIndent));
    }
    return body.join("\n");
  };

  const bundledGhCi = readFileSync(join(REPO, ".github", "workflows", "ci-release.yml"), "utf8");
  const bundledGiteaCi = readFileSync(join(REPO, ".gitea", "workflows", "ci-release.yml"), "utf8");
  const pyVerifyScript = extractStepScript(bundledGhCi, "Verify Python projects (root / backend)");
  ok("V9 extracted Python verify bash script from bundled .github/workflows/ci-release.yml", Boolean(pyVerifyScript));
  eq("V9 bundled Gitea Python verify script matches GitHub", extractStepScript(bundledGiteaCi, "Verify Python projects (root / backend)"), pyVerifyScript);

  const tmpPyFail = mkdtempSync(join(tmpdir(), "orca-v9-pyfail-"));
  dirsOfCurrentScenario.push(tmpPyFail);
  const fakeBinDir = join(tmpPyFail, "fake-bin");
  const projFailDir = join(tmpPyFail, "proj");
  mkdirSync(fakeBinDir, { recursive: true });
  mkdirSync(join(projFailDir, "backend", "tests"), { recursive: true });
  writeFileSync(join(projFailDir, "backend", "requirements.txt"), "pytest==8.3.0\n");
  writeFileSync(join(projFailDir, "backend", "tests", "test_broken.py"), "def test_fail(): assert 1 == 2\n");

  // Fake python3 shim in PATH: records exact invocations + exits exact 1 on pytest/unittest!
  const pyInvokeLog = join(tmpPyFail, "py-invocations.log");
  writeFileSync(join(fakeBinDir, "python3"), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(pyInvokeLog)}, JSON.stringify(a) + "\\n");
if (a[0] === "-m" && a[1] === "pip") process.exit(0);
if (a[0] === "-c" && (a[1] || "").includes("import pytest")) process.exit(0);
if (a[0] === "-m" && a[1] === "pytest") { console.error("FAILED tests/test_broken.py::test_fail"); process.exit(1); }
if (a[0] === "-m" && a[1] === "unittest") { console.error("FAILED unittest"); process.exit(1); }
if (a[0] === "-m" && a[1] === "compileall") process.exit(0);
process.exit(0);
`, { mode: 0o755 });
  writeFileSync(join(fakeBinDir, "python"), readFileSync(join(fakeBinDir, "python3")), { mode: 0o755 });
  writeFileSync(join(fakeBinDir, "pytest"), `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(pyInvokeLog)}, '["pytest-bin"]\\n'); console.error("FAILED pytest"); process.exit(1);\n`, { mode: 0o755 });

  const bashEnv = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` };
  const runBundledFail = spawnSync("bash", ["-c", pyVerifyScript], { cwd: projFailDir, env: bashEnv, encoding: "utf8" });
  eq("V9 P0-02 REAL BASH TEST: failing pytest in bundled CI exits exact code 1", runBundledFail.status, 1);
  ok("V9 P0-02 proved python3 -m pytest was actually invoked", readFileSync(pyInvokeLog, "utf8").includes('"-m","pytest"'));

  // Also test generated tailored Python job script with failing pytest!
  writeFileSync(pyInvokeLog, "");
  const genPyCi = renderCiWorkflow(detectProjectStacks(projFailDir));
  const tailoredPyScript = extractStepScript(genPyCi, "Run Python lint & tests");
  const runTailoredFail = spawnSync("bash", ["-c", tailoredPyScript], { cwd: join(projFailDir, "backend"), env: bashEnv, encoding: "utf8" });
  eq("V9 P0-02 REAL BASH TEST: failing pytest in tailored Python CI exits exact code 1", runTailoredFail.status, 1);
  ok("V9 P0-02 proved tailored Python job invoked pytest", readFileSync(pyInvokeLog, "utf8").includes("pytest"));

  // Also verify failed pip install exits exact code 1!
  const pipFailBin = join(tmpPyFail, "pipfail-bin");
  const pipInvokeLog = join(tmpPyFail, "pip-invocations.log");
  mkdirSync(pipFailBin, { recursive: true });
  writeFileSync(join(pipFailBin, "python3"), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(pipInvokeLog)}, JSON.stringify(a) + "\\n");
if (a[0] === "-m" && a[1] === "pip" && a.includes("-r")) { console.error("ERROR: No matching distribution"); process.exit(1); }
process.exit(0);
`, { mode: 0o755 });
  const runPipFail = spawnSync("bash", ["-c", pyVerifyScript], { cwd: projFailDir, env: { ...process.env, PATH: `${pipFailBin}:${process.env.PATH}` }, encoding: "utf8" });
  eq("V9 P0-02 REAL BASH TEST: failing pip install -r requirements.txt exits exact code 1", runPipFail.status, 1);
  ok("V9 P0-02 proved pip -r requirements.txt was invoked", readFileSync(pipInvokeLog, "utf8").includes('"-r","requirements.txt"'));

  // 3) P1-09 & P1-10: Least-privilege permissions, persist-credentials: false, unique job IDs & Ruby Psych YAML parsing!
  const topPermSection = bundledGhCi.slice(0, bundledGhCi.indexOf("jobs:"));
  ok("V9 top-level permissions does NOT grant pull-requests: write", !topPermSection.includes("pull-requests: write") && topPermSection.includes("contents: read"));
  ok("V9 tokenhub-pr-review job scopes pull-requests: write", bundledGhCi.slice(bundledGhCi.indexOf("tokenhub-pr-review:")).includes("pull-requests: write"));
  ok("V9 bundled CI sets persist-credentials: false on checkout", bundledGhCi.includes("persist-credentials: false"));
  ok("V9 bundled generic CI includes Go and Rust verification", bundledGhCi.includes("go.mod") && bundledGhCi.includes("Cargo.toml"));

  const tmpTricky = mkdtempSync(join(tmpdir(), "orca-v9-tricky-"));
  dirsOfCurrentScenario.push(tmpTricky);
  mkdirSync(join(tmpTricky, "apps", "front-end"), { recursive: true });
  mkdirSync(join(tmpTricky, "apps", "front_end"), { recursive: true });
  mkdirSync(join(tmpTricky, "services", "api: core"), { recursive: true });
  writeFileSync(join(tmpTricky, "apps", "front-end", "package.json"), JSON.stringify({ name: "fe-dash", scripts: { test: "node -e 0" } }));
  writeFileSync(join(tmpTricky, "apps", "front_end", "package.json"), JSON.stringify({ name: "fe-under", scripts: { test: "node -e 0" } }));
  writeFileSync(join(tmpTricky, "services", "api: core", "go.mod"), "module example.com/apicore\n\ngo 1.22\n");
  writeFileSync(join(tmpTricky, "Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n");
  writeFileSync(join(tmpTricky, "docker-compose.yml"), "services:\n  dev:\n    image: alpine\n");
  writeFileSync(join(tmpTricky, "docker-compose.prod.yml"), "services:\n  prod:\n    image: alpine\n");

  const detTricky = detectProjectStacks(tmpTricky);
  eq("V9 sxcj #1 prioritizes docker-compose.prod.yml over docker-compose.yml", detTricky.composeFile, "docker-compose.prod.yml");

  const trickyCi = renderCiWorkflow(detTricky, { platform: "github" });
  const trickyGiteaCi = renderCiWorkflow(detTricky, { platform: "gitea" });
  const trickyCd = renderSelfHostedCdWorkflow(detTricky, {
    deployBranch: "main",
    runnerLabels: ["self-hosted", "linux", "zone: intranet"],
    healthUrl: "http://127.0.0.1:8000/health",
    deployDir: "/opt/sxcj/prod app",
  });

  ok("V9 deduplicated apps/front-end and apps/front_end job IDs", trickyCi.includes("verify-node-apps-front-end:") && trickyCi.includes("verify-node-apps-front-end-2:"));
  ok("V9 CD deploys docker-compose.prod.yml", trickyCd.includes('COMPOSE_FILE: "docker-compose.prod.yml"'));
  ok("V9 CD enters deployDir in deploy & health steps", (trickyCd.match(/cd "\$DEPLOY_DIR"/g) || []).length >= 2);
  ok("V9 sxcj #1 PII guard: CD NEVER runs docker compose logs", !/docker compose[^\n]*logs/.test(trickyCd));
  ok("V9 CD gates on CI workflow_run success", trickyCd.includes("workflow_run:") && trickyCd.includes("workflow_run.conclusion == 'success'"));

  // Validate YAML syntax with Ruby Psych if ruby is present on the host
  const rubyCheck = spawnSync("ruby", ["-ryaml", "-e", "puts 'ok'"], { encoding: "utf8" });
  if (!rubyCheck.error && rubyCheck.status === 0) {
    for (const [label, ymlContent] of [
      ["bundled .github/workflows/ci-release.yml", bundledGhCi],
      ["bundled .gitea/workflows/ci-release.yml", bundledGiteaCi],
      ["generated tricky GitHub CI (colons/spaces/dup-slugs)", trickyCi],
      ["generated tricky Gitea CI", trickyGiteaCi],
      ["generated tricky Self-Hosted CD", trickyCd],
    ]) {
      const ymlPath = join(tmpTricky, "check.yml");
      writeFileSync(ymlPath, ymlContent);
      const parsed = spawnSync("ruby", ["-ryaml", "-e", `d = YAML.load_file(${JSON.stringify(ymlPath)}); raise 'bad' unless d.is_a?(Hash) && d['jobs'].is_a?(Hash)`], { encoding: "utf8" });
      eq(`V9 Psych YAML parse valid: ${label}`, parsed.status, 0);
    }
  }

  // 4) P1-11 + sxcj #1: Preserve existing `.github/workflows/cd-selfhosted.yml` unless `--force` is passed!
  const customCdText = "# HAND-HARDENED SXCJ INTRANET CD — DO NOT CLOBBER\nname: Custom SXCJ CD\n";
  mkdirSync(join(tmpTricky, ".github", "workflows"), { recursive: true });
  writeFileSync(join(tmpTricky, ".github", "workflows", "cd-selfhosted.yml"), customCdText);

  const apiNoForce = generateCiCdFiles(tmpTricky, { writeGithubCi: true, writeSelfHostedCd: true });
  eq("V9 generateCiCdFiles preserves existing cd-selfhosted.yml by default", readFileSync(join(tmpTricky, ".github", "workflows", "cd-selfhosted.yml"), "utf8"), customCdText);
  ok("V9 generateCiCdFiles reports cd-selfhosted.yml in skipped", apiNoForce.skipped.includes(".github/workflows/cd-selfhosted.yml"));

  const cliNoForce = spawnSync(NODE, [join(REPO, ".orca", "ci-generator.mjs"), "--dir", tmpTricky, "--write", "--self-hosted-cd"], { encoding: "utf8" });
  eq("V9 ci-generator CLI without --force exited 0", cliNoForce.status, 0);
  eq("V9 ci-generator CLI without --force preserved custom cd-selfhosted.yml", readFileSync(join(tmpTricky, ".github", "workflows", "cd-selfhosted.yml"), "utf8"), customCdText);
  ok("V9 ci-generator CLI logged preservation message", /kept existing \.github\/workflows\/cd-selfhosted\.yml \(pass --force to overwrite\)/.test(cliNoForce.stdout));

  const initNoForce = await runInit({ name: "v9-init-preserve", dir: tmpTricky, args: ["--no-interactive", "--self-hosted-cd"] });
  eq("V9 bin/init.mjs --self-hosted-cd without --force preserved custom cd-selfhosted.yml", readFileSync(join(tmpTricky, ".github", "workflows", "cd-selfhosted.yml"), "utf8"), customCdText);
  ok("V9 bin/init.mjs logged preservation message", /kept existing \.github\/workflows\/cd-selfhosted\.yml/.test(initNoForce.out));

  const cliForce = spawnSync(NODE, [join(REPO, ".orca", "ci-generator.mjs"), "--dir", tmpTricky, "--write", "--self-hosted-cd", "--force"], { encoding: "utf8" });
  eq("V9 ci-generator CLI WITH --force exited 0", cliForce.status, 0);
  ok("V9 ci-generator CLI WITH --force overwrote cd-selfhosted.yml", readFileSync(join(tmpTricky, ".github", "workflows", "cd-selfhosted.yml"), "utf8").includes("docker-compose.prod.yml"));

  // 5) P1-12: Gitea PR Risk Summary API call restored & verified end-to-end against mock Gitea + TokenHub server!
  ok("V9 bundled .gitea/workflows/ci-release.yml contains Gitea /issues/${prNum}/comments POST", bundledGiteaCi.includes("/issues/${prNum}/comments") && bundledGiteaCi.includes("token ${giteaToken}"));

  const giteaHits = [];
  const mockForgeSrv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      giteaHits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "1) 变更概述：修复 pytest 退出码；2) 风险：低；3) 建议：人工核对。" } }] }));
        return;
      }
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 901 }));
    });
  });
  await new Promise((r) => mockForgeSrv.listen(0, "127.0.0.1", r));
  const forgePort = mockForgeSrv.address().port;
  try {
    const tmpGiteaRepo = mkdtempSync(join(tmpdir(), "orca-v9-gitea-"));
    dirsOfCurrentScenario.push(tmpGiteaRepo);
    spawnSync("git", ["init", tmpGiteaRepo], { encoding: "utf8" });
    spawnSync("git", ["-C", tmpGiteaRepo, "config", "user.email", "ci@local"], { encoding: "utf8" });
    spawnSync("git", ["-C", tmpGiteaRepo, "config", "user.name", "CI"], { encoding: "utf8" });
    writeFileSync(join(tmpGiteaRepo, "main.py"), "x = 1\n");
    spawnSync("git", ["-C", tmpGiteaRepo, "add", "."], { encoding: "utf8" });
    spawnSync("git", ["-C", tmpGiteaRepo, "commit", "-m", "base"], { encoding: "utf8" });
    const baseSha = spawnSync("git", ["-C", tmpGiteaRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(tmpGiteaRepo, "main.py"), "x = 2\n");
    spawnSync("git", ["-C", tmpGiteaRepo, "add", "."], { encoding: "utf8" });
    spawnSync("git", ["-C", tmpGiteaRepo, "commit", "-m", "head"], { encoding: "utf8" });
    const headSha = spawnSync("git", ["-C", tmpGiteaRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

    const giteaRunScript = extractStepScript(bundledGiteaCi, "Generate Chinese PR Risk Summary via TokenHub API");
    const execGitea = await new Promise((resolveRun) => {
      const child = spawn("bash", ["-c", giteaRunScript], {
        cwd: tmpGiteaRepo,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          TOKENHUB_API_KEY: "th-key-test",
          TOKENHUB_BASE_URL: `http://127.0.0.1:${forgePort}/v1`,
          TOKENHUB_MODEL: "DeepSeek-V4.1-Flash-1017",
          BASE_SHA: baseSha,
          HEAD_SHA: headSha,
          GITEA_API_URL: `http://127.0.0.1:${forgePort}/api/v1`,
          GITEA_TOKEN: "gitea-tok-test",
          GITHUB_REPOSITORY: "shown1985/sxcj",
          PR_NUMBER: "3",
        },
      });
      let stdout = "";
      let stderr = "";
      const killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 15000);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("exit", (status) => {
        clearTimeout(killTimer);
        resolveRun({ status, stdout, stderr });
      });
    });
    eq("V9 Gitea PR comment script exited 0", execGitea.status, 0);
    const commentHit = giteaHits.find((h) => h.url === "/api/v1/repos/shown1985/sxcj/issues/3/comments");
    ok("V9 Gitea PR comment API received POST with token auth & Chinese summary", Boolean(commentHit && commentHit.method === "POST" && commentHit.auth === "token gitea-tok-test" && commentHit.body.body.includes("TokenHub CI 风险摘要")));
    ok("V9 Gitea PR comment logged HTTP 201 without leaking token", execGitea.stdout.includes("posted PR risk summary comment to PR #3 (HTTP 201)") && !execGitea.stdout.includes("gitea-tok-test"));
  } finally {
    mockForgeSrv.close();
  }
});

// ---------------------------------------------------------------------------
// V10 — Round-2 Full Hardening Closure: openStatus=false Default, Strict Fencing,
// Real Python Discovery/SIGPIPE, Proven Cross-Family, CD Provenance/Compose & All P1/P2
// ---------------------------------------------------------------------------
scenario("V10 Round-2 full hardening (openStatus=false, P0-01..P0-04, P1-01..P1-11, P2-01..P2-02)", async () => {
  const { utimesSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { shouldOpenStatusPage } = await import(join(REPO, ".orca", "lib", "status.mjs"));
  const { sanitizeText } = await import(join(REPO, ".orca", "lib", "sanitize.mjs"));
  const { verifyStepArtifact } = await import(join(REPO, ".orca", "gate-verify.mjs"));
  const { materializeAgentConfig, restoreAgentConfig } = await import(join(REPO, ".orca", "agent-config.mjs"));
  const {
    classifyModelFamily,
    filterCrossFamilyCandidates,
    validateCrossFamilyConfig,
    discoverOpencodeLocalEndpoints,
    resolveOpencodeConfig,
  } = await import(join(REPO, ".orca", "preflight.mjs"));
  const { createWatchdogTracker, evaluateWatchdog } = await import(join(REPO, ".orca", "watchdog.mjs"));
  const {
    parseBacklogTasks,
    loadIssueState,
    createIssueViaCli,
    matchTeaLoginForHost,
    detectRepoDefaultBranch,
    formatIssuePrBlock,
  } = await import(join(REPO, ".orca", "issue-tracker.mjs"));
  const {
    detectProjectStacks,
    renderCiWorkflow,
    renderSelfHostedCdWorkflow,
    yamlTokenOrQuoted,
    ghExprString,
  } = await import(join(REPO, ".orca", "ci-generator.mjs"));
  const { listLedgerSummaries } = await import(join(REPO, ".orca", "ledger.mjs"));

  const tmpV10 = mkdtempSync(join(tmpdir(), "orca-v10-"));
  dirsOfCurrentScenario.push(tmpV10);

  // 1) Owner UX: defaults.openStatus defaults to FALSE; --open-status / openStatus:true opt-in; --no-open-status wins
  eq("V10 shouldOpenStatusPage defaults to false", shouldOpenStatusPage({ cfg: {}, opt: {} }), false);
  eq("V10 shouldOpenStatusPage honors cfg.defaults.openStatus=true", shouldOpenStatusPage({ cfg: { defaults: { openStatus: true } }, opt: {} }), true);
  eq("V10 shouldOpenStatusPage honors --open-status CLI opt-in", shouldOpenStatusPage({ cfg: {}, opt: { openStatus: true } }), true);
  eq("V10 --no-open-status overrides openStatus=true and --open-status", shouldOpenStatusPage({ cfg: { defaults: { openStatus: true } }, opt: { openStatus: true, noOpenStatus: true } }), false);

  const openLogDefault = join(tmpV10, "open-default.log");
  const rOpenDefault = await runFlow({
    name: "v10-open-default",
    config: "../test/configs/cold.config.json",
    omitNoOpenStatus: true,
    statusOpenLog: openLogDefault,
    budgetMs: 25000,
  });
  eq("V10 default run without --no-open-status exited 0", rOpenDefault.code, 0);
  ok("V10 default run did NOT auto-open status.html in browser", !existsSync(openLogDefault));
  ok("V10 default run still logged Status page path to stdout", /Status page: .*status\.html/.test(rOpenDefault.out));

  const openLogOptIn = join(tmpV10, "open-optin.log");
  const rOpenOptIn = await runFlow({
    name: "v10-open-optin",
    config: "../test/configs/cold.config.json",
    args: ["--open-status"],
    omitNoOpenStatus: true,
    statusOpenLog: openLogOptIn,
    budgetMs: 25000,
  });
  eq("V10 --open-status run exited 0", rOpenOptIn.code, 0);
  ok("V10 --open-status triggered browser open of status.html", existsSync(openLogOptIn) && readFileSync(openLogOptIn, "utf8").includes("status.html"));

  // 2) P0-01: release_pending blocks fallback; stop_unknown blocks onFailGoto; stale mtime rejected by gate-verify
  const relPendCfg = join(REPO, ".orca", "_tmp-v10-relpend.config.json");
  const stopGotoCfg = join(REPO, ".orca", "_tmp-v10-stopgoto.config.json");
  const unboundCfg = join(REPO, ".orca", "_tmp-v10-unbound.config.json");
  try {
    writeFileSync(relPendCfg, JSON.stringify({
      defaults: { timeoutMs: 3000, hardTimeoutMs: 12000, startRetries: 0, preflight: { enabled: false } },
      pipeline: [{
        id: "coding",
        title: "Coding",
        agent: "opencode2",
        model: "deepseek-v4.1",
        fallback: { agent: "claude", model: "claude-sonnet-4-5" },
        spec: "Write {out}.",
        writes: "OUT.md",
      }],
    }));
    const rRelPend = await runFlow({
      name: "v10-relpend",
      config: "_tmp-v10-relpend.config.json",
      scenario: "v10-release-pending.cjs",
      budgetMs: 25000,
    });
    eq("V10 P0-01 release_pending failed closed (exit 1)", rRelPend.code, 1);
    eq("V10 P0-01 fallback candidate was NEVER started while release_pending", (rRelPend.state?.extra?.starts || []).length, 1);

    writeFileSync(stopGotoCfg, JSON.stringify({
      defaults: {
        timeoutMs: 2000,
        hardTimeoutMs: 12000,
        preflight: { enabled: false },
        watchdog: { enabled: true, fallbackOnGatewayError: true },
      },
      pipeline: [
        { id: "coding", title: "Coding", agent: "opencode2", model: "deepseek-v4.1", spec: "Code {out}.", writes: "CHANGES.md" },
        { id: "code-review", title: "Cross-Family Code Review", agent: "codex", model: "gpt-6.2-sol", crossFamilyWith: ["coding"], reads: ["coding"], onFailGoto: "coding", maxRetries: 2, verify: { requireVerdict: "PASS" }, spec: "Review {out}.", writes: "REVIEW.md" },
      ],
    }));
    const rStopGoto = await runFlow({
      name: "v10-stopgoto",
      config: "_tmp-v10-stopgoto.config.json",
      scenario: "v10-stop-fail-no-goto.cjs",
      budgetMs: 25000,
    });
    eq("V10 P0-01 stop_unknown without fallback exited 1 cleanly", rStopGoto.code, 1);
    eq("V10 P0-01 status.overall is still-running (did NOT settle as failed)", rStopGoto.status?.overall, "still-running");
    eq("V10 P0-01 onFailGoto did NOT reopen/re-run coding", (rStopGoto.state?.extra?.starts || []).filter((s) => s.title === "Coding").length, 1);

    // Gate artifact stale mtime check
    const gateDir = join(tmpV10, "gate-art");
    mkdirSync(gateDir, { recursive: true });
    const gateFile = join(gateDir, "REVIEW.md");
    writeFileSync(gateFile, "# Review\n\n" + "Valid content filler line.\n".repeat(10) + "\nVERDICT: PASS\n");
    const oldSec = Math.floor((Date.now() - 20000) / 1000);
    utimesSync(gateFile, oldSec, oldSec);
    const staleGateRes = verifyStepArtifact(
      { id: "code-review", writes: "REVIEW.md", verify: { requireVerdict: "PASS" } },
      gateDir,
      tmpV10,
      50,
      { mode: "settlement", minMtimeMs: Date.now(), clearedBeforeDispatch: true }
    );
    eq("V10 P0-01 verifyStepArtifact rejects stale pre-dispatch gate artifact", staleGateRes.ok, false);

    // 3) P0-03: OpenCode Claude default model, unknown family fail-closed, validateCrossFamilyConfig, unbound ledger isolation
    const ocClaudeDir = join(tmpV10, "oc-claude");
    mkdirSync(ocClaudeDir, { recursive: true });
    writeFileSync(join(ocClaudeDir, "opencode.json"), JSON.stringify({ model: "anthropic/claude-sonnet-4-5" }));
    eq("V10 P0-03 opencode2 with opencode.json anthropic model -> anthropic", classifyModelFamily("opencode2", null, { projectDir: ocClaudeDir }), "anthropic");
    eq("V10 P0-03 opencode2 without config or model -> unknown (never guesses deepseek)", classifyModelFamily("opencode2", null, { configPaths: [] }), "unknown");
    eq("V10 P0-03 unrecognized explicit model ID -> unknown (never guesses harness)", classifyModelFamily("codex", "mystery-custom-v1"), "unknown");

    const cfUnproven = filterCrossFamilyCandidates(
      [{ agent: "codex", model: "gpt-6.2-sol", family: "openai", isPrimary: true }],
      new Map(),
      { unprovenAuthors: [{ stepId: "coding", reason: "unknown family" }] }
    );
    eq("V10 P0-03 filterCrossFamilyCandidates fails closed on unproven upstream author", cfUnproven.allowed.length, 0);

    const cfUnknownRev = filterCrossFamilyCandidates(
      [{ agent: "agy", model: null, family: "unknown", isPrimary: true }],
      new Map([["deepseek", [{ stepId: "coding", agent: "opencode2", model: "deepseek-v4.1" }]]])
    );
    eq("V10 P0-03 filterCrossFamilyCandidates rejects unknown-family reviewer", cfUnknownRev.allowed.length, 0);

    let crossCfgErr = null;
    try {
      validateCrossFamilyConfig(
        [{ id: "review", crossFamilyWith: ["nonexistent"] }],
        { review: { id: "review" } },
        (m) => { throw new Error(m); }
      );
    } catch (e) { crossCfgErr = e.message; }
    ok("V10 P0-03 validateCrossFamilyConfig rejects unknown crossFamilyWith step", Boolean(crossCfgErr && crossCfgErr.includes("nonexistent")));

    // Unbound ledger isolation on --only: seed an unrelated ledger in ledgerHome without matching status.js ledgerRunKey
    const unboundLedgerHome = join(tmpV10, "unbound-ledger");
    const unboundRepoDummy = join(tmpV10, "other-repo");
    mkdirSync(unboundRepoDummy, { recursive: true });
    const { createRunLedger } = await import(join(REPO, ".orca", "ledger.mjs"));
    const fakePriorLedger = createRunLedger({
      runKey: "unrelated-old-run-key",
      repoDir: unboundRepoDummy,
      ledgerHome: unboundLedgerHome,
      objective: "test objective",
      configFile: "_tmp-v10-unbound.config.json",
    });
    fakePriorLedger.recordIntent({ requestId: "r1", stepId: "coding", title: "Coding", agent: "opencode2", model: "deepseek-v4.1", requestedModel: "deepseek-v4.1", effort: null, requestedEffort: "high", family: "deepseek", attempt: 1 });
    fakePriorLedger.recordDispatchResult({ requestId: "r1", stepId: "coding", dispatchId: "d1", effectiveAgent: "opencode", effectiveModel: "deepseek-v4.1", effectiveEffort: null, executedFamilies: ["deepseek"] });
    fakePriorLedger.recordStepSettled({ stepId: "coding", outcome: "succeeded", verifyOk: true });

    writeFileSync(unboundCfg, JSON.stringify({
      defaults: { timeoutMs: 3000, hardTimeoutMs: 12000, preflight: { enabled: false } },
      pipeline: [
        { id: "coding", title: "Coding", agent: "opencode2", model: "deepseek-v4.1", spec: "Code {out}.", writes: "CHANGES.md" },
        { id: "code-review", title: "Review", agent: "codex", model: "gpt-6.2-sol", crossFamilyWith: ["coding"], reads: ["coding"], verify: { requireVerdict: "PASS" }, spec: "Review {out}.", writes: "REVIEW.md" },
      ],
    }));
    const rUnbound = await runFlow({
      name: "v10-unbound",
      config: "_tmp-v10-unbound.config.json",
      args: ["--only", "code-review", "--ledger-home", unboundLedgerHome],
      seedArtifacts: [{ file: "CHANGES.md", text: "# Changes\n\n" + "Seeded artifact content.\n".repeat(10) }],
      budgetMs: 25000,
    });
    eq("V10 P0-03 --only code-review rejects unbound ledger without run-bound status.js", rUnbound.code, 1);
    ok("V10 P0-03 logged missing verified execution record for coding", /no verified execution record for upstream author step "coding"/.test(rUnbound.out + rUnbound.err));
    const ledSums = listLedgerSummaries({ ledgerHome: unboundLedgerHome });
    const priorCodingRec = ledSums.find((s) => s.runKey === "unrelated-old-run-key")?.steps?.coding;
    eq("V10 P2-01 ledger tracks separate requestedEffort vs effectiveEffort",
      [priorCodingRec?.requestedEffort, priorCodingRec?.effectiveEffort], ["high", null]);
  } finally {
    for (const f of [relPendCfg, stopGotoCfg, unboundCfg]) { try { rmSync(f, { force: true }); } catch {} }
  }

  // 4) P0-02: REAL Python 3 execution — pytest.ini-only, 360-file SIGPIPE, *_test.py without __init__.py, 0-test discovery
  const extractStepScript = (yml, stepName) => {
    const lines = yml.split(/\r?\n/);
    const startIdx = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
    if (startIdx < 0) return null;
    let runIdx = -1;
    for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + 18); i++) {
      if (/^\s+run:\s*\|\s*$/.test(lines[i])) { runIdx = i; break; }
    }
    if (runIdx < 0) return null;
    const baseIndent = lines[runIdx + 1]?.match(/^(\s*)/)?.[1]?.length || 10;
    const body = [];
    for (let i = runIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) { body.push(""); continue; }
      const ind = l.match(/^(\s*)/)[1].length;
      if (ind < baseIndent) break;
      body.push(l.slice(baseIndent));
    }
    return body.join("\n");
  };

  const bundledGhCi = readFileSync(join(REPO, ".github", "workflows", "ci-release.yml"), "utf8");
  const bundledPyScript = extractStepScript(bundledGhCi, "Verify Python projects (root / backend)");
  const realPyCheck = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (!realPyCheck.error && realPyCheck.status === 0) {
    // (a) pytest.ini-only project with failing test (using offline PYTHONPATH pytest module so zero network install)
    const pyIniOnlyDir = join(tmpV10, "py-ini-only");
    const fakePytestPkg = join(tmpV10, "py-pkg");
    const pytestRanMarker = join(tmpV10, "pytest-ran.txt");
    mkdirSync(pyIniOnlyDir, { recursive: true });
    mkdirSync(fakePytestPkg, { recursive: true });
    writeFileSync(join(pyIniOnlyDir, "pytest.ini"), "[pytest]\ntestpaths = .\n");
    writeFileSync(join(pyIniOnlyDir, "test_ini_fail.py"), "def test_must_fail():\n    assert 2 + 2 == 5\n");
    writeFileSync(join(fakePytestPkg, "pytest.py"), [
      "import glob, importlib.util, os, sys",
      "if __name__ == '__main__':",
      `    open(${JSON.stringify(pytestRanMarker)}, 'w').write('ran')`,
      "    failed = 0",
      "    for p in sorted(glob.glob('**/test_*.py', recursive=True)):",
      "        spec = importlib.util.spec_from_file_location('m', p)",
      "        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
      "        for k, fn in vars(mod).items():",
      "            if k.startswith('test_') and callable(fn):",
      "                try: fn()",
      "                except Exception: failed += 1",
      "    sys.exit(1 if failed else 0)",
    ].join("\n"));
    const rIniOnly = spawnSync("bash", ["-c", bundledPyScript], {
      cwd: pyIniOnlyDir,
      env: { ...process.env, PYTHONPATH: fakePytestPkg },
      encoding: "utf8",
    });
    eq("V10 P0-02 REAL PYTHON: pytest.ini-only failing suite exits exact code 1", rIniOnly.status, 1);
    ok("V10 P0-02 REAL PYTHON: pytest.ini-only project actually executed pytest", existsSync(pytestRanMarker));

    // Clean PYTHONPATH without pytest so real stdlib unittest path runs
    const noPytestHelper = join(tmpV10, "block-pytest");
    mkdirSync(noPytestHelper, { recursive: true });
    writeFileSync(join(noPytestHelper, "pytest.py"), "raise ImportError('pytest intentionally absent')\n");

    // (b) 360 test files in cases/ without __init__.py (SIGPIPE + unittest discovery regression test!)
    const sigpipeDir = join(tmpV10, "py-sigpipe");
    mkdirSync(join(sigpipeDir, "cases"), { recursive: true });
    for (let i = 0; i < 359; i++) {
      const pad = String(i).padStart(3, "0");
      writeFileSync(join(sigpipeDir, "cases", `test_bulk_long_filename_padding_${pad}.py`), `import unittest\nclass T${pad}(unittest.TestCase):\n    def test_ok(self): self.assertEqual(1, 1)\n`);
    }
    writeFileSync(join(sigpipeDir, "cases", "test_bulk_long_filename_padding_359.py"), "import unittest\nclass T359(unittest.TestCase):\n    def test_boom(self): self.assertEqual(1, 2)\n");
    const rSigpipe = spawnSync("bash", ["-c", bundledPyScript], {
      cwd: sigpipeDir,
      env: { ...process.env, PYTHONPATH: noPytestHelper },
      encoding: "utf8",
    });
    eq("V10 P0-02 REAL PYTHON: 360 test files in cases/ (no __init__.py) has ZERO SIGPIPE and exits exact 1", rSigpipe.status, 1);

    // (c) *_test.py naming in cases/ without __init__.py
    const suffixTestDir = join(tmpV10, "py-suffix");
    mkdirSync(join(suffixTestDir, "cases"), { recursive: true });
    writeFileSync(join(suffixTestDir, "cases", "math_test.py"), "import unittest\nclass MathTest(unittest.TestCase):\n    def test_sub(self): self.assertEqual(10 - 3, 99)\n");
    const rSuffix = spawnSync("bash", ["-c", bundledPyScript], {
      cwd: suffixTestDir,
      env: { ...process.env, PYTHONPATH: noPytestHelper },
      encoding: "utf8",
    });
    eq("V10 P0-02 REAL PYTHON: cases/math_test.py (*_test.py without __init__.py) exits exact 1", rSuffix.status, 1);

    // (d) Matched *_test.py with 0 unittest TestCases fails closed (exits 1, never 0!)
    const zeroCaseDir = join(tmpV10, "py-zerocase");
    mkdirSync(join(zeroCaseDir, "cases"), { recursive: true });
    writeFileSync(join(zeroCaseDir, "cases", "orphan_test.py"), "def test_plain_func_without_pytest():\n    assert False\n");
    const rZeroCase = spawnSync("bash", ["-c", bundledPyScript], {
      cwd: zeroCaseDir,
      env: { ...process.env, PYTHONPATH: noPytestHelper },
      encoding: "utf8",
    });
    eq("V10 P0-02 REAL PYTHON: 0-discovered-cases test file fails closed with exit 1", rZeroCase.status, 1);
  }

  // 5) P0-04 + P1-09 + P1-10 + P1-11: CD Provenance Gate, SHA Gate, Compose Health & YAML/Expression Escaping
  eq("V10 P1-10 numeric branch '123' is quoted as YAML string", yamlTokenOrQuoted("123"), '"123"');
  eq("V10 P1-10 single-quote branch Actions expression escaping", ghExprString("feat/a'b"), "'feat/a''b'");
  const refFmt = spawnSync("git", ["check-ref-format", "--branch", "feat/a'b"], { encoding: "utf8" });
  eq("V10 git confirms feat/a'b is a legal branch name", refFmt.status, 0);

  const cdComposeDir = join(tmpV10, "cd-proj");
  mkdirSync(cdComposeDir, { recursive: true });
  writeFileSync(join(cdComposeDir, "docker-compose.prod.yml"), "services:\n  db-migrate:\n    image: alpine\n  api:\n    image: alpine\n");
  const detCd = detectProjectStacks(cdComposeDir);
  const cdYmlNumeric = renderCiWorkflow(detCd, { branches: ["123", "feat/a'b"] });
  const cdYml = renderSelfHostedCdWorkflow(detCd, {
    deployBranch: "main",
    serviceName: "api",
    healthUrl: "http://admin:secretpass@127.0.0.1:8000/health?token=secret_tok_999",
  });
  const cdYmlSingleQuote = renderSelfHostedCdWorkflow(detCd, { deployBranch: "feat/a'b" });
  ok("V10 P0-04 CD job-level if requires event == 'push', same repo, and refs/heads/<branch>",
    cdYml.includes("github.event.workflow_run.event == 'push'") &&
    cdYml.includes("github.event.workflow_run.head_repository.full_name == github.repository") &&
    cdYml.includes("github.ref == 'refs/heads/main'"));
  ok("V10 P1-10 single-quote branch CD renders valid Actions literal 'feat/a''b'", cdYmlSingleQuote.includes("'feat/a''b'") && cdYmlSingleQuote.includes("'refs/heads/feat/a''b'"));

  const rubyCheck = spawnSync("ruby", ["-ryaml", "-e", "puts 'ok'"], { encoding: "utf8" });
  if (!rubyCheck.error && rubyCheck.status === 0) {
    const numYmlPath = join(tmpV10, "numeric-branch.yml");
    writeFileSync(numYmlPath, cdYmlNumeric);
    const numParsed = spawnSync("ruby", ["-ryaml", "-e", `d = YAML.load_file(${JSON.stringify(numYmlPath)}); on_cfg = d['on'] || d[true]; b = on_cfg['push']['branches']; raise 'not string' unless b[0].is_a?(String) && b[0] == '123' && b[1] == "feat/a'b"`], { encoding: "utf8" });
    eq("V10 P1-10 Psych confirms branch '123' parsed as String (not Integer) and feat/a'b preserved", numParsed.status, 0);
  }

  // Set up temporary git repo with SHA1 (superseded) & SHA2 (live origin/main tip)
  const cdGitDir = join(tmpV10, "cd-git");
  spawnSync("git", ["init", "-b", "main", cdGitDir], { encoding: "utf8" });
  spawnSync("git", ["-C", cdGitDir, "config", "user.email", "ci@local"], { encoding: "utf8" });
  spawnSync("git", ["-C", cdGitDir, "config", "user.name", "CI"], { encoding: "utf8" });
  writeFileSync(join(cdGitDir, "f.txt"), "v1\n");
  spawnSync("git", ["-C", cdGitDir, "add", "."], { encoding: "utf8" });
  spawnSync("git", ["-C", cdGitDir, "commit", "-m", "c1"], { encoding: "utf8" });
  const sha1 = spawnSync("git", ["-C", cdGitDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(cdGitDir, "f.txt"), "v2\n");
  spawnSync("git", ["-C", cdGitDir, "add", "."], { encoding: "utf8" });
  spawnSync("git", ["-C", cdGitDir, "commit", "-m", "c2"], { encoding: "utf8" });
  const sha2 = spawnSync("git", ["-C", cdGitDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["-C", cdGitDir, "update-ref", "refs/remotes/origin/main", sha2], { encoding: "utf8" });

  // Execute extracted CD Pre-Gate Job Step (Provenance + SHA + live origin/main tip BEFORE self-hosted runner!)
  const cdGateScript = extractStepScript(cdYml, "Verify CI gate & allowed target branch");
  const validSha = sha2;
  const baseGateEnv = {
    ...process.env,
    DEPLOY_BRANCH: "main",
    EXPECTED_FULL_REF: "refs/heads/main",
    THIS_REPO: "shown1985/sxcj",
  };
  eq("V10 P0-04 CD gate REJECTS pull_request workflow_run", spawnSync("bash", ["-c", cdGateScript], {
    cwd: cdGitDir,
    env: { ...baseGateEnv, EVENT_NAME: "workflow_run", CI_CONCLUSION: "success", WR_EVENT: "pull_request", WR_HEAD_REPO: "shown1985/sxcj", WR_HEAD_BRANCH: "main", WR_HEAD_SHA: validSha },
    encoding: "utf8",
  }).status, 1);
  eq("V10 P0-04 CD gate REJECTS fork repository workflow_run", spawnSync("bash", ["-c", cdGateScript], {
    cwd: cdGitDir,
    env: { ...baseGateEnv, EVENT_NAME: "workflow_run", CI_CONCLUSION: "success", WR_EVENT: "push", WR_HEAD_REPO: "attacker/sxcj", WR_HEAD_BRANCH: "main", WR_HEAD_SHA: validSha },
    encoding: "utf8",
  }).status, 1);
  eq("V10 P0-04 CD gate REJECTS tag refs/tags/main on workflow_dispatch", spawnSync("bash", ["-c", cdGateScript], {
    cwd: cdGitDir,
    env: { ...baseGateEnv, EVENT_NAME: "workflow_dispatch", ACTUAL_REF: "refs/tags/main", ACTUAL_REF_TYPE: "tag", DISPATCH_SHA: validSha },
    encoding: "utf8",
  }).status, 1);
  eq("V10 P0-04 CD pre-gate REJECTS superseded SHA1 before self-hosted runner", spawnSync("bash", ["-c", cdGateScript], {
    cwd: cdGitDir,
    env: { ...baseGateEnv, EVENT_NAME: "workflow_run", CI_CONCLUSION: "success", WR_EVENT: "push", WR_HEAD_REPO: "shown1985/sxcj", WR_HEAD_BRANCH: "main", WR_HEAD_SHA: sha1 },
    encoding: "utf8",
  }).status, 1);
  eq("V10 P0-04 CD gate ACCEPTS verified push workflow_run on main", spawnSync("bash", ["-c", cdGateScript], {
    cwd: cdGitDir,
    env: { ...baseGateEnv, EVENT_NAME: "workflow_run", CI_CONCLUSION: "success", WR_EVENT: "push", WR_HEAD_REPO: "shown1985/sxcj", WR_HEAD_BRANCH: "main", WR_HEAD_SHA: validSha },
    encoding: "utf8",
  }).status, 0);

  // Execute extracted CD Step 3 (Checked-out commit == live origin/main tip on self-hosted runner)
  const cdShaScript = extractStepScript(cdYml, "Verify checked-out commit matches live target branch tip");
  spawnSync("git", ["-C", cdGitDir, "checkout", "--detach", sha1], { encoding: "utf8" });
  eq("V10 P0-04 CD SHA gate REJECTS stale/superseded SHA1 when origin/main is at SHA2", spawnSync("bash", ["-c", cdShaScript], {
    cwd: cdGitDir,
    env: { ...process.env, DEPLOY_BRANCH: "main", EXPECTED_SHA: sha1 },
    encoding: "utf8",
  }).status, 1);
  spawnSync("git", ["-C", cdGitDir, "checkout", "--detach", sha2], { encoding: "utf8" });
  eq("V10 P0-04 CD SHA gate ACCEPTS current verified origin/main tip SHA2", spawnSync("bash", ["-c", cdShaScript], {
    cwd: cdGitDir,
    env: { ...process.env, DEPLOY_BRANCH: "main", EXPECTED_SHA: sha2 },
    encoding: "utf8",
  }).status, 0);

  // Execute extracted CD Health Check step against mock docker + curl
  const cdHealthScript = extractStepScript(cdYml, "Post-deploy automated health check (PII-safe)");
  const mockCdBin = join(tmpV10, "cd-bin");
  mkdirSync(mockCdBin, { recursive: true });
  writeFileSync(join(mockCdBin, "docker"), `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a.includes("config") && a.includes("--services")) {
  if (process.env.MOCK_CFG_EXIT) process.exit(Number(process.env.MOCK_CFG_EXIT));
  if (process.env.MOCK_CFG_SVCS) console.log(process.env.MOCK_CFG_SVCS);
  process.exit(0);
}
if (a.includes("ps") && a.includes("--format")) {
  if (process.env.MOCK_PS_EXIT) process.exit(Number(process.env.MOCK_PS_EXIT));
  process.stdout.write(process.env.MOCK_PS_JSON || "");
  process.exit(0);
}
if (a.includes("inspect")) {
  process.stdout.write(process.env.MOCK_INSPECT_OUT || "[]");
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  writeFileSync(join(mockCdBin, "curl"), `#!/usr/bin/env node\nconsole.log("HTTP/1.1 200 OK\\r\\n\\r\\nok");\nprocess.exit(0);\n`, { mode: 0o755 });

  const runCdHealth = (extraEnv) => spawnSync("bash", ["-c", cdHealthScript], {
    cwd: cdComposeDir,
    env: {
      ...process.env,
      PATH: `${mockCdBin}:${process.env.PATH}`,
      COMPOSE_FILE: "docker-compose.prod.yml",
      SERVICE_NAME: "api",
      ORCA_DEPLOY_SHA: sha2,
      MOCK_CFG_SVCS: "db-migrate\napi\n",
      DEFAULT_HEALTHCHECK_URL: "http://admin:secretpass@127.0.0.1:8000/health?token=secret_tok_999",
      HEALTHCHECK_URL: "",
      DEPLOY_ONESHOT_SERVICES: "",
      HEALTHCHECK_RETRIES: "1",
      HEALTHCHECK_INTERVAL: "0",
      ...extraEnv,
    },
    encoding: "utf8",
  });

  const hMigrationOk = runCdHealth({
    MOCK_PS_JSON: JSON.stringify([
      { Service: "db-migrate", State: "exited", ExitCode: 0, Labels: `io.orca-pod.deploy-sha=${sha2}` },
      { Service: "api", State: "running", Health: "healthy", ExitCode: 0, Labels: `io.orca-pod.deploy-sha=${sha2}` },
    ]),
  });
  eq("V10 P1-11 CD health ACCEPTS exited(0) db-migrate + running healthy api", hMigrationOk.status, 0);
  ok("V10 P1-09 CD health NEVER echoes secret health URL/credentials to logs",
    !hMigrationOk.stdout.includes("secretpass") &&
    !hMigrationOk.stdout.includes("secret_tok_999") &&
    !hMigrationOk.stderr.includes("secret_tok_999"));

  eq("V10 P1-11 CD health REJECTS empty JSON array []", runCdHealth({ MOCK_PS_JSON: "[]" }).status, 1);
  eq("V10 P1-11 CD health REJECTS failed migration ExitCode=1", runCdHealth({
    MOCK_PS_JSON: JSON.stringify([
      { Service: "db-migrate", State: "exited", ExitCode: 1 },
      { Service: "api", State: "running", Health: "healthy", ExitCode: 0 },
    ]),
  }).status, 1);
  eq("V10 P1-11 CD health REJECTS when required target service 'api' is not running", runCdHealth({
    MOCK_PS_JSON: JSON.stringify([{ Service: "redis", State: "running", Health: "healthy", ExitCode: 0 }]),
  }).status, 1);
  eq("V10 P1-11 CD health propagates docker compose ps exit code 23", runCdHealth({ MOCK_PS_EXIT: "23" }).status, 23);

  // 6) P1-01, P1-02, P1-03, P1-04, P1-05, P1-06, P1-07, P1-08, P1-09 unit checks
  // P1-01: user_approval + fresh ECONNREFUSED blocks (never fallbacks!), and pre-progress loop lines ignored
  const wdTracker = createWatchdogTracker({
    step: { watchdog: { loopThreshold: 4, fallbackOnGatewayError: true, fallbackOnLoop: true } },
    startedAt: 1000,
    probeFn: () => ({ gitFingerprint: "g1", gitOk: true, ownArtifactFingerprint: "a1", dirArtifactFingerprint: "d1", artifactFingerprint: "a1", artifactSize: 0 }),
  });
  const apprPlusGw = evaluateWatchdog(wdTracker, {
    now: 2000,
    preview: "Error: connect ECONNREFUSED 127.0.0.1:3425",
    previewChanged: true,
    previewSeenBefore: false,
    agentWait: { kind: "user_approval", reason: "Approve deploy?" },
    fallbackAvailable: true,
  });
  eq("V10 P1-01 user_approval + ECONNREFUSED prioritizes human approval (action=block, NOT fallback)", apprPlusGw.action, "block");

  const loopTracker = createWatchdogTracker({
    step: { watchdog: { loopThreshold: 4, fallbackOnLoop: true } },
    startedAt: 1000,
    probeFn: () => ({ gitFingerprint: "g1", gitOk: true, ownArtifactFingerprint: "a1", dirArtifactFingerprint: "d1", artifactFingerprint: "a1", artifactSize: 0 }),
  });
  const oldLoopLines = Array.from({ length: 4 }, () => "Retrying tool call with identical payload...").join("\n");
  // Poll 1: 4 repeated lines BUT accompanied by real git progress (g1 -> g2)
  const poll1 = evaluateWatchdog(loopTracker, {
    now: 2000,
    preview: oldLoopLines,
    previewChanged: true,
    previewSeenBefore: false,
    fallbackAvailable: true,
    probeOverride: { gitFingerprint: "g2", gitOk: true, ownArtifactFingerprint: "a1", dirArtifactFingerprint: "d1", artifactFingerprint: "a1", artifactSize: 0 },
  });
  eq("V10 P1-01 git progress resets post-progress loop buffer", poll1.status, "healthy");
  // Poll 2: old 4 loop lines remain in scrollback tail, only 1 new recovery line appended
  const poll2 = evaluateWatchdog(loopTracker, {
    now: 3000,
    preview: `${oldLoopLines}\nCompleted test run successfully.`,
    previewChanged: true,
    previewSeenBefore: true,
    fallbackAvailable: true,
    probeOverride: { gitFingerprint: "g2", gitOk: true, ownArtifactFingerprint: "a1", dirArtifactFingerprint: "d1", artifactFingerprint: "a1", artifactSize: 0 },
  });
  eq("V10 P1-01 historic loop lines before git progress do NOT trigger false output_loop", poll2.status, "healthy");

  // P1-02: sharedWorktree true -> false transition does NOT count untouched sibling artifacts as new progress
  const modeTracker = createWatchdogTracker({
    step: { watchdog: { stallTimeoutMs: 5000 } },
    startedAt: 1000,
    sharedWorktree: true,
    probeFn: () => ({ gitFingerprint: "g1", gitOk: true, ownArtifactFingerprint: "own-1", dirArtifactFingerprint: "dir-with-sibling-1", artifactFingerprint: "own-1", artifactSize: 10 }),
  });
  const modeSwitchRes = evaluateWatchdog(modeTracker, {
    now: 2000,
    preview: "idle",
    previewChanged: false,
    previewSeenBefore: true,
    sharedWorktree: false,
    probeOverride: { gitFingerprint: "g1", gitOk: true, ownArtifactFingerprint: "own-1", dirArtifactFingerprint: "dir-with-sibling-1", artifactFingerprint: "dir-with-sibling-1", artifactSize: 10 },
  });
  eq("V10 P1-02 sharedWorktree true->false transition does NOT synthesize false artifactChanged", modeSwitchRes.artifactChanged, false);

  // P1-03: OpenCode config precedence (.opencode/opencode.json > root opencode.json; child > parent; enabled_providers)
  const ocRoot = join(tmpV10, "oc-prec");
  const ocChild = join(ocRoot, "packages", "web");
  mkdirSync(join(ocRoot, ".opencode"), { recursive: true });
  mkdirSync(ocChild, { recursive: true });
  spawnSync("git", ["init", ocRoot], { encoding: "utf8" });
  writeFileSync(join(ocRoot, "opencode.json"), JSON.stringify({
    model: "openai/gpt-5",
    enabled_providers: ["magpie"],
    provider: {
      magpie: { options: { baseURL: "http://127.0.0.1:3425/v1" } },
      blocked_local: { options: { baseURL: "http://127.0.0.1:9999/v1" } },
    },
  }));
  writeFileSync(join(ocRoot, ".opencode", "opencode.json"), JSON.stringify({
    model: "anthropic/claude-sonnet-4-5",
  }));
  eq("V10 P1-03 .opencode/opencode.json overrides root opencode.json in same dir", resolveOpencodeConfig({ projectDir: ocRoot }).model, "anthropic/claude-sonnet-4-5");
  writeFileSync(join(ocChild, "opencode.json"), JSON.stringify({ model: "deepseek/deepseek-v4.1" }));
  eq("V10 P1-03 parent .opencode/opencode.json overrides child plain opencode.json (OpenCode merge order)", resolveOpencodeConfig({ projectDir: ocChild }).model, "anthropic/claude-sonnet-4-5");
  mkdirSync(join(ocChild, ".opencode"), { recursive: true });
  writeFileSync(join(ocChild, ".opencode", "opencode.json"), JSON.stringify({ model: "kimi/kimi-k3.1" }));
  eq("V10 P1-03 child .opencode/opencode.json overrides parent .opencode/opencode.json", resolveOpencodeConfig({ projectDir: ocChild }).model, "kimi/kimi-k3.1");
  const blockedEps = discoverOpencodeLocalEndpoints({ projectDir: ocRoot, model: "blocked_local/some-model" });
  eq("V10 P1-03 enabled_providers blocks non-listed explicit provider", blockedEps.length, 0);

  // P1-04: Parallel agy + antigravity MCP servers merge cleanly into .agents/mcp_config.json
  const mcpMergeDir = join(tmpV10, "mcp-merge");
  mkdirSync(mcpMergeDir, { recursive: true });
  materializeAgentConfig({
    worktree: mcpMergeDir,
    members: [
      { id: "s1", agent: "agy", mcp: ["srvA"], skills: [] },
      { id: "s2", agent: "antigravity", mcp: ["srvB"], skills: [] },
    ],
    cfg: {
      mcpServers: {
        srvA: { command: "node", args: ["a.js"] },
        srvB: { command: "node", args: ["b.js"] },
      },
    },
    configDir: join(REPO, ".orca"),
    die: (m) => { throw new Error(m); },
    warn: () => {},
  });
  const mergedAgyMcp = JSON.parse(readFileSync(join(mcpMergeDir, ".agents", "mcp_config.json"), "utf8"));
  eq("V10 P1-04 agy + antigravity merged BOTH srvA and srvB into .agents/mcp_config.json",
    Object.keys(mergedAgyMcp.mcpServers || {}).sort(), ["srvA", "srvB"]);
  restoreAgentConfig({ worktree: mcpMergeDir, warn: () => {} });

  // P1-05, P1-06, P1-07, P1-08, P1-09
  const legacyIssDir = join(tmpV10, "legacy-iss");
  mkdirSync(legacyIssDir, { recursive: true });
  writeFileSync(join(legacyIssDir, "ISSUES.json"), JSON.stringify({ epic: { number: 12 }, tasks: [{ id: "T1", title: "Old", number: 13 }] }));
  eq("V10 P1-05 loadIssueState with matchScope rejects unscoped legacy ISSUES.json",
    loadIssueState(legacyIssDir, { provider: "gh", host: "github.com", repo: "org/repo", objective: "New" }), null);

  const collisionTasks = parseBacklogTasks("- [ ] Unnumbered first task\n### T1: Explicit task one\n");
  eq("V10 P1-06 auto ID avoids colliding with later explicit T1 (both tasks preserved)",
    collisionTasks.map((t) => t.id), ["T2", "T1"]);

  let partialCalls = 0;
  const partialCreate = createIssueViaCli({
    provider: "gh",
    bin: "gh",
    repoDir: tmpV10,
    repo: "shown1985/sxcj",
    title: "Partial label failure",
    body: "Body",
    labels: ["orca-pod"],
    execFn: () => {
      partialCalls++;
      return {
        ok: false,
        status: 1,
        stdout: "https://github.com/shown1985/sxcj/issues/77",
        stderr: "could not add label: dial tcp 140.82.112.6:443: connection reset by peer",
        timedOut: false,
      };
    },
  });
  eq("V10 P1-07 reconciles already-created issue URL #77 without duplicate retry", [partialCreate.ok, partialCreate.number, partialCalls], [true, 77, 1]);

  let netErrCalls = 0;
  const netErrCreate = createIssueViaCli({
    provider: "gh",
    bin: "gh",
    repoDir: tmpV10,
    repo: "shown1985/sxcj",
    title: "Net error",
    body: "Body",
    labels: ["orca-pod"],
    execFn: () => {
      netErrCalls++;
      return { ok: false, status: 1, stdout: "", stderr: "Post https://api.github.com/graphql: dial tcp: connection refused", timedOut: false };
    },
  });
  eq("V10 P1-07 generic transport error NEVER triggers label-less retry", [netErrCreate.ok, netErrCalls], [false, 1]);

  const teaTable = [
    "| NAME    | URL                         | SSH HOST | USER |",
    "| evil    | https://evil-gitea.local    |          | bob  |",
    "| corpgit | https://gitea.local:3000    |          | dev  |",
  ].join("\n");
  eq("V10 P1-07 matchTeaLoginForHost matches exact hostname (rejects evil-gitea.local)", matchTeaLoginForHost(teaTable, "gitea.local")?.login, "corpgit");
  eq("V10 P1-07 matchTeaLoginForHost returns null when only substring host exists", matchTeaLoginForHost("| evil | https://evil-gitea.local | | bob |", "gitea.local"), null);

  let teaArgsCaptured = null;
  createIssueViaCli({
    provider: "tea",
    bin: "tea",
    repoDir: tmpV10,
    repo: "org/proj",
    host: "gitea.local",
    teaLogin: "corpgit",
    title: "Tea issue",
    body: "Body",
    execFn: (_b, args) => {
      teaArgsCaptured = args;
      return { ok: true, status: 0, stdout: "https://gitea.local/org/proj/issues/9", stderr: "" };
    },
  });
  ok("V10 P1-07 tea issues create passes explicit --login corpgit",
    Array.isArray(teaArgsCaptured) && teaArgsCaptured.includes("--login") && teaArgsCaptured[teaArgsCaptured.indexOf("--login") + 1] === "corpgit");

  eq("V10 P1-08 detectRepoDefaultBranch returns null when origin/HEAD absent (never guesses main)",
    detectRepoDefaultBranch(tmpV10, () => ({ ok: false, stdout: "", stderr: "" })), null);
  eq("V10 P1-08 detectRepoDefaultBranch resolves via gh repo view when origin/HEAD absent",
    detectRepoDefaultBranch(tmpV10, (_b, args) => {
      if (args[0] === "repo" && args[1] === "view") return { ok: true, stdout: JSON.stringify({ defaultBranchRef: { name: "trunk" } }), stderr: "" };
      return { ok: false, stdout: "", stderr: "" };
    }, { provider: "gh", bin: "gh", host: "ghe.corp.internal", repo: "org/repo" }), "trunk");

  const ghePrBlock = formatIssuePrBlock(
    { provider: "gh", host: "ghe.corp.internal", repo: "org/repo", epic: { number: 5 }, tasks: [{ number: 6 }] },
    { closeOnPr: true, targetBranch: "dev", defaultBranch: "trunk" }
  );
  ok("V10 P1-08 GHE close command uses host-qualified --repo ghe.corp.internal/org/repo",
    ghePrBlock.block.includes('--repo "ghe.corp.internal/org/repo"'));

  const jsonSecretSample = '{"access_token":"tok_live_supersecret_987654","apiKey":"sk_custom_secret_value","nested":{"client_secret":"cs_999888777"}} and eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const redactedJsonSecret = sanitizeText(jsonSecretSample);
  ok("V10 P1-09 sanitizeText redacts JSON access_token, apiKey, client_secret & JWT",
    !redactedJsonSecret.includes("tok_live_supersecret_987654") &&
    !redactedJsonSecret.includes("sk_custom_secret_value") &&
    !redactedJsonSecret.includes("cs_999888777") &&
    !redactedJsonSecret.includes("dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"));
});

// ---------------------------------------------------------------------------
// V11 — Round-3 Surgical Closure:
// Exact end-to-end & direct-call verification of ALL 14 remaining Round-2 items
// (4 P0 + 8 P1 + 2 P2) so zero edge cases remain unverified.
// ---------------------------------------------------------------------------
scenario("V11 Round-3 surgical closure: dispatch attribution, 4x Python CI, ledger-bound resume/argv, hosted CD pre-gate, Compose rev, Issue links & escaped-quote redaction", async () => {
  const { spawnSync } = await import("node:child_process");
  const { statSync } = await import("node:fs");
  const { sanitizeText } = await import(join(REPO, ".orca", "lib", "sanitize.mjs"));
  const { verifyStopAndReleaseReceipt, createOrcaClient, sleepMs } = await import(join(REPO, ".orca", "lib", "orca-cli.mjs"));
  const { createNudgeController } = await import(join(REPO, ".orca", "lib", "nudge.mjs"));
  const { verifyStepArtifact } = await import(join(REPO, ".orca", "gate-verify.mjs"));
  const {
    bindStepArtifactDispatchClaim,
    clearStaleStepArtifact,
    syncOutputsFromIsolatedWorktree,
  } = await import(join(REPO, ".orca", "worktree-isolation.mjs"));
  const {
    classifyModelFamily,
    normalizeCandidate,
    resolveOpencodeConfig,
  } = await import(join(REPO, ".orca", "preflight.mjs"));
  const { materializeAgentConfig, restoreAgentConfig } = await import(join(REPO, ".orca", "agent-config.mjs"));
  const {
    parseBacklogTasks,
    extractExplicitLocalIssueNumber,
    isMissingLabelError,
    createIssueViaCli,
  } = await import(join(REPO, ".orca", "issue-tracker.mjs"));
  const {
    detectProjectStacks,
    renderCiWorkflow,
    renderSelfHostedCdWorkflow,
  } = await import(join(REPO, ".orca", "ci-generator.mjs"));

  const tmpV11 = mkdtempSync(join(tmpdir(), "orca-v11-"));
  dirsOfCurrentScenario.push(tmpV11);

  const extractStepScript = (yml, stepName) => {
    const lines = yml.split(/\r?\n/);
    const startIdx = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
    if (startIdx < 0) return null;
    let runIdx = -1;
    for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + 20); i++) {
      if (/^\s+run:\s*\|\s*$/.test(lines[i])) { runIdx = i; break; }
    }
    if (runIdx < 0) return null;
    const baseIndent = lines[runIdx + 1]?.match(/^(\s*)/)?.[1]?.length || 10;
    const body = [];
    for (let i = runIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) { body.push(""); continue; }
      const ind = l.match(/^(\s*)/)[1].length;
      if (ind < baseIndent) break;
      body.push(l.slice(baseIndent));
    }
    return body.join("\n");
  };

  // =========================================================================
  // 1) P0-01 + P1-02 + P2-01: Dispatch attribution, stop/release receipts,
  //    unattributed start reconciliation, sub-second gate claim & budgets
  // =========================================================================
  // 1a) verifyStopAndReleaseReceipt rejects state="fenced" AND rejects empty release status ""
  const rFenced = verifyStopAndReleaseReceipt((args) => {
    if (args[1] === "worker-stop") return { ok: true, json: { result: { dispatchId: "d1", state: "fenced", processAction: "closed_agent_terminal" } } };
    return { ok: true, json: { result: { dispatchId: "d1", status: "released" } } };
  }, "d1");
  eq("V11 P0-01 verifyStopAndReleaseReceipt rejects state=fenced without terminal stop state",
    [rFenced.ok, /worker-stop/.test(rFenced.reason || "")], [false, true]);

  const rEmptyRel = verifyStopAndReleaseReceipt((args) => {
    if (args[1] === "worker-stop") return { ok: true, json: { result: { dispatchId: "d1", state: "stopped" } } };
    return { ok: true, json: { result: { dispatchId: "d1", status: "" } } };
  }, "d1");
  eq("V11 P0-01 verifyStopAndReleaseReceipt rejects empty release status",
    [rEmptyRel.ok, /worker-release/.test(rEmptyRel.reason || "")], [false, true]);

  const rValidStopRel = verifyStopAndReleaseReceipt((args) => {
    if (args[1] === "worker-stop") return { ok: true, json: { result: { dispatchId: "d1", state: "stopped" } } };
    return { ok: true, json: { result: { dispatchId: "d1", status: "released" } } };
  }, "d1");
  eq("V11 P0-01 verifyStopAndReleaseReceipt accepts confirmed stopped + released",
    [rValidStopRel.ok, rValidStopRel.reason], [true, null]);

  // 1b) workerVitals with stale dispatch-show + unattributed worker-show("completed") + unattributed task-list("succeeded")
  //     AND unattributed worker-start failure reconciliation + manual->cold attempts merging
  const mockOrcaScript = join(tmpV11, "mock-orca-v11.cjs");
  const mockOrcaLog = join(tmpV11, "mock-orca-v11.jsonl");
  writeFileSync(mockOrcaScript, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const mode = process.env.MOCK_V11_MODE || "";
fs.appendFileSync(${JSON.stringify(mockOrcaLog)}, JSON.stringify({ mode, args }) + "\\n");
const out = (code, obj) => { console.log(JSON.stringify(obj)); process.exit(code); };
const key = args.slice(0, 2).join(" ");
if (mode === "vitals_mismatch") {
  if (key === "orchestration dispatch-show") return out(0, { result: { dispatch: { id: "disp-old", status: "completed" } } });
  if (key === "orchestration worker-show") return out(0, { result: { status: "completed", outcome: "succeeded" } });
  if (key === "orchestration task-list") return out(0, { result: { tasks: [{ id: "task-1", status: "completed", result: { outcome: "succeeded" } }] } });
}
if (mode === "unattributed_start_fail") {
  if (key === "terminal create") return out(1, { error: "terminal disabled" });
  if (key === "orchestration worker-start") return out(1, { error: "internal daemon error without failedStage" });
  if (key === "orchestration dispatch-show") return out(0, { result: { dispatch: { id: null, status: "unknown" } } });
}
if (mode === "manual_then_cold") {
  if (key === "terminal create") return out(1, { error: "warm terminal unavailable" });
  if (key === "orchestration worker-start") return out(0, { result: { dispatchId: "disp-cold-1", state: "ready" } });
}
out(0, { result: {} });
`, { mode: 0o755 });

  const prevOrcaCmd = process.env.ORCA_CLI_COMMAND;
  const prevV11Mode = process.env.MOCK_V11_MODE;
  try {
    process.env.ORCA_CLI_COMMAND = mockOrcaScript;
    const client = createOrcaClient({
      cfg: { defaults: { startRetries: 2, warmTerminal: true }, warmCommands: { agy: "agy --model claude-sonnet-4-5 --effort high" } },
      opt: {},
      objective: "v11",
      autoRun: true,
      agentOf: (s) => s.agent,
      modelOf: (s) => s.model,
      writeStatus: () => {},
      log: () => {},
      warn: () => {},
      die: (m) => { throw new Error(m); },
    });

    process.env.MOCK_V11_MODE = "vitals_mismatch";
    const vit = client.workerVitals("task-1", "run-1", "disp-current");
    eq("V11 P0-01 workerVitals NEVER settles on unattributed worker-show/task-list when dispatch mismatches",
      [vit.dispatchMismatch, vit.settled, vit.outcome], [true, false, null]);

    process.env.MOCK_V11_MODE = "unattributed_start_fail";
    rmSync(mockOrcaLog, { force: true });
    const ambStart = await client.startWorker(
      { id: "s1", title: "S1", agent: "codex", model: "gpt-6.2-sol" },
      "task-1",
      "name:testlab",
      { effort: "high" }
    );
    const startLogLines = readFileSync(mockOrcaLog, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    eq("V11 P0-01 unattributed worker-start failure marks ambiguous=true and does NOT blindly retry",
      [ambStart.ok, ambStart.ambiguous, startLogLines.filter((c) => c.args[1] === "worker-start").length],
      [false, true, 1]);
    ok("V11 P0-01 unattributed worker-start failure reconciled via dispatch-show",
      startLogLines.some((c) => c.args[1] === "dispatch-show"));

    // P2-01 + P0-01: manual -> cold transition merges manual attempt before cold attempt & runs beforeEachStartAttempt before EACH attempt!
    process.env.MOCK_V11_MODE = "manual_then_cold";
    let hookCalls = 0;
    const mcRes = await client.startWorker(
      { id: "s2", title: "S2", agent: "agy", model: "gemini-4-neon" },
      "task-2",
      "name:testlab",
      { effort: "medium", beforeEachStartAttempt: () => { hookCalls++; } }
    );
    eq("V11 P2-01 manual->cold start merges manual + cold attempts in order",
      (mcRes.attempts || []).map((a) => a.mode), ["manual", "cold"]);
    eq("V11 P0-01 beforeEachStartAttempt fired before manual AND before cold attempt", hookCalls, 2);

    // P1-02: startWorker respects expired deadlineAt immediately
    const expiredRes = await client.startWorker(
      { id: "s3", title: "S3", agent: "codex", model: "gpt-6.2-sol" },
      "task-3",
      "name:testlab",
      { deadlineAt: Date.now() - 25 }
    );
    eq("V11 P1-02 startWorker aborts immediately when deadlineAt already expired",
      [expiredRes.ok, expiredRes.deadlineExceeded], [false, true]);

    // P1-02: holdForNudge clamps post-send 3000ms sleep to remaining deadlineAt!
    const nudgeCtrl = createNudgeController({
      orca: () => ({ ok: true, json: {} }),
      pick: (o, keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; },
      res: (j) => (j && j.result) ? j.result : (j || {}),
      sleepMs,
      parkedPromptOf: () => null,
      nudgeRetriesOf: () => 2,
      nudgeTimeoutOf: () => 1000,
      outPath: (w) => `.orca/artifacts/${w}`,
      artifactReady: () => false,
      statusSet: () => {},
      writeStatus: () => {},
      warn: () => {},
      settleMember: () => {},
      syncOutputsFromIsolatedWorktree,
      getWtDir: () => tmpV11,
      artDir: ".orca/artifacts",
    });
    const tNudge0 = Date.now();
    nudgeCtrl.holdForNudge({
      step: { id: "n1", title: "N1", writes: "N.md" },
      terminal: "term-1",
      nudge: { left: 2, count: 0, sentAt: 0, phase: null },
      lastBusy: 0,
      deadlineAt: Date.now() + 60,
    }, "succeeded", {});
    const nudgeElapsed = Date.now() - tNudge0;
    ok(`V11 P1-02 holdForNudge clamped 3000ms sleep to remaining 60ms budget (elapsed=${nudgeElapsed}ms)`, nudgeElapsed < 1000);
  } finally {
    if (prevOrcaCmd === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = prevOrcaCmd;
    if (prevV11Mode === undefined) delete process.env.MOCK_V11_MODE;
    else process.env.MOCK_V11_MODE = prevV11Mode;
  }

  // 1c) P0-01 sub-second gate artifact freshness + isolated worktree copy timestamp preservation
  const subMainWt = join(tmpV11, "subsec-main");
  const subIsoWt = join(tmpV11, "subsec-iso");
  mkdirSync(join(subMainWt, ".orca", "artifacts"), { recursive: true });
  mkdirSync(join(subIsoWt, ".orca", "artifacts"), { recursive: true });
  const reviewStepObj = { id: "code-review", writes: "REVIEW.md", verify: { requireVerdict: "PASS" } };
  const preExistingIsoFile = join(subIsoWt, ".orca", "artifacts", "REVIEW.md");
  writeFileSync(preExistingIsoFile, "# Pre-dispatch stale file\n\n" + "Filler line.\n".repeat(12) + "\nVERDICT: PASS\n");
  const preSt = statSync(preExistingIsoFile);
  await sleepMs(20);
  const clr = clearStaleStepArtifact(reviewStepObj, subMainWt, null, ".orca/artifacts");
  bindStepArtifactDispatchClaim(subMainWt, ".orca/artifacts", reviewStepObj, {
    dispatchId: "disp-subsec-1",
    taskId: "task-subsec-1",
    fsEpochMtimeMs: clr.fsEpochMtimeMs,
    clearedAtMs: clr.clearedAtMs,
  });
  // Sync with minSourceMtimeMs MUST skip the pre-dispatch file!
  syncOutputsFromIsolatedWorktree({
    step: reviewStepObj,
    stepWtDir: subIsoWt,
    wtDir: subMainWt,
    artDirRel: ".orca/artifacts",
    minSourceMtimeMs: clr.fsEpochMtimeMs,
  });
  eq("V11 P0-01 syncOutputsFromIsolatedWorktree skips pre-dispatch stale artifact",
    existsSync(join(subMainWt, ".orca", "artifacts", "REVIEW.md")), false);
  // Even if copied without minSourceMtimeMs, utimesSync preserves original mtimeMs and sub-second verifyStepArtifact REJECTS it!
  syncOutputsFromIsolatedWorktree({
    step: reviewStepObj,
    stepWtDir: subIsoWt,
    wtDir: subMainWt,
    artDirRel: ".orca/artifacts",
  });
  const copiedSt = statSync(join(subMainWt, ".orca", "artifacts", "REVIEW.md"));
  ok("V11 P0-01 syncOutputsFromIsolatedWorktree preserved source mtimeMs (did NOT mint fresh copy mtime)",
    Math.abs(copiedSt.mtimeMs - preSt.mtimeMs) < 5);
  const subSecVerify = verifyStepArtifact(
    reviewStepObj,
    join(subMainWt, ".orca", "artifacts"),
    subMainWt,
    50,
    { mode: "settlement", dispatchId: "disp-subsec-1", fsEpochMtimeMs: clr.fsEpochMtimeMs, minMtimeMs: clr.clearedAtMs, clearedBeforeDispatch: true }
  );
  eq("V11 P0-01 sub-second pre-dispatch artifact rejected by verifyStepArtifact", subSecVerify.ok, false);

  // =========================================================================
  // 2) P0-02 + P2-02: Real Python 3 execution across ALL FOUR CI scripts
  //    (GitHub bundled, Gitea bundled, generated generic, generated tailored)
  // =========================================================================
  const realPy = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (!realPy.error && realPy.status === 0) {
    const ghBundledYml = readFileSync(join(REPO, ".github", "workflows", "ci-release.yml"), "utf8");
    const giteaBundledYml = readFileSync(join(REPO, ".gitea", "workflows", "ci-release.yml"), "utf8");
    const genericGenYml = renderCiWorkflow({
      summary: "Generic",
      python: [], node: [], go: [], rust: [], dockerfiles: [], composeFile: null, composeFiles: [],
    }, { platform: "github" });

    // Create a tailored Python project fixture so detectProjectStacks produces renderPythonJob!
    const customDetectDir = join(tmpV11, "py-custom-detect");
    mkdirSync(customDetectDir, { recursive: true });
    writeFileSync(join(customDetectDir, "requirements.txt"), "# offline\n");
    const customGenYml = renderCiWorkflow(detectProjectStacks(customDetectDir), { platform: "github", includeTokenHub: false });

    const stripPipInstall = (s) => s.replace(/^\s*python3 -m pip install .*$/gm, ":");
    const fourScripts = [
      { label: "GitHub bundled", script: stripPipInstall(extractStepScript(ghBundledYml, "Verify Python projects (root / backend)")) },
      { label: "Gitea bundled", script: stripPipInstall(extractStepScript(giteaBundledYml, "Verify Python projects (root / backend)")) },
      { label: "Generated generic", script: stripPipInstall(extractStepScript(genericGenYml, "Verify Python projects (root / backend)")) },
      { label: "Generated tailored", script: stripPipInstall(extractStepScript(customGenYml, "Run Python lint & tests")) },
    ];

    const noPytestDir = join(tmpV11, "no-pytest");
    mkdirSync(noPytestDir, { recursive: true });
    writeFileSync(join(noPytestDir, "pytest.py"), "raise ImportError('offline unittest mode')\n");

    // Case A: Deep failing test at depth 6 (`a/b/c/d/e/unit_test.py`) with `requirements.txt` -> ALL 4 exit exact 1!
    const deepDir = join(tmpV11, "py-deep");
    mkdirSync(join(deepDir, "a", "b", "c", "d", "e"), { recursive: true });
    writeFileSync(join(deepDir, "requirements.txt"), "# deps\n");
    writeFileSync(join(deepDir, "a", "b", "c", "d", "e", "unit_test.py"),
      "import unittest\nclass DeepFail(unittest.TestCase):\n    def test_deep(self):\n        self.assertEqual(2 + 2, 99)\n");
    for (const item of fourScripts) {
      const rDeep = spawnSync("bash", ["-c", item.script], {
        cwd: deepDir,
        env: { ...process.env, PYTHONPATH: noPytestDir },
        encoding: "utf8",
      });
      eq(`V11 P0-02 [${item.label}] deep failing a/b/c/d/e/unit_test.py exits exact 1`, rDeep.status, 1);
    }

    // Case B: Duplicate basename `dir1/unit_test.py` + `dir2/unit_test.py` without __init__.py -> ALL 4 exit exact 0 and run BOTH!
    const dupBaseDir = join(tmpV11, "py-dup-basename");
    mkdirSync(join(dupBaseDir, "dir1"), { recursive: true });
    mkdirSync(join(dupBaseDir, "dir2"), { recursive: true });
    writeFileSync(join(dupBaseDir, "requirements.txt"), "# deps\n");
    writeFileSync(join(dupBaseDir, "dir1", "unit_test.py"),
      "import pathlib, unittest\nHELPER_VAL = 'one'\nclass U1(unittest.TestCase):\n    def test_one(self):\n        pathlib.Path('ran-dir1.txt').write_text(HELPER_VAL)\n        self.assertEqual(HELPER_VAL, 'one')\n");
    writeFileSync(join(dupBaseDir, "dir2", "unit_test.py"),
      "import pathlib, unittest\nHELPER_VAL = 'two'\nclass U2(unittest.TestCase):\n    def test_two(self):\n        pathlib.Path('ran-dir2.txt').write_text(HELPER_VAL)\n        self.assertEqual(HELPER_VAL, 'two')\n");
    for (const item of fourScripts) {
      rmSync(join(dupBaseDir, "ran-dir1.txt"), { force: true });
      rmSync(join(dupBaseDir, "ran-dir2.txt"), { force: true });
      const rDup = spawnSync("bash", ["-c", item.script], {
        cwd: dupBaseDir,
        env: { ...process.env, PYTHONPATH: noPytestDir },
        encoding: "utf8",
      });
      eq(`V11 P0-02 [${item.label}] duplicate-basename dir1/unit_test.py + dir2/unit_test.py exits exact 0`, rDup.status, 0);
      ok(`V11 P0-02 [${item.label}] executed BOTH dir1 and dir2 test modules without import collision`,
        existsSync(join(dupBaseDir, "ran-dir1.txt")) && existsSync(join(dupBaseDir, "ran-dir2.txt")));
    }
  }

  // =========================================================================
  // 3) P0-03 + P2-01 + P2-02: Same-repo unbound status.js, skipped review
  //    provenance & artifact SHA tamper detection, and warm argv embedded --model
  // =========================================================================
  eq("V11 P0-03 warm command 'agy --model claude-sonnet-4-5' overrides step model gemini-4-neon -> anthropic",
    classifyModelFamily("agy --model claude-sonnet-4-5 --effort high", "gemini-4-neon"), "anthropic");
  const embeddedCand = normalizeCandidate({
    agent: "agy --model claude-sonnet-4-5 --effort high",
    model: "gemini-4-neon",
    effort: "medium",
  });
  eq("V11 P2-01 normalizeCandidate extracts embedded argv model & effort while preserving requested fields",
    [embeddedCand.family, embeddedCand.resolvedModel, embeddedCand.effort, embeddedCand.requestedModel, embeddedCand.requestedEffort],
    ["anthropic", "claude-sonnet-4-5", "high", "gemini-4-neon", "medium"]);

  const v11CfCfg = join(REPO, ".orca", "_tmp-v11-cf.config.json");
  const v11IssCfg = join(REPO, ".orca", "_tmp-v11-iss.config.json");
  try {
    writeFileSync(v11CfCfg, JSON.stringify({
      defaults: { timeoutMs: 5000, hardTimeoutMs: 15000, preflight: { enabled: false } },
      pipeline: [
        { id: "coding", title: "Coding", agent: "opencode2", model: "deepseek-v4.1", spec: "Code {out}.", writes: "CHANGES.md" },
        { id: "code-review", title: "Code Review", agent: "codex", model: "gpt-6.2-sol", crossFamilyWith: ["coding"], reads: ["coding"], verify: { requireVerdict: "PASS" }, spec: "Review {out}.", writes: "REVIEW.md" },
        { id: "pr-submit", title: "PR Submit", agent: "opencode2", model: "deepseek-v4.1", reads: ["code-review"], spec: "Submit {out}.", writes: "PR.md" },
      ],
    }));

    // 3a) Same-repo, same-objective status.js WITHOUT ledgerRunKey + `--only code-review` -> MUST FAIL (exit 1)!
    const unboundStatusPayload = {
      meta: {
        objective: "test objective",
        ledgerRunKey: null,
        steps: [{ id: "coding", title: "Coding" }, { id: "code-review", title: "Code Review" }, { id: "pr-submit", title: "PR Submit" }],
      },
      overall: "failed",
      steps: [
        { id: "coding", status: "succeeded", family: "deepseek", executedFamilies: ["deepseek"], agent: "opencode2", model: "deepseek-v4.1" },
        { id: "code-review", status: "pending" },
        { id: "pr-submit", status: "pending" },
      ],
    };
    const rSameRepoUnbound = await runFlow({
      name: "v11-samerepo-unbound",
      config: "_tmp-v11-cf.config.json",
      args: ["--only", "code-review"],
      seedArtifacts: [
        { file: "CHANGES.md", text: "# Changes\n\n" + "Implemented feature.\n".repeat(12) },
        { file: "status.js", text: `window.__STATUS=${JSON.stringify(unboundStatusPayload)};window.__ON_STATUS&&window.__ON_STATUS(window.__STATUS);\n` },
      ],
      budgetMs: 25000,
    });
    eq("V11 P0-03 same-repo status.js without ledgerRunKey is REJECTED on --only code-review", rSameRepoUnbound.code, 1);
    eq("V11 P0-03 zero review workers dispatched when status.js lacks verified ledger", rSameRepoUnbound.by("orchestration worker-start").length, 0);

    // 3b) Skipping code-review (`--from pr-submit`) with forged REVIEW.md (`VERDICT: PASS`) on disk -> REJECTED!
    const rSkipUnverifiedReview = await runFlow({
      name: "v11-skip-unverified-rev",
      config: "_tmp-v11-cf.config.json",
      args: ["--from", "pr-submit"],
      stdinText: "n\n",
      seedArtifacts: [
        { file: "CHANGES.md", text: "# Changes\n\n" + "Implemented feature.\n".repeat(12) },
        { file: "REVIEW.md", text: "# Review\n\n" + "Looks good.\n".repeat(15) + "\nVERDICT: PASS\n" },
      ],
      budgetMs: 25000,
    });
    eq("V11 P0-03 --from pr-submit rejects skipped REVIEW.md lacking verified ledger record", rSkipUnverifiedReview.code, 1);
    ok("V11 P0-03 logged skipped review provenance error", /skipped review step "code-review" lacks a verified run-bound ledger record/.test(rSkipUnverifiedReview.out + rSkipUnverifiedReview.err));

    // 3c) Genuine `coding,code-review` run -> tamper `REVIEW.md` on disk -> `--from pr-submit` detects SHA mismatch!
    const rPrepRev = await runFlow({
      name: "v11-prep-rev",
      config: "_tmp-v11-cf.config.json",
      args: ["--only", "coding,code-review"],
      budgetMs: 30000,
    });
    eq("V11 P0-03 genuine coding,code-review prep succeeded", rPrepRev.code, 0);
    // First confirm clean `--from pr-submit` succeeds when untampered
    const rCleanResume = await runFlow({
      name: "v11-clean-resume",
      reuseDir: rPrepRev.dir,
      config: "_tmp-v11-cf.config.json",
      args: ["--from", "pr-submit"],
      budgetMs: 25000,
    });
    eq("V11 P0-03 untampered ledger-verified --from pr-submit succeeds", rCleanResume.code, 0);
    // Now tamper REVIEW.md while preserving VERDICT: PASS -> must reject!
    const revPath = join(rPrepRev.wt, ".orca", "artifacts", "REVIEW.md");
    writeFileSync(revPath, "# Tampered Review\n\n" + "Injected bypass text.\n".repeat(15) + "\nVERDICT: PASS\n");
    const rTamperedResume = await runFlow({
      name: "v11-tampered-resume",
      reuseDir: rPrepRev.dir,
      config: "_tmp-v11-cf.config.json",
      args: ["--from", "pr-submit"],
      stdinText: "n\n",
      budgetMs: 25000,
    });
    eq("V11 P0-03 tampered REVIEW.md rejected by ledger artifactSha256 check on --from pr-submit", rTamperedResume.code, 1);
    ok("V11 P0-03 logged artifact modified outside bound ledger", /modified outside bound ledger/.test(rTamperedResume.out + rTamperedResume.err));

    // =========================================================================
    // 4) P1-05: Consecutive `--from pr-submit` resumes preserve Epic #42 lineage
    // =========================================================================
    writeFileSync(v11IssCfg, JSON.stringify({
      defaults: { timeoutMs: 5000, targetBranch: "dev", issueTracking: { enabled: true, provider: "gh", createEpic: true, createTaskIssues: true } },
      pipeline: [
        { id: "po-backlog", title: "PO Backlog", agent: "gemini", model: "gemini-4-neon", syncIssues: true, spec: "Plan {out}.", writes: "BACKLOG.md" },
        { id: "pr-submit", title: "PR Submit", agent: "opencode2", model: "deepseek-v4.1", reads: ["po-backlog"], linkIssues: true, spec: "PR refs: {issueCloses}", writes: "PR.md" },
      ],
    }));
    const issFlowDir = mkdtempSync(join(tmpdir(), "orca-v11-iss-"));
    dirsOfCurrentScenario.push(issFlowDir);
    const issWt = join(issFlowDir, "wt");
    mkdirSync(issWt, { recursive: true });
    spawnSync("git", ["init", "-b", "main", issWt], { encoding: "utf8" });
    spawnSync("git", ["-C", issWt, "remote", "add", "origin", "https://github.com/shown1985/sxcj.git"], { encoding: "utf8" });
    const mockGhDir = join(tmpV11, "mock-gh-bin");
    mkdirSync(mockGhDir, { recursive: true });
    const ghSeqFile = join(tmpV11, "gh-seq.txt");
    writeFileSync(ghSeqFile, "41", "utf8");
    writeFileSync(join(mockGhDir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "auth") process.exit(0);
if (a[0] === "repo" && a[1] === "view") { console.log(JSON.stringify({ defaultBranchRef: { name: "main" } })); process.exit(0); }
if (a[0] === "issue" && a[1] === "create") {
  const n = Number(fs.readFileSync(${JSON.stringify(ghSeqFile)}, "utf8")) + 1;
  fs.writeFileSync(${JSON.stringify(ghSeqFile)}, String(n));
  console.log("https://github.com/shown1985/sxcj/issues/" + n);
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });

    const issEnv = { PATH: `${mockGhDir}:${process.env.PATH}` };
    const rIssInit = await runFlow({
      name: "v11-iss-init",
      reuseDir: issFlowDir,
      config: "_tmp-v11-iss.config.json",
      objective: "Epic Lineage Test",
      env: issEnv,
      budgetMs: 30000,
    });
    eq("V11 P1-05 initial run with Epic #42 succeeded", rIssInit.code, 0);

    rmSync(join(issFlowDir, "state.json"), { force: true });
    const rIssRes1 = await runFlow({
      name: "v11-iss-res1",
      reuseDir: issFlowDir,
      config: "_tmp-v11-iss.config.json",
      objective: "Epic Lineage Test",
      args: ["--from", "pr-submit"],
      env: issEnv,
      budgetMs: 25000,
    });
    const specRes1 = Object.values(rIssRes1.state?.tasks || {})[0]?.spec || "";
    eq("V11 P1-05 first --from pr-submit succeeded with Epic #42", [rIssRes1.code, specRes1.includes("#42")], [0, true]);

    rmSync(join(issFlowDir, "state.json"), { force: true });
    const rIssRes2 = await runFlow({
      name: "v11-iss-res2",
      reuseDir: issFlowDir,
      config: "_tmp-v11-iss.config.json",
      objective: "Epic Lineage Test",
      args: ["--from", "pr-submit"],
      env: issEnv,
      budgetMs: 25000,
    });
    const specRes2 = Object.values(rIssRes2.state?.tasks || {})[0]?.spec || "";
    eq("V11 P1-05 SECOND consecutive --from pr-submit STILL preserves Epic #42", [rIssRes2.code, specRes2.includes("#42")], [0, true]);
  } finally {
    for (const f of [v11CfCfg, v11IssCfg]) { try { rmSync(f, { force: true }); } catch {} }
  }

  // =========================================================================
  // 5) P0-04 + P1-11 + P2-02: Two-job CD architecture (SHA pre-gate on hosted
  //    runner BEFORE self-hosted runner) & Compose config/starting/revision checks
  // =========================================================================
  const cdDir = join(tmpV11, "cd-v11");
  mkdirSync(cdDir, { recursive: true });
  writeFileSync(join(cdDir, "docker-compose.prod.yml"), "services:\n  api:\n    image: alpine\n");
  const cdYml = renderSelfHostedCdWorkflow(detectProjectStacks(cdDir), { deployBranch: "main", serviceName: "api" });
  const rubyOk = spawnSync("ruby", ["-ryaml", "-e", "puts 'ok'"], { encoding: "utf8" });
  if (!rubyOk.error && rubyOk.status === 0) {
    const cdYmlFile = join(tmpV11, "cd-selfhosted.yml");
    writeFileSync(cdYmlFile, cdYml);
    const archCheck = spawnSync("ruby", ["-ryaml", "-e", `
      d = YAML.load_file(${JSON.stringify(cdYmlFile)})
      jobs = d['jobs']
      pre = jobs['verify-deploy-source']
      dep = jobs['deploy-intranet']
      raise 'missing verify-deploy-source' unless pre && pre['runs-on'] == 'ubuntu-latest'
      raise 'missing head_sha check on pre-gate if' unless pre['if'].to_s.include?("head_sha != ''")
      raise 'deploy-intranet must need verify-deploy-source' unless dep && dep['needs'] == 'verify-deploy-source'
      raise 'deploy-intranet must run on self-hosted' unless Array(dep['runs-on']).include?('self-hosted')
      raise 'deploy-intranet if must require verified output' unless dep['if'].to_s.include?("needs.verify-deploy-source.outputs.verified == 'true'")
    `], { encoding: "utf8" });
    eq("V11 P0-04 Psych verifies SHA & ref pre-gate runs on ubuntu-latest BEFORE self-hosted runner allocation", archCheck.status, 0);
  }

  const cdHealthBash = extractStepScript(cdYml, "Post-deploy automated health check (PII-safe)");
  const mockDockerDir = join(tmpV11, "mock-docker");
  mkdirSync(mockDockerDir, { recursive: true });
  writeFileSync(join(mockDockerDir, "docker"), `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a.includes("config") && a.includes("--services")) {
  if (process.env.MOCK_CFG_EXIT) process.exit(Number(process.env.MOCK_CFG_EXIT));
  console.log("api");
  process.exit(0);
}
if (a.includes("ps") && a.includes("--format")) {
  process.stdout.write(process.env.MOCK_PS_JSON || "[]");
  process.exit(0);
}
if (a.includes("inspect")) {
  process.stdout.write(process.env.MOCK_INSPECT_OUT || "[]");
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  writeFileSync(join(mockDockerDir, "curl"), "#!/usr/bin/env node\nconsole.log('HTTP/1.1 200 OK\\r\\n\\r\\nok');\nprocess.exit(0);\n", { mode: 0o755 });
  const expectedRevSha = "b".repeat(40);
  // Even if directory marker .orca-deploy-sha exists, container revision MUST still be verified!
  writeFileSync(join(cdDir, ".orca-deploy-sha"), expectedRevSha + "\n");
  const execHealth = (extra) => spawnSync("bash", ["-c", cdHealthBash], {
    cwd: cdDir,
    env: {
      ...process.env,
      PATH: `${mockDockerDir}:${process.env.PATH}`,
      COMPOSE_FILE: "docker-compose.prod.yml",
      SERVICE_NAME: "api",
      ORCA_DEPLOY_SHA: expectedRevSha,
      DEFAULT_HEALTHCHECK_URL: "http://127.0.0.1:8000/health",
      HEALTHCHECK_URL: "",
      DEPLOY_ONESHOT_SERVICES: "",
      HEALTHCHECK_RETRIES: "1",
      HEALTHCHECK_INTERVAL: "0",
      ...extra,
    },
    encoding: "utf8",
  });
  eq("V11 P1-11 compose config --services failure propagates exact exit code 17",
    execHealth({ MOCK_CFG_EXIT: "17", MOCK_PS_JSON: JSON.stringify([{ Service: "api", State: "running", Health: "healthy", Labels: `io.orca-pod.deploy-sha=${expectedRevSha}` }]) }).status, 17);
  eq("V11 P1-11 Health=starting is REJECTED (not treated as healthy)",
    execHealth({ MOCK_PS_JSON: JSON.stringify([{ Service: "api", State: "running", Health: "starting", Labels: `io.orca-pod.deploy-sha=${expectedRevSha}` }]) }).status, 1);
  eq("V11 P1-11 missing live container revision label is REJECTED even when .orca-deploy-sha file exists",
    execHealth({ MOCK_PS_JSON: JSON.stringify([{ Service: "api", State: "running", Health: "healthy", Labels: "" }]) }).status, 1);
  eq("V11 P1-11 mismatched live container revision label is REJECTED",
    execHealth({ MOCK_PS_JSON: JSON.stringify([{ Service: "api", State: "running", Health: "healthy", Labels: `io.orca-pod.deploy-sha=${"c".repeat(40)}` }]) }).status, 1);

  // =========================================================================
  // 6) P1-03, P1-04, P1-06, P1-07, P1-09: Remaining targeted boundary checks
  // =========================================================================
  // P1-03 exact Codex review reproduction: parent .opencode/opencode.json (Claude) + child opencode.json (GPT) -> Claude!
  const ocP = join(tmpV11, "oc-repro");
  const ocSub = join(ocP, "sub");
  mkdirSync(join(ocP, ".opencode"), { recursive: true });
  mkdirSync(ocSub, { recursive: true });
  spawnSync("git", ["init", ocP], { encoding: "utf8" });
  writeFileSync(join(ocP, ".opencode", "opencode.json"), JSON.stringify({ model: "anthropic/claude-sonnet-4-5" }));
  writeFileSync(join(ocSub, "opencode.json"), JSON.stringify({ model: "openai/gpt-5" }));
  eq("V11 P1-03 parent .opencode/opencode.json (Claude) beats child plain opencode.json (GPT)",
    resolveOpencodeConfig({ projectDir: ocSub }).model, "anthropic/claude-sonnet-4-5");

  // P1-04 multi-MCP partial mount failure rolls back ALREADY-WRITTEN first MCP file immediately!
  const partialMountWt = join(tmpV11, "partial-mount");
  mkdirSync(partialMountWt, { recursive: true });
  writeFileSync(join(partialMountWt, ".mcp.json"), "{ broken json");
  let partialMountThrew = false;
  try {
    materializeAgentConfig({
      worktree: partialMountWt,
      members: [
        { id: "m1", agent: "agy", mcp: ["srvA"], skills: [] },
        { id: "m2", agent: "claude", mcp: ["srvB"], skills: [] },
      ],
      cfg: {
        mcpServers: {
          srvA: { command: "node", args: ["a.js"] },
          srvB: { command: "node", args: ["b.js"] },
        },
      },
      configDir: join(REPO, ".orca"),
      die: (m) => { partialMountThrew = true; throw new Error(m); },
      warn: () => {},
      rollbackOnError: true,
    });
  } catch {}
  eq("V11 P1-04 multi-MCP failure threw and IMMEDIATELY rolled back .agents/mcp_config.json",
    [partialMountThrew, existsSync(join(partialMountWt, ".agents", "mcp_config.json")), existsSync(join(partialMountWt, ".orca-agent-config.json"))],
    [true, false, false]);

  // P1-06 external Markdown link `[Issue #42](https://github.com/other/repo/issues/42)` MUST NOT bind local issue #42!
  const extTasks = parseBacklogTasks(
    "- [ ] External ref [Issue #42](https://github.com/other/repo/issues/42)\n- [ ] Same repo ref [Issue #77](https://github.com/shown1985/sxcj/issues/77)\n",
    { currentHost: "github.com", currentRepo: "shown1985/sxcj" }
  );
  eq("V11 P1-06 external Markdown link [Issue #42](other/repo) returns null while same-repo link returns 77",
    [extTasks[0]?.number, extTasks[1]?.number], [null, 77]);
  eq("V11 P1-06 extractExplicitLocalIssueNumber rejects external link without currentRepo context",
    extractExplicitLocalIssueNumber("Track [Issue #42](https://github.com/other/repo/issues/42)"), null);

  // P1-07 `HTTP 404: "repository" not found` is NOT a missing-label error & stderr foreign URL is NEVER treated as created!
  eq('V11 P1-07 HTTP 404: "repository" not found is NOT misclassified as missing label',
    isMissingLabelError('HTTP 404: "repository" not found', "", false), false);
  let repo404Calls = 0;
  const repo404Res = createIssueViaCli({
    provider: "gh",
    bin: "gh",
    repoDir: tmpV11,
    host: "github.com",
    repo: "shown1985/sxcj",
    title: "Test",
    body: "Body",
    labels: ["orca-pod"],
    execFn: () => {
      repo404Calls++;
      return { ok: false, status: 1, stdout: "", stderr: 'HTTP 404: "repository" not found; see https://github.com/other/repo/issues/999', timedOut: false };
    },
  });
  eq("V11 P1-07 404 repository not found + foreign URL in stderr fails cleanly in 1 call (ok=false)",
    [repo404Res.ok, repo404Calls], [false, 1]);

  // P1-09 escaped quotes + spaces in JSON password, unclosed quote tail, and TokenHub redact-BEFORE-slice
  const escapedSecret = '{"password": "alpha \\"beta\\" gamma secret tail", "ok": 1}';
  const redEscaped = sanitizeText(escapedSecret);
  ok("V11 P1-09 sanitizeText completely redacts JSON secret containing escaped quotes and spaces",
    !redEscaped.includes("alpha") && !redEscaped.includes("beta") && !redEscaped.includes("gamma secret tail") && redEscaped.includes('"ok": 1'));

  const unclosedSecret = '{"api_key": "unclosed_secret_at_truncation_boundary with spaces';
  ok("V11 P1-09 sanitizeText redacts unclosed truncated JSON secret value",
    !sanitizeText(unclosedSecret).includes("unclosed_secret_at_truncation_boundary"));

  // Verify TokenHub CI script redacts full rawDiff BEFORE slicing to 40,000 chars!
  const ghCiYml = readFileSync(join(REPO, ".github", "workflows", "ci-release.yml"), "utf8");
  const tokenhubStep = extractStepScript(ghCiYml, "Generate Chinese PR Risk Summary via TokenHub API");
  const nodeHeredocMatch = tokenhubStep.match(/node - <<'EOF'\n([\s\S]*?)\nEOF/);
  ok("V11 P1-09 extracted TokenHub Node script", Boolean(nodeHeredocMatch));
  if (nodeHeredocMatch) {
    const padPrefix = "+ normal line of code padding\n".repeat(1332); // 39,960 chars
    const straddlingLine = '+ const cfg = {"password": "boundary_straddling_super_secret_value_999888777"};\n';
    const capturedPayloadFile = join(tmpV11, "tokenhub-captured.json");
    const harnessJs = [
      `const Module = require("node:module");`,
      `const origLoad = Module._load;`,
      `Module._load = function(req, parent, isMain) {`,
      `  if (req === "node:child_process" || req === "child_process") {`,
      `    return { execSync: (cmd) => cmd.startsWith("git diff") ? (${JSON.stringify(padPrefix + straddlingLine)}) : "" };`,
      `  }`,
      `  return origLoad.apply(this, arguments);`,
      `};`,
      `global.fetch = async (_url, opts) => {`,
      `  require("node:fs").writeFileSync(${JSON.stringify(capturedPayloadFile)}, opts.body);`,
      `  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };`,
      `};`,
      nodeHeredocMatch[1],
    ].join("\n");
    const rTh = spawnSync(process.execPath, ["-e", harnessJs], {
      env: { ...process.env, TOKENHUB_API_KEY: "th_key", TOKENHUB_BASE_URL: "https://example.invalid/v1", TOKENHUB_MODEL: "m", BASE_SHA: "a", HEAD_SHA: "b", PR_NUMBER: "1" },
      encoding: "utf8",
    });
    eq("V11 P1-09 TokenHub boundary test exited 0", rTh.status, 0);
    const sentBody = existsSync(capturedPayloadFile) ? readFileSync(capturedPayloadFile, "utf8") : "";
    ok("V11 P1-09 TokenHub redacted straddling credential BEFORE 40,000-char truncation",
      sentBody.length > 0 && !sentBody.includes("boundary_straddling_super_secret_value_999888777"));
  }
});

// ---------------------------------------------------------------------------
(async () => {
  const t0 = Date.now();
  for (const s of scenarios) {
    if (only && !s.name.includes(only)) continue;
    console.log(`\n# ${s.name}`);
    const failedBefore = failed;
    dirsOfCurrentScenario = [];
    hungInCurrentScenario = false;
    try { await s.fn(); } catch (e) { failed++; total++; console.error("FAIL -", s.name, "threw:", e.message); }
    for (const d of dirsOfCurrentScenario) {
      if (failed > failedBefore || hungInCurrentScenario) console.error(`[harness] kept ${d} for inspection`);
      else { try { rmSync(d, { recursive: true, force: true }); } catch {} }
    }
  }
  if (only && !total) { console.error(`FAIL - --only "${only}" matched no scenario`); process.exit(1); }
  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(`\n${total - failed}/${total} assertions passed in ${dt}s`);
  if (failed) console.error(`${failed} FAILURE(S)`);
  process.exitCode = failed ? 1 : 0;
})();
