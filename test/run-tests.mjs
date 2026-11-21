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
async function runFlow({ name, config, scenario: scenarioFile = "default.cjs", args = [], objective = "test objective", seedArtifacts = [], seedWorktree = [], env: extraEnv = null, stdinText = null, budgetMs = 90000, notify = null, reuseDir = null, worktreePin = "name:testlab" }) {
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
  env.USERPROFILE = home;
  env.HOME = home;
  const argv = [FLOW, ...args, "--no-open-status"];
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

scenario("S1c invalid pre-existing mcp.json dies WITH a manifest (abort window healable)", async () => {
  const r = await runFlow({ name: "s1c", config: "../test/configs/agent-skills.config.json",
    scenario: "agent-config-snap.cjs",
    seedWorktree: [{ file: ".mcp.json", text: "this is not json" }], budgetMs: 90000 });
  ok("S1c not hung", !r.hung);
  eq("S1c exit code", r.code, 1);
  ok("S1c die message", /\.mcp\.json already exists in the worktree and is not valid JSON/.test(r.out + r.err));
  ok("S1c manifest flushed for self-heal", existsSync(join(r.wt, ".orca-agent-config.json")));
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
    "gate-verify.mjs", "worktree-isolation.mjs", "merge-danger.mjs", "health.mjs", "ledger.mjs",
    "lib/orca-cli.mjs", "lib/status.mjs", "lib/status-template.html", "lib/usage.mjs", "lib/notify.mjs", "lib/nudge.mjs", "lib/runner.mjs",
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

  const valid = await runFlow({
    name: "p4-valid", config: "../test/configs/verdict-gate.config.json", args: ["--from", "worker"],
    env: { ORCA_VERIFY_HEAD_SHA: HEAD_SHA },
    seedArtifacts: [{ file: "CONTRACT_REVIEW.md", text: `# Review\nContract-Commit: ${HEAD_SHA}\n\n${filler}\nVERDICT: PASS\n` }],
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
