#!/usr/bin/env node
// orca-pod — zero-dep scaffolder + local agent scanner + pre-dev strategy wizard.
//
// Usage:
//   npx orca-pod                             # install kit (+ interactive strategy wizard in TTY)
//   npx orca-pod --scan [--json]             # scan local agents & subscriptions, print recommendation
//   npx orca-pod --setup                     # run pre-dev conversational strategy wizard in CWD
//   npx orca-pod --apply-recommended         # install + auto-apply recommended local agent routing
//   npx orca-pod --upgrade-engine            # refresh engine/runtime modules only (preserve configs/docs)
//   npx orca-pod --force                     # overwrite all existing files
//   npx orca-pod --no-interactive            # skip TTY wizard prompt (CI-safe)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanLocalAgents, recommendStrategy, formatScanReport } from "../.orca/agent-scanner.mjs";
import { runStrategyWizard } from "../.orca/strategy-wizard.mjs";
import { detectProjectStacks, generateCiCdFiles } from "../.orca/ci-generator.mjs";

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const log = (...a) => console.log("[orca-pod]", ...a);
const die = (m) => { console.error("[orca-pod] ERROR:", m); process.exit(1); };

// Whitelist — mirrors package.json "files". KEEP THE TWO LISTS IN SYNC.
const FILES = [
  ".orca/flow.mjs",
  ".orca/agent-config.mjs",
  ".orca/agent-scanner.mjs",
  ".orca/strategy-wizard.mjs",
  ".orca/gate-verify.mjs",
  ".orca/worktree-isolation.mjs",
  ".orca/merge-danger.mjs",
  ".orca/health.mjs",
  ".orca/watchdog.mjs",
  ".orca/preflight.mjs",
  ".orca/issue-tracker.mjs",
  ".orca/ci-generator.mjs",
  ".orca/ledger.mjs",
  ".orca/lib/orca-cli.mjs",
  ".orca/lib/status.mjs",
  ".orca/lib/status-template.html",
  ".orca/lib/usage.mjs",
  ".orca/lib/notify.mjs",
  ".orca/lib/nudge.mjs",
  ".orca/lib/runner.mjs",
  ".orca/flow.config.json",
  ".orca/flow-hotfix.json",
  ".orca/flow-feature.json",
  ".orca/flow-epic.json",
  ".orca/CONFIGURATION.md",
  ".orca/README.md",
  ".orca/notify.json",
  ".orca/prompts/triage-po.md",
  ".orca/prompts/frontend-worker.md",
  ".orca/prompts/senior-auditor.md",
  "AGENTS.md",
  "DESIGN.md",
  ".worktreeinclude",
  ".github/workflows/ci-release.yml",
  ".gitea/workflows/ci-release.yml",
  "orca.yaml",
];

const MERGE_SENSITIVE = new Set([
  "AGENTS.md",
  "DESIGN.md",
  ".worktreeinclude",
  "orca.yaml",
  ".orca/flow.config.json",
  ".github/workflows/ci-release.yml",
  ".gitea/workflows/ci-release.yml",
]);

const ENGINE_FILES = new Set([
  ".orca/flow.mjs",
  ".orca/agent-config.mjs",
  ".orca/agent-scanner.mjs",
  ".orca/strategy-wizard.mjs",
  ".orca/gate-verify.mjs",
  ".orca/worktree-isolation.mjs",
  ".orca/merge-danger.mjs",
  ".orca/health.mjs",
  ".orca/watchdog.mjs",
  ".orca/preflight.mjs",
  ".orca/issue-tracker.mjs",
  ".orca/ci-generator.mjs",
  ".orca/ledger.mjs",
  ".orca/lib/orca-cli.mjs",
  ".orca/lib/status.mjs",
  ".orca/lib/status-template.html",
  ".orca/lib/usage.mjs",
  ".orca/lib/notify.mjs",
  ".orca/lib/nudge.mjs",
  ".orca/lib/runner.mjs",
  ".orca/CONFIGURATION.md",
  ".orca/README.md",
]);

const args = process.argv.slice(2);
const force = args.includes("--force");
const upgradeEngine = args.includes("--upgrade-engine");
const scanOnly = args.includes("--scan");
const setupOnly = args.includes("--setup");
const asJson = args.includes("--json");
const noOrca = args.includes("--no-orca");
const applyRecommended = args.includes("--apply-recommended") || args.includes("--yes");
const noInteractive = args.includes("--no-interactive");
const generateCi = args.includes("--generate-ci");
const selfHostedCd = args.includes("--self-hosted-cd");

// --- Scan-only mode (no filesystem changes) ---
if (scanOnly) {
  const scan = scanLocalAgents({ queryOrca: !noOrca });
  const recommendation = recommendStrategy(scan);
  if (asJson) console.log(JSON.stringify({ scan, recommendation }, null, 2));
  else console.log(formatScanReport(scan, recommendation));
  process.exit(0);
}

