#!/usr/bin/env node
// Local Agent CLI & Subscription Scanner + Cross-Family Strategy Recommender.
// Zero dependencies (Node builtins only). Privacy-safe: never reads or outputs
// API keys, cookies, emails, or tokens — only readiness, plan type & quota %.

import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";

export const AGENT_CATALOG = [
  {
    id: "agy",
    label: "Antigravity (agy)",
    bins: ["agy", "antigravity"],
    family: "google",
    rateKey: "antigravity",
    configPaths: [".gemini"],
    capabilities: ["coordinator", "visual", "reviewer", "coding"],
    note: "Native subscription (Gemini 4 / Claude / GPT + multimodal visual)",
  },
  {
    id: "codex",
    label: "Codex CLI",
    bins: ["codex"],
    family: "openai",
    rateKey: "codex",
    configPaths: [".codex"],
    capabilities: ["reviewer", "coding", "release", "coordinator"],
    note: "Strong cross-family code reviewer & release auditor",
  },
  {
    id: "claude",
    label: "Claude Code",
    bins: ["claude"],
    family: "anthropic",
    rateKey: "claude",
    configPaths: [".claude", ".claude.json"],
    capabilities: ["coding", "reviewer", "coordinator", "visual"],
    note: "Deep coding, refactoring & architectural review",
  },
  {
    id: "opencode2",
    label: "OpenCode 2",
    bins: ["opencode2"],
    family: "deepseek-opencode",
    rateKey: "opencodeGo",
    configPaths: [".opencode", ".config/opencode"],
    capabilities: ["coding", "release"],
    note: "High-throughput coding (e.g. DeepSeek V4.1 Flash / OpenCode Go)",
  },
  {
    id: "opencode",
    label: "OpenCode",
    bins: ["opencode"],
    family: "deepseek-opencode",
    rateKey: "opencodeGo",
    configPaths: [".opencode", ".config/opencode"],
    capabilities: ["coding", "release"],
    note: "OpenCode multi-provider coding CLI",
  },
  {
    id: "zcode",
    label: "ZCode (GLM)",
    bins: ["zcode"],
    family: "zhipu",
    rateKey: "zcode",
    configPaths: [".zcode"],
    capabilities: ["coding", "release"],
    note: "GLM Coding Plan execution worker",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bins: ["gemini"],
    family: "google",
    rateKey: "gemini",
    configPaths: [".gemini"],
    capabilities: ["coordinator", "visual", "release"],
    note: "Google Gemini CLI for planning & visual checks",
  },
  {
    id: "kimi",
    label: "Kimi Code",
    bins: ["kimi"],
    family: "moonshot",
    rateKey: "kimi",
    configPaths: [".kimi"],
    capabilities: ["coding", "reviewer"],
    note: "Kimi long-context coding & debugging",
  },
  {
    id: "cursor",
    label: "Cursor Agent",
    bins: ["cursor-agent", "cursor"],
    family: "cursor",
    rateKey: "cursor",
    configPaths: [".cursor"],
    capabilities: ["coding"],
    note: "Cursor agent CLI",
  },
];

function isExecutable(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

export function findBinary(names, pathEnv = process.env.PATH || "") {
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const exts = IS_WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const full = join(dir, IS_WIN && !name.toLowerCase().endsWith(ext.toLowerCase()) ? name + ext : name);
        if (isExecutable(full)) return full;
      }
    }
  }
  return null;
}

export function findOrcaBinary(pathEnv = process.env.PATH || "") {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND;
  const fromPath = findBinary(["orca"], pathEnv);
  if (fromPath) return fromPath;
  const macApp = "/Applications/Orca.app/Contents/Resources/bin/orca";
  if (isExecutable(macApp)) return macApp;
  return null;
}

