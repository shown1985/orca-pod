#!/usr/bin/env node
// Interactive Pre-Development Strategy Wizard & Config Applier for orca-pod.
// Replaces the legacy web designer with a fast, terminal-first conversation:
// scans local agents/subscriptions, recommends a cross-family pairing, confirms
// track + branch rules with the user, updates .orca/flow*.json & writes STRATEGY.md.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { scanLocalAgents, recommendStrategy, formatScanReport } from "./agent-scanner.mjs";

export const STEP_ROLE_MAP = {
  grill: "coordinator",
  "po-backlog": "coordinator",
  "contract-architecture": "coordinator",
  "micro-plan": "coordinator",
  "visual-gate": "visual",
  "hotfix-coding": "coder",
  coding: "coder",
  "worker-backend": "coder",
  "worker-frontend": "coderAlt",
  "serial-integration": "coder",
  "contract-review": "reviewer",
  "task-review-merge": "reviewer",
  "diff-audit": "reviewer",
  "code-review": "reviewer",
  "senior-audit": "reviewer",
  "pr-submit": "release",
  "pr-release-dev": "release",
};

const TRACK_CHOICES = [
  { key: "1", file: "flow-feature.json", label: "Track 1 — Feature (default: micro-plan -> coding -> visual-gate -> review -> PR)" },
  { key: "2", file: "flow-epic.json", label: "Track 2 — Epic / 0->1 (contract-first, parallel isolated worktrees, serial integration)" },
  { key: "0", file: "flow-hotfix.json", label: "Track 0 — Hotfix (<=3 files fast patch -> diff audit -> PR)" },
];

function ask(rl, question) {
  return new Promise((resolveAnswer) => {
    rl.question(question, (ans) => resolveAnswer(String(ans ?? "").trim()));
  });
}