// --- Setup-only mode (interactive strategy wizard on existing project) ---
if (setupOnly) {
  const scan = scanLocalAgents({ queryOrca: !noOrca });
  const recommendation = recommendStrategy(scan);
  await runStrategyWizard({
    projectDir: process.cwd(),
    scan,
    recommendation,
    interactive: !applyRecommended && !noInteractive && Boolean(process.stdin.isTTY && process.stdout.isTTY),
    applyRecommended,
  });
  process.exit(0);
}

// --- CI/CD generator-only mode ---
if (generateCi && !force && !upgradeEngine && existsSync(".orca/flow.mjs")) {
  const res = generateCiCdFiles(process.cwd(), {
    writeGithubCi: true,
    writeGiteaCi: false,
    writeSelfHostedCd: selfHostedCd,
    force: true,
  });
  log(`detected stack: ${res.detection.summary}`);
  for (const f of res.written) log(`  generated   ${f}`);
  process.exit(0);
}

// --- Package sanity check ---
const missing = FILES.filter((f) => !existsSync(join(KIT_ROOT, f)));
if (missing.length) die(`corrupt package — missing: ${missing.join(", ")}`);

// --- Copy whitelist into CWD ---
const copied = [], skipped = [], mergeHints = [];
try {
  for (const f of FILES) {
    if (existsSync(f) && !force && !(upgradeEngine && ENGINE_FILES.has(f))) {
      skipped.push(f);
      if (MERGE_SENSITIVE.has(f)) mergeHints.push(f);
      continue;
    }
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, readFileSync(join(KIT_ROOT, f)));
    copied.push(f);
  }
} catch (e) { die(`copy failed: ${e.message}`); }

// --- .gitignore: append .orca/artifacts/ once ---
const GI_LINE = ".orca/artifacts/";
const gi = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
const gitignoreAdded = !gi.split(/\r?\n/).includes(GI_LINE);
if (gitignoreAdded) {
  const base = gi ? gi.replace(/\r?\n?$/, "\n") : "";
  try { writeFileSync(".gitignore", base + GI_LINE + "\n"); }
  catch (e) { die(`could not update .gitignore: ${e.message}`); }
}

// --- Stack-aware CI/CD tailoring (fresh install or --generate-ci / --self-hosted-cd) ---
const stackDetect = detectProjectStacks(process.cwd());
const ciGenerated = [];
if (generateCi || selfHostedCd || (copied.includes(".github/workflows/ci-release.yml") && stackDetect.hasAny)) {
  const ciRes = generateCiCdFiles(process.cwd(), {
    writeGithubCi: generateCi || copied.includes(".github/workflows/ci-release.yml"),
    writeGiteaCi: copied.includes(".gitea/workflows/ci-release.yml"),
    writeSelfHostedCd: selfHostedCd,
    force: true,
  });
  ciGenerated.push(...ciRes.written);
}

// --- Report ---
log(`installing into ${process.cwd()}`);
for (const f of copied) log(`  installed   ${f}`);
for (const f of skipped) log(`  kept yours  ${f}  (already exists; --force to overwrite)`);
if (gitignoreAdded) log(`  updated     .gitignore  (+ ${GI_LINE})`);
if (ciGenerated.length) log(`  tailored CI for stack [${stackDetect.summary}]: ${ciGenerated.join(", ")}`);

if (upgradeEngine) {
  log("");
  log("Engine upgraded. Review template workflow updates:");
  for (const tf of [".orca/flow-epic.json", ".orca/flow-feature.json", ".orca/flow-hotfix.json"]) {
    log(`  diff -u "${tf}" "${join(KIT_ROOT, tf)}"`);
  }
}
if (mergeHints.length) {
  log("");
  log("Safe merge hint — the following existing files were preserved:");
  for (const f of mergeHints) log(`  diff -u "${f}" "${join(KIT_ROOT, f)}"`);
}

// --- Local agent scan + pre-dev strategy confirmation ---
if (!upgradeEngine && (applyRecommended || (!noInteractive && process.stdin.isTTY && process.stdout.isTTY))) {
  const scan = scanLocalAgents({ queryOrca: !noOrca });
  const recommendation = recommendStrategy(scan);
  await runStrategyWizard({
    projectDir: process.cwd(),
    scan,
    recommendation,
    interactive: !applyRecommended && Boolean(process.stdin.isTTY && process.stdout.isTTY),
    applyRecommended,
  });
}

log("");
log("Next steps:");
log("  1. Scan local agents & subscriptions:  node .orca/flow.mjs --scan");
log("  2. Confirm / tweak dev strategy:       node .orca/flow.mjs --setup");
log("  3. Track 0 (Hotfix, <=3 files):        node .orca/flow.mjs --config flow-hotfix.json --dry-run \"#hotfix ...\"");
log("  4. Track 1 (Feature, default):         node .orca/flow.mjs --dry-run \"#feat ...\"");
log("  5. Track 2 (Epic / 0->1):              node .orca/flow.mjs --config flow-epic.json --dry-run \"#epic ...\"");