function queryOrcaAccounts(orcaBin, timeoutMs = 15000) {
  if (!orcaBin) return { ok: false, reason: "orca CLI not found", data: null };
  try {
    const r = spawnSync(orcaBin, ["account", "list", "--json"], {
      encoding: "utf8",
      timeout: timeoutMs,
      shell: IS_WIN && /\.(cmd|bat)$/i.test(orcaBin),
    });
    if (r.error || r.status !== 0) {
      return { ok: false, reason: (r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 160), data: null };
    }
    const parsed = JSON.parse(r.stdout || "{}");
    const result = parsed?.result || parsed || {};
    return { ok: true, reason: null, data: result };
  } catch (e) {
    return { ok: false, reason: e.message, data: null };
  }
}

function summarizeSubscription(entry, rateEntry, spec) {
  const rl = rateEntry || null;
  const status = rl?.status || "unknown";
  const planType = rl?.planType || (spec.rateKey === "opencodeGo" && status === "ok" ? "opencode-go" : null);
  const quota = {};
  if (rl?.session && typeof rl.session.usedPercent === "number") quota.sessionUsedPct = rl.session.usedPercent;
  if (rl?.weekly && typeof rl.weekly.usedPercent === "number") quota.weeklyUsedPct = rl.weekly.usedPercent;
  if (rl?.monthly && typeof rl.monthly.usedPercent === "number") quota.monthlyUsedPct = rl.monthly.usedPercent;
  if (Array.isArray(rl?.buckets) && rl.buckets.length) {
    quota.buckets = rl.buckets.slice(0, 6).map((b) => ({
      group: b.group || b.name || "default",
      window: b.windowName || `${b.windowMinutes || 0}m`,
      usedPct: typeof b.usedPercent === "number" ? b.usedPercent : null,
    }));
  }
  const managedAccounts = Array.isArray(entry?.accounts) ? entry.accounts.length : 0;
  const hasSystemAuth = Boolean(entry?.systemDefault?.hasAuth);
  const billingNote = rl?.error && /api key/i.test(rl.error) ? "api-key-billing" : null;
  return {
    status,
    planType,
    managedAccounts,
    hasSystemAuth,
    billingNote,
    quota: Object.keys(quota).length ? quota : null,
  };
}

export function scanLocalAgents({
  pathEnv = process.env.PATH || "",
  home = homedir(),
  queryOrca = true,
  mockOrcaData = undefined,
  mockBins = undefined,
  mockConfigs = undefined,
} = {}) {
  const orcaBin = mockBins ? (mockBins.orca || null) : findOrcaBinary(pathEnv);
  const orcaProbe = mockOrcaData !== undefined
    ? { ok: Boolean(mockOrcaData), reason: mockOrcaData ? null : "mocked unavailable", data: mockOrcaData }
    : (queryOrca ? queryOrcaAccounts(orcaBin) : { ok: false, reason: "skipped", data: null });

  const rateLimits = orcaProbe.data?.rateLimits || {};
  const agents = AGENT_CATALOG.map((spec) => {
    const binPath = mockBins
      ? (mockBins[spec.id] || null)
      : findBinary(spec.bins, pathEnv);
    const installed = Boolean(binPath);
    const localConfigFound = mockConfigs
      ? Boolean(mockConfigs[spec.id])
      : spec.configPaths.some((rel) => existsSync(join(home, rel)));

    const providerNode = orcaProbe.data?.[spec.id] || orcaProbe.data?.[spec.rateKey] || null;
    const sub = summarizeSubscription(providerNode, rateLimits[spec.rateKey], spec);

    let readiness = "unavailable";
    if (installed && (sub.status === "ok" || sub.hasSystemAuth || sub.managedAccounts > 0)) {
      readiness = "ready";
    } else if (installed && (localConfigFound || sub.billingNote === "api-key-billing")) {
      readiness = "configured";
    } else if (installed) {
      readiness = "cli-only";
    }

    return {
      id: spec.id,
      label: spec.label,
      family: spec.family,
      installed,
      binPath: binPath || null,
      localConfigFound,
      readiness,
      subscription: sub,
      capabilities: spec.capabilities,
      note: spec.note,
    };
  });

  const usable = agents.filter((a) => a.readiness === "ready" || a.readiness === "configured");
  const families = [...new Set(usable.map((a) => a.family))];

  return {
    scannedAt: new Date().toISOString(),
    orca: {
      installed: Boolean(orcaBin),
      binPath: orcaBin || null,
      accountsQueried: orcaProbe.ok,
      probeError: orcaProbe.ok ? null : orcaProbe.reason,
    },
    agents,
    usableIds: usable.map((a) => a.id),
    families,
  };
}