function parseList(raw, fallback) {
  const items = String(raw || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return items.length ? [...new Set(items)] : fallback;
}

export function applyStrategyToProject(projectDir, strategy) {
  const orcaDir = join(projectDir, ".orca");
  mkdirSync(orcaDir, { recursive: true });
  const trackFiles = ["flow-hotfix.json", "flow-feature.json", "flow-epic.json"];
  const updated = [];

  for (const tf of trackFiles) {
    const full = join(orcaDir, tf);
    if (!existsSync(full)) continue;
    const cfg = JSON.parse(readFileSync(full, "utf8"));
    cfg.defaults = cfg.defaults || {};
    if (strategy.targetBranch) cfg.defaults.targetBranch = strategy.targetBranch;
    if (Array.isArray(strategy.protectedBranches) && strategy.protectedBranches.length) {
      cfg.defaults.protectedBranches = strategy.protectedBranches;
    }
    if (Array.isArray(cfg.pipeline)) {
      for (const step of cfg.pipeline) {
        const role = STEP_ROLE_MAP[step?.id];
        if (role && strategy.roles?.[role]) step.agent = strategy.roles[role];
      }
    }
    writeFileSync(full, JSON.stringify(cfg, null, 2) + "\n");
    updated.push(`.orca/${tf}`);
  }

  // Sync default flow.config.json from the chosen default track
  const chosenTrack = strategy.defaultTrack || "flow-feature.json";
  const srcTrack = join(orcaDir, chosenTrack);
  if (existsSync(srcTrack)) {
    writeFileSync(join(orcaDir, "flow.config.json"), readFileSync(srcTrack, "utf8"));
    updated.push(".orca/flow.config.json");
  }

  // Write concise project strategy summary (.orca/STRATEGY.md)
  const strategyDoc = [
    "# Project Development Strategy (orca-pod)",
    "",
    `> Confirmed at: ${new Date().toISOString()}`,
    "",
    "## Workflow & Branch Policy",
    `- **Default Track**: \`${chosenTrack}\``,
    `- **Release Target Branch**: \`${strategy.targetBranch || "dev"}\``,
    `- **Protected Branches (no direct push/auto-merge)**: \`${(strategy.protectedBranches || ["main", "master"]).join("`, `")}\``,
    ...(strategy.projectNote ? [`- **Project / Test Note**: ${strategy.projectNote}`] : []),
    "",
    "## Agent Routing",
    "| Role | Agent | Purpose |",
    "| --- | --- | --- |",
    `| Coordinator / Plan | \`${strategy.roles.coordinator}\` | Triage, architecture & micro-plan |`,
    `| Visual Gate (UI) | \`${strategy.roles.visual}\` | DESIGN.md & screenshot audit |`,
    `| Primary Coder | \`${strategy.roles.coder}\` | Core feature / backend implementation |`,
    `| Parallel / Alt Coder | \`${strategy.roles.coderAlt}\` | Parallel isolated worktree worker |`,
    `| Code Reviewer | \`${strategy.roles.reviewer}\` | Cross-family review & contract/merge audit |`,
    `| Release / PR | \`${strategy.roles.release}\` | PR creation & target-branch merge |`,
    "",
    "## Quick Run Commands",
    "```bash",
    `node .orca/flow.mjs --dry-run "#feat <your objective>"`,
    `node .orca/flow.mjs --config flow-hotfix.json "#hotfix <small fix>"`,
    `node .orca/flow.mjs --config flow-epic.json "#epic <0->1 module>"`,
    "```",
    "",
  ].join("\n");
  writeFileSync(join(orcaDir, "STRATEGY.md"), strategyDoc);
  updated.push(".orca/STRATEGY.md");

  return { updated, strategyPath: join(orcaDir, "STRATEGY.md") };
}

export async function runStrategyWizard({
  projectDir = process.cwd(),
  scan = null,
  recommendation = null,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  applyRecommended = false,
  log = (...a) => console.log(...a),
} = {}) {
  const s = scan || scanLocalAgents();
  const rec = recommendation || recommendStrategy(s);

  log("");
  log(formatScanReport(s, rec));

  if (!interactive) {
    if (!applyRecommended) {
      log("");
      log("[orca-pod] Non-interactive shell detected — skipped interactive wizard (pass --apply-recommended to apply the recommended routing automatically).");
      return { applied: false, strategy: rec, updated: [] };
    }
    const res = applyStrategyToProject(projectDir, rec);
    log("");
    log(`[orca-pod] Applied recommended strategy (${res.updated.length} files updated, wrote .orca/STRATEGY.md).`);
    return { applied: true, strategy: rec, updated: res.updated };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    log("");
    log("Pre-Development Strategy Confirmation (press Enter to keep recommended value):");
    for (const tc of TRACK_CHOICES) log(`  [${tc.key}] ${tc.label}`);
    const trackAns = await ask(rl, "Default track [1]: ");
    const chosenTrack = TRACK_CHOICES.find((t) => t.key === trackAns)?.file || rec.defaultTrack;

    const roles = { ...rec.roles };
    const rolePrompts = [
      ["coordinator", "Coordinator / Planner agent"],
      ["visual", "Visual Gate (UI) agent"],
      ["coder", "Primary Coder agent"],
      ["coderAlt", "Parallel / Alt Coder agent"],
      ["reviewer", "Cross-Family Reviewer agent"],
      ["release", "Release / PR agent"],
    ];
    for (const [k, label] of rolePrompts) {
      const ans = await ask(rl, `${label} [${roles[k]}]: `);
      if (ans) roles[k] = ans;
    }

    const tbAns = await ask(rl, `Release target branch [${rec.targetBranch}]: `);
    const targetBranch = tbAns || rec.targetBranch;

    const pbAns = await ask(rl, `Protected branches (comma-separated) [${rec.protectedBranches.join(",")}]: `);
    const protectedBranches = parseList(pbAns, rec.protectedBranches);
    if (protectedBranches.includes(targetBranch)) {
      log(`  ! Warning: target branch "${targetBranch}" is also in protectedBranches — reverting target branch to "dev".`);
    }
    const safeTarget = protectedBranches.includes(targetBranch) ? "dev" : targetBranch;

    const projectNote = await ask(rl, "Optional project/test command note (e.g. pnpm test) [skip]: ");
    const confirm = await ask(rl, "Write this strategy to .orca/flow*.json and .orca/STRATEGY.md? [Y/n]: ");
    if (/^(n|no)$/i.test(confirm)) {
      log("[orca-pod] Cancelled — no config files modified.");
      return { applied: false, strategy: rec, updated: [] };
    }

    const finalStrategy = {
      ...rec,
      defaultTrack: chosenTrack,
      targetBranch: safeTarget,
      protectedBranches,
      roles,
      projectNote: projectNote || null,
    };
    const res = applyStrategyToProject(projectDir, finalStrategy);
    log("");
    log("[orca-pod] Strategy confirmed and saved:");
    for (const f of res.updated) log(`  updated  ${f}`);
    return { applied: true, strategy: finalStrategy, updated: res.updated };
  } finally {
    rl.close();
  }
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes") || args.includes("--apply-recommended");
  const noOrca = args.includes("--no-orca");
  const scan = scanLocalAgents({ queryOrca: !noOrca });
  const recommendation = recommendStrategy(scan);
  await runStrategyWizard({
    projectDir: process.cwd(),
    scan,
    recommendation,
    interactive: !yes && Boolean(process.stdin.isTTY && process.stdout.isTTY),
    applyRecommended: yes,
  });
}
