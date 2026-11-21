#!/usr/bin/env node
// orca-pod — npx scaffolder (delivery only, not pipeline logic).
// Copies the customized 3-Track Orca SDLC kit into the CWD (the user's project root).
// Zero dependencies: Node builtins only.
//
// Usage:
//   npx /path/to/orca-pod                    # install (existing user files kept safely)
//   npx github:shown1985/orca-pod            # install directly from GitHub
//   npx /path/to/orca-pod --upgrade-engine   # refresh engine/runtime files only (preserve custom configs/docs)
//   npx /path/to/orca-pod --force            # overwrite all existing files
//
// Rules:
//   - explicit whitelist ONLY: the repo's .orca/ also holds dev/runtime junk
//     (artifacts/, status-preview/, usage-test/) that must never ship.
//   - never clobber existing files without --force (safe upgrades + merge hint).
//   - no interactive prompts (must be scriptable in CI).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const log = (...a) => console.log("[orca-pod]", ...a);
const die = (m) => { console.error("[orca-pod] ERROR:", m); process.exit(1); };

// Whitelist — mirrors package.json "files". KEEP THE TWO LISTS IN SYNC.
const FILES = [
  ".orca/flow.mjs",
  ".orca/agent-config.mjs",
  ".orca/gate-verify.mjs",
  ".orca/worktree-isolation.mjs",
  ".orca/designer.mjs",
  ".orca/designer.html",
  ".orca/flow.config.json",
  ".orca/flow-hotfix.json",
  ".orca/flow-feature.json",
  ".orca/flow-epic.json",
  ".orca/fixbug.config.json",
  ".orca/cr.config.json",
  ".orca/CONFIGURATION.md",
  ".orca/README.md",
  ".orca/notify.json",
  ".orca/prompts/triage-po.md",
  ".orca/prompts/frontend-worker.md",
  ".orca/prompts/senior-auditor.md",
  ".orca/workflow-template/README.md",
  ".orca/workflow-template/sdlc.config.json",
  ".orca/workflow-template/fixbug.config.json",
  ".orca/workflow-template/cr.config.json",
  "AGENTS.md",
  "DESIGN.md",
  ".worktreeinclude",
  ".github/workflows/ci-release.yml",
  ".gitea/workflows/ci-release.yml",
  "orca.yaml",
];

// Files that users frequently customize in their own repos — highlight merge hints if skipped.
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
  ".orca/gate-verify.mjs",
  ".orca/worktree-isolation.mjs",
  ".orca/designer.mjs",
  ".orca/designer.html",
  ".orca/CONFIGURATION.md",
  ".orca/README.md",
]);
const args = process.argv.slice(2);
const force = args.includes("--force");
const upgradeEngine = args.includes("--upgrade-engine");

// --- Package sanity: verify every source file exists before touching anything ---
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
    writeFileSync(f, readFileSync(join(KIT_ROOT, f)));   // Buffer copy = byte-exact
    copied.push(f);
  }
} catch (e) { die(`copy failed: ${e.message}`); }

// --- .gitignore: append the artifacts line exactly once ---
const GI_LINE = ".orca/artifacts/";
const gi = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
const gitignoreAdded = !gi.split(/\r?\n/).includes(GI_LINE);
if (gitignoreAdded) {
  const base = gi ? gi.replace(/\r?\n?$/, "\n") : "";
  try { writeFileSync(".gitignore", base + GI_LINE + "\n"); }
  catch (e) { die(`could not update .gitignore: ${e.message}`); }
}

// --- Report + merge hints + next steps ---
log(`installing into ${process.cwd()}`);
for (const f of copied) log(`  installed   ${f}`);
for (const f of skipped) log(`  kept yours  ${f}  (already exists; --force to overwrite)`);
if (gitignoreAdded) log(`  updated     .gitignore  (+ ${GI_LINE})`);
if (upgradeEngine) {
  log("");
  log("Engine upgraded. Review template workflow updates (e.g. isolatedWorktree, verify, targetBranch):");
  for (const tf of [".orca/flow-epic.json", ".orca/flow-feature.json", ".orca/flow-hotfix.json"]) {
    log(`  diff -u "${tf}" "${join(KIT_ROOT, tf)}"`);
  }
}
if (mergeHints.length) {
  log("");
  log("Safe merge hint — the following existing files were preserved:");
  for (const f of mergeHints) {
    log(`  diff -u "${f}" "${join(KIT_ROOT, f)}"`);
  }
}
log("");
log("Next steps (3-Track Workflow):");
log("  1. Track 0 (Hotfix, <=3 files):  node .orca/flow.mjs --config flow-hotfix.json --dry-run \"#hotfix ...\"");
log("  2. Track 1 (Feature, default):   node .orca/flow.mjs --dry-run \"#feat ...\"");
log("  3. Track 2 (Epic / 0->1):        node .orca/flow.mjs --config flow-epic.json --dry-run \"#epic ...\"");
log("  4. CI Secrets: set TOKENHUB_API_KEY in GitHub/Gitea repo secrets for headless PR summaries.");