const SCORE = { ready: 3, configured: 2, "cli-only": 1, unavailable: 0 };

function pickBest(agents, preference, { excludeIds = [], excludeFamilies = [], requireUsable = false } = {}) {
  const rankIdx = (id) => {
    const idx = preference.indexOf(id);
    return idx === -1 ? 999 : idx;
  };
  const candidates = agents
    .filter((a) => a.installed)
    .filter((a) => !excludeIds.includes(a.id))
    .filter((a) => !excludeFamilies.includes(a.family))
    .filter((a) => !requireUsable || SCORE[a.readiness] >= 2)
    .sort((a, b) => {
      const sd = SCORE[b.readiness] - SCORE[a.readiness];
      if (sd !== 0) return sd;
      return rankIdx(a.id) - rankIdx(b.id);
    });
  return candidates[0] || null;
}

export function recommendStrategy(scan) {
  const agents = scan.agents || [];
  const installed = agents.filter((a) => a.installed);
  const fallback = (id) => installed[0]?.id || id;

  // Prefer opencode2 over opencode when both exist
  const hasOpencode2 = installed.some((a) => a.id === "opencode2");
  const pool = hasOpencode2 ? agents.filter((a) => a.id !== "opencode") : agents;

  const coder = pickBest(pool, ["opencode2", "opencode", "zcode", "claude", "codex", "agy", "kimi", "cursor"])
    || { id: fallback("opencode"), family: "deepseek-opencode", readiness: "unavailable" };

  const coordinator = pickBest(pool, ["agy", "gemini", "claude", "codex", "opencode2", "opencode", "zcode"])
    || coder;

  const visual = pickBest(pool, ["agy", "gemini", "claude", "codex", "opencode2", "opencode"])
    || coordinator;

  // Cross-family reviewer: strongly prefer a DIFFERENT model family from coder
  const crossReviewer = pickBest(
    pool,
    ["codex", "claude", "agy", "kimi", "gemini", "opencode2", "zcode"],
    { excludeFamilies: [coder.family] }
  );
  const reviewer = crossReviewer || pickBest(pool, ["codex", "claude", "agy", "kimi", "opencode2", "zcode"]) || coder;
  const crossFamily = Boolean(crossReviewer && reviewer.family !== coder.family);

  const coderAlt = pickBest(
    pool,
    ["zcode", "claude", "codex", "agy", "kimi", "opencode2", "opencode"],
    { excludeIds: [coder.id] }
  ) || coder;

  const release = pickBest(pool, ["codex", "opencode2", "opencode", "claude", "agy", "zcode"]) || reviewer;

  const roles = {
    coordinator: coordinator.id,
    visual: visual.id,
    coder: coder.id,
    coderAlt: coderAlt.id,
    reviewer: reviewer.id,
    release: release.id,
  };

  const warnings = [];
  if (!scan.orca.installed) warnings.push("Orca CLI was not found in PATH — install Orca ADE before running pipelines.");
  if (!installed.length) warnings.push("No supported agent CLI detected in PATH. Install at least one (e.g. claude, codex, opencode2, agy, zcode).");
  if (installed.length && !crossFamily) {
    warnings.push(`Only one model family (${coder.family}) is currently available; cross-family code review is degraded. Adding a second provider (e.g. codex or claude) is recommended.`);
  }
  const hasVision = ["agy", "gemini", "claude", "codex"].includes(visual.id) && visual.readiness !== "unavailable";
  if (installed.length && !hasVision) {
    warnings.push("No native multimodal/vision agent detected for Visual Gate; UI screenshot auditing may be limited.");
  }

  return {
    defaultTrack: "flow-feature.json",
    targetBranch: "dev",
    protectedBranches: ["main", "master"],
    crossFamily,
    coderFamily: coder.family,
    reviewerFamily: reviewer.family,
    roles,
    warnings,
    rationale: {
      coordinator: `${roles.coordinator} (${coordinator.readiness}) — planning & scope triage`,
      visual: `${roles.visual} (${visual.readiness}) — UI/UX screenshot & DESIGN.md audit`,
      coder: `${roles.coder} (${coder.readiness}) — high-throughput primary implementation`,
      coderAlt: `${roles.coderAlt} (${coderAlt.readiness}) — parallel/complex task backup`,
      reviewer: `${roles.reviewer} (${reviewer.readiness}) — ${crossFamily ? `cross-family audit (${reviewer.family} != ${coder.family})` : "same-family fallback review"}`,
      release: `${roles.release} (${release.readiness}) — PR creation & target-branch merge`,
    },
  };
}

function formatQuota(a) {
  const q = a.subscription?.quota;
  if (!q) {
    if (a.subscription?.billingNote === "api-key-billing") return "API key";
    if (a.localConfigFound) return "local config";
    return a.installed ? "CLI only" : "-";
  }
  const parts = [];
  if (a.subscription?.planType) parts.push(a.subscription.planType);
  if (q.sessionUsedPct != null) parts.push(`5h:${q.sessionUsedPct}%`);
  if (q.weeklyUsedPct != null) parts.push(`7d:${q.weeklyUsedPct}%`);
  if (q.monthlyUsedPct != null) parts.push(`30d:${q.monthlyUsedPct}%`);
  return parts.join(" · ") || "ok";
}

export function formatScanReport(scan, rec) {
  const lines = [];
  lines.push("Orca-Pod Local Agent & Subscription Scan");
  lines.push("========================================");
  lines.push(`Orca CLI : ${scan.orca.installed ? `OK (${scan.orca.binPath})` : "NOT FOUND"}${scan.orca.accountsQueried ? " · live subscription probe OK" : scan.orca.probeError ? ` · probe skipped (${scan.orca.probeError})` : ""}`);
  lines.push("");
  lines.push("Detected Agents:");
  const active = scan.agents.filter((a) => a.installed || a.subscription.status === "ok");
  if (!active.length) {
    lines.push("  (none detected in PATH)");
  } else {
    for (const a of active) {
      const badge = a.readiness === "ready" ? "[READY]     "
        : a.readiness === "configured" ? "[CONFIGURED]"
        : a.readiness === "cli-only" ? "[CLI-ONLY]  "
        : "[UNAVAIL]   ";
      lines.push(`  ${badge} ${a.id.padEnd(10)} (${a.family.padEnd(17)})  ${formatQuota(a)}`);
    }
  }
  const missing = scan.agents.filter((a) => !a.installed && a.subscription.status !== "ok").map((a) => a.id);
  if (missing.length) lines.push(`  Not installed: ${missing.join(", ")}`);

  lines.push("");
  lines.push("Recommended Role Mapping:");
  lines.push(`  Coordinator / Plan : ${rec.rationale.coordinator}`);
  lines.push(`  Visual Gate (UI)   : ${rec.rationale.visual}`);
  lines.push(`  Primary Coder      : ${rec.rationale.coder}`);
  lines.push(`  Parallel / Alt Dev : ${rec.rationale.coderAlt}`);
  lines.push(`  Code Reviewer      : ${rec.rationale.reviewer}`);
  lines.push(`  Release / PR       : ${rec.rationale.release}`);
  lines.push(`  Default Track      : ${rec.defaultTrack}  (target: ${rec.targetBranch}, protected: ${rec.protectedBranches.join(", ")})`);

  if (rec.warnings.length) {
    lines.push("");
    lines.push("Notes:");
    for (const w of rec.warnings) lines.push(`  ! ${w}`);
  }
  return lines.join("\n");
}

// Standalone CLI execution
const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const asJson = process.argv.includes("--json");
  const noOrca = process.argv.includes("--no-orca");
  const scan = scanLocalAgents({ queryOrca: !noOrca });
  const recommendation = recommendStrategy(scan);
  if (asJson) console.log(JSON.stringify({ scan, recommendation }, null, 2));
  else console.log(formatScanReport(scan, recommendation));
}
