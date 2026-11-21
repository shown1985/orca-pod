#!/usr/bin/env node
// GitHub (gh) / Gitea (tea) Issue + PR full traceability loop for Orca-Pod.
// Auto-detects gh/tea when available, creates/links Epic & sub-task issues during
// planning steps (po-backlog / micro-plan / triage-root-cause), records numbers in
// .orca/artifacts/ISSUES.json + out-of-repo ledger, and injects Refs #N / Closes #N
// into PR creation steps. Zero external dependencies (Node >= 18).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUES_JSON = "ISSUES.json";
export const ISSUES_MD = "ISSUES.md";

export const DEFAULT_ISSUE_TRACKING = {
  mode: "auto", // "auto" | true | false
  provider: "auto", // "auto" | "gh" | "tea"
  epicIssue: null,
  labels: ["orca-pod"],
  epicLabel: "epic",
  taskLabel: "task",
  closeOnPr: true,
  maxSubtasks: 20,
  planningSteps: ["po-backlog", "micro-plan", "triage-root-cause"],
  prSteps: ["pr-submit", "pr-release-dev"],
};

function defaultExec(bin, args, { cwd = process.cwd(), timeoutMs = 15000 } = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", cwd, timeout: timeoutMs });
  return {
    ok: !r.error && r.status === 0,
    status: r.status ?? (r.error ? -1 : 0),
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    error: r.error ? r.error.message : null,
  };
}

export function resolveIssueTrackingConfig(cfg = {}, opt = {}) {
  const raw = cfg?.defaults?.issueTracking;
  let merged = { ...DEFAULT_ISSUE_TRACKING };
  if (typeof raw === "boolean" || raw === "auto") {
    merged.mode = raw;
  } else if (raw && typeof raw === "object") {
    merged = { ...merged, ...raw };
  }
  if (opt.noIssues) merged.mode = false;
  else if (opt.issues) merged.mode = true;
  if (opt.epicIssue != null && String(opt.epicIssue).trim()) {
    const n = Number(String(opt.epicIssue).replace(/^#/, ""));
    if (Number.isInteger(n) && n > 0) merged.epicIssue = n;
  }
  return merged;
}

export function parseRemoteHost(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== "string") return null;
  const u = remoteUrl.trim();
  if (!u) return null;
  // Local filesystem path (e.g. /tmp/origin.git or file://...) -> not a hosted forge
  if (u.startsWith("/") || u.startsWith("./") || u.startsWith("../") || u.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(u)) {
    return { isRemote: false, host: null, repoSlug: null, raw: u };
  }
  let host = null;
  let repoPath = null;
  const scp = u.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (scp) {
    host = scp[1].toLowerCase();
    repoPath = scp[2];
  } else {
    try {
      const parsed = new URL(u);
      host = parsed.hostname.toLowerCase();
      repoPath = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    } catch {
      return { isRemote: false, host: null, repoSlug: null, raw: u };
    }
  }
  return {
    isRemote: Boolean(host),
    host,
    isGitHub: Boolean(host && (host === "github.com" || host.endsWith(".github.com"))),
    repoSlug: repoPath || null,
    raw: u,
  };
}

export function detectIssueProvider({
  repoDir = process.cwd(),
  mode = "auto",
  providerOverride = "auto",
  execFn = defaultExec,
  allowLocalRemote = process.env.ORCA_ISSUE_ALLOW_LOCAL === "1",
} = {}) {
  if (mode === false || mode === "off" || mode === "disabled") {
    return { enabled: false, provider: null, bin: null, repo: null, reason: "disabled by config" };
  }

  const remoteRes = execFn("git", ["-C", repoDir, "remote", "get-url", "origin"], { cwd: repoDir, timeoutMs: 3000 });
  const remoteUrl = remoteRes.ok ? remoteRes.stdout.trim() : "";
  const remote = parseRemoteHost(remoteUrl);
  if (!remote?.isRemote && !allowLocalRemote) {
    return {
      enabled: false,
      provider: null,
      bin: null,
      repo: null,
      reason: remoteUrl ? `origin is local (${remoteUrl})` : "no git origin remote configured",
    };
  }

  const customCli = process.env.ORCA_ISSUE_CLI || null;
  const order = providerOverride === "gh"
    ? ["gh"]
    : providerOverride === "tea"
      ? ["tea"]
      : (remote?.isGitHub === false ? ["tea", "gh"] : ["gh", "tea"]);

  for (const prov of order) {
    const bin = customCli || prov;
    if (prov === "gh") {
      const ver = execFn(bin, ["--version"], { cwd: repoDir, timeoutMs: 3000 });
      if (!ver.ok) continue;
      const auth = execFn(bin, ["auth", "status"], { cwd: repoDir, timeoutMs: 5000 });
      if (!auth.ok) continue;
      return {
        enabled: true,
        provider: "gh",
        bin,
        repo: remote?.repoSlug || null,
        host: remote?.host || null,
        reason: "gh CLI authenticated",
      };
    }
    if (prov === "tea") {
      const ver = execFn(bin, ["--version"], { cwd: repoDir, timeoutMs: 3000 });
      if (!ver.ok) continue;
      const logins = execFn(bin, ["logins", "list"], { cwd: repoDir, timeoutMs: 5000 });
      if (!logins.ok || !logins.stdout) continue;
      return {
        enabled: true,
        provider: "tea",
        bin,
        repo: remote?.repoSlug || null,
        host: remote?.host || null,
        reason: "tea CLI authenticated",
      };
    }
  }

  return {
    enabled: false,
    provider: null,
    bin: null,
    repo: remote?.repoSlug || null,
    reason: "neither gh nor tea CLI is available & authenticated",
  };
}

/**
 * Parse sub-tasks from BACKLOG_DAG.md, MICRO_PLAN.md, or ROOT_CAUSE.md.
 */
export function parseBacklogTasks(markdown, { maxTasks = 20 } = {}) {
  if (typeof markdown !== "string" || !markdown.trim()) return [];
  const tasks = [];
  const seen = new Set();

  const addTask = ({ id = null, title, owner = null, existingNumber = null }) => {
    const cleanTitle = String(title || "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleanTitle || cleanTitle.length < 4) return;
    // Skip common boilerplate / non-task headings
    if (/^(?:overview|summary|objective|background|assumptions|decisions|verdict|risks?|dependencies|acceptance criteria|testing|notes?|references|dag|architecture|scope|non-goals?)$/i.test(cleanTitle)) {
      return;
    }
    const key = cleanTitle.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    let num = existingNumber;
    if (!num) {
      const m = cleanTitle.match(/#(\d+)\b/);
      if (m) num = Number(m[1]);
    }
    const inferredOwner = owner || (/\b(backend|server|api|db|mysql|sql|python)\b/i.test(cleanTitle)
      ? "backend"
      : /\b(frontend|vue|react|ui|web|css|vite)\b/i.test(cleanTitle)
        ? "frontend"
        : null);

    tasks.push({
      id: id || `T${tasks.length + 1}`,
      title: cleanTitle.slice(0, 140),
      owner: inferredOwner,
      number: num || null,
    });
  };

  const lines = markdown.split(/\r?\n/);
  for (const rawLine of lines) {
    if (tasks.length >= maxTasks) break;
    const line = rawLine.trim();
    if (!line) continue;

    // 1) Markdown table row: | T1 | Task title | owner | ... |
    if (line.startsWith("|") && line.endsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length >= 2 && !cells.every((c) => /^[-:\s]+$/.test(c))) {
        const c0 = cells[0].replace(/[*_`]/g, "").trim();
        const c1 = cells[1].replace(/[*_`]/g, "").trim();
        if (/^(?:id|task|#|step|epic)$/i.test(c0) && /^(?:title|task|name|description|summary)$/i.test(c1)) {
          continue;
        }
        if (/^(?:T\d+|TASK[-_ ]?\d+|BE[-_ ]?\d+|FE[-_ ]?\d+|S\d+|#\d+|\d+)$/i.test(c0) && c1.length >= 4) {
          addTask({ id: c0.replace(/^#/, "T"), title: c1, owner: cells[2] || null });
          continue;
        }
      }
    }

    // 2) Headings: ### T1: Title  or  ### Task 1 - Title  or  ### [BE-1] Title
    const hMatch = line.match(/^#{2,4}\s+(?:\[([A-Za-z0-9_-]+)\]\s*|((?:T|TASK|BE|FE|S)[-_ ]?\d+)\s*[:\-–—.]\s*)(.+)$/);
    if (hMatch) {
      addTask({ id: (hMatch[1] || hMatch[2]).replace(/\s+/g, ""), title: hMatch[3] });
      continue;
    }

    // 3) Task checklist items: - [ ] T1: Title  or  - [ ] Title
    const cbMatch = line.match(/^[-*]\s+\[[ xX]\]\s+(?:(?:\*\*|`)?((?:T|TASK|BE|FE|S)[-_ ]?\d+)(?:\*\*|`)?\s*[:\-–—.]?\s+)?(.+)$/);
    if (cbMatch) {
      addTask({ id: cbMatch[1] ? cbMatch[1].replace(/\s+/g, "") : null, title: cbMatch[2] });
      continue;
    }

    // 4) Numbered or explicit bullet tasks: - **T1**: Title  or  1. **T1** - Title
    const bMatch = line.match(/^(?:[-*]|\d+[.)])\s+(?:\*\*|`)?((?:T|TASK|BE|FE)[-_ ]?\d+)(?:\*\*|`)?\s*[:\-–—.]\s+(.+)$/);
    if (bMatch) {
      addTask({ id: bMatch[1].replace(/\s+/g, ""), title: bMatch[2] });
    }
  }

  return tasks;
}

export function parseIssueNumberFromOutput(text) {
  if (!text) return { number: null, url: null };
  const urlMatch = String(text).match(/https?:\/\/[^\s"'<>]+\/issues\/(\d+)/);
  if (urlMatch) return { number: Number(urlMatch[1]), url: urlMatch[0] };
  const numMatch = String(text).match(/(?:^|\s)#(\d+)\b/);
  if (numMatch) return { number: Number(numMatch[1]), url: null };
  return { number: null, url: null };
}

export function createIssueViaCli({
  provider,
  bin,
  repoDir,
  title,
  body,
  labels = [],
  execFn = defaultExec,
}) {
  const runCreate = (withLabels) => {
    if (provider === "gh") {
      const args = ["issue", "create", "--title", title, "--body", body];
      if (withLabels && labels.length) {
        for (const l of labels) args.push("--label", l);
      }
      return execFn(bin, args, { cwd: repoDir, timeoutMs: 20000 });
    }
    if (provider === "tea") {
      const args = ["issues", "create", "--title", title, "--description", body];
      if (withLabels && labels.length) args.push("--labels", labels.join(","));
      return execFn(bin, args, { cwd: repoDir, timeoutMs: 20000 });
    }
    return { ok: false, stdout: "", stderr: `unsupported provider: ${provider}` };
  };

  let res = runCreate(true);
  if (!res.ok && labels.length) {
    // Retry without labels in case repository hasn't pre-created the label(s)
    res = runCreate(false);
  }
  if (!res.ok) {
    return { ok: false, number: null, url: null, error: res.stderr || res.stdout || res.error || "issue create failed" };
  }
  const parsed = parseIssueNumberFromOutput(res.stdout + "\n" + res.stderr);
  return { ok: parsed.number != null, number: parsed.number, url: parsed.url, raw: res.stdout, error: parsed.number == null ? "could not parse issue number" : null };
}

export function commentIssueViaCli({ provider, bin, repoDir, number, body, execFn = defaultExec }) {
  if (!number) return { ok: false, error: "missing issue number" };
  if (provider === "gh") {
    return execFn(bin, ["issue", "comment", String(number), "--body", body], { cwd: repoDir, timeoutMs: 15000 });
  }
  if (provider === "tea") {
    return execFn(bin, ["comment", String(number), body], { cwd: repoDir, timeoutMs: 15000 });
  }
  return { ok: false, error: `unsupported provider: ${provider}` };
}

export function loadIssueState(artDirAbs) {
  const p = join(artDirAbs, ISSUES_JSON);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export function saveIssueState(artDirAbs, state) {
  mkdirSync(artDirAbs, { recursive: true });
  writeFileSync(join(artDirAbs, ISSUES_JSON), JSON.stringify(state, null, 2) + "\n");
  const lines = [
    "# Issue Traceability (Orca-Pod)",
    "",
    `- **Provider**: \`${state.provider || "none"}\``,
    ...(state.repo ? [`- **Repository**: \`${state.repo}\``] : []),
    ...(state.epic ? [`- **Epic Issue**: #${state.epic.number}${state.epic.url ? ` (${state.epic.url})` : ""} — ${state.epic.title || ""}`] : []),
    `- **Updated At**: ${state.updatedAt || new Date().toISOString()}`,
    "",
  ];
  if (Array.isArray(state.tasks) && state.tasks.length) {
    lines.push("## Linked Sub-Tasks", "", "| Task ID | Issue | Owner | Title |", "| --- | --- | --- | --- |");
    for (const t of state.tasks) {
      const ref = t.number ? (t.url ? `[#${t.number}](${t.url})` : `#${t.number}`) : "(unlinked)";
      lines.push(`| ${t.id} | ${ref} | ${t.owner || "-"} | ${t.title} |`);
    }
    lines.push("");
  }
  const pr = formatIssuePrBlock(state);
  if (pr.issueCloses) {
    lines.push("## PR Linking Trailers", "", "```text", pr.issueCloses, "```", "");
  }
  writeFileSync(join(artDirAbs, ISSUES_MD), lines.join("\n"));
}

export function syncPlanIssues({
  providerInfo,
  config = DEFAULT_ISSUE_TRACKING,
  repoDir,
  artDirAbs,
  objective,
  stepId = "po-backlog",
  artifactPath = null,
  execFn = defaultExec,
  log = () => {},
  warn = () => {},
}) {
  if (!providerInfo?.enabled) return loadIssueState(artDirAbs);

  const existing = loadIssueState(artDirAbs) || {
    provider: providerInfo.provider,
    repo: providerInfo.repo || null,
    objective,
    epic: null,
    tasks: [],
    updatedAt: null,
  };

  // 1) Ensure Epic Issue
  if (!existing.epic) {
    if (config.epicIssue) {
      existing.epic = {
        number: Number(config.epicIssue),
        url: null,
        title: `[Epic] ${objective}`,
        linkedExisting: true,
      };
      log(`[issues] linked existing Epic issue #${existing.epic.number}`);
    } else {
      const epicTitle = `[Epic] ${String(objective || "Orca-Pod Run").slice(0, 120)}`;
      const epicBody = [
        `## Objective`,
        `${objective}`,
        "",
        `## Orchestration Metadata`,
        `- Track Step: \`${stepId}\``,
        `- Created automatically by \`orca-pod\` Issue Traceability Loop`,
        "",
        `_Sub-tasks will be linked below as planning completes._`,
      ].join("\n");
      const labels = [...(config.labels || []), config.epicLabel].filter(Boolean);
      const created = createIssueViaCli({
        provider: providerInfo.provider,
        bin: providerInfo.bin,
        repoDir,
        title: epicTitle,
        body: epicBody,
        labels,
        execFn,
      });
      if (created.ok) {
        existing.epic = { number: created.number, url: created.url, title: epicTitle };
        log(`[issues] created Epic issue #${created.number}${created.url ? ` (${created.url})` : ""}`);
      } else {
        warn(`[issues] failed to create Epic issue: ${created.error}`);
      }
    }
  }

  // 2) Parse sub-tasks from planning artifact and create/link child issues
  const newlyLinked = [];
  if (artifactPath && existsSync(artifactPath)) {
    const md = readFileSync(artifactPath, "utf8");
    const parsed = parseBacklogTasks(md, { maxTasks: config.maxSubtasks ?? 20 });
    const existingByTitle = new Map((existing.tasks || []).map((t) => [t.title.toLowerCase(), t]));
    const taskLabels = [...(config.labels || []), config.taskLabel].filter(Boolean);

    for (const t of parsed) {
      const prev = existingByTitle.get(t.title.toLowerCase());
      if (prev?.number) continue;
      if (t.number) {
        const entry = { ...t, url: null, linkedExisting: true };
        existing.tasks.push(entry);
        existingByTitle.set(t.title.toLowerCase(), entry);
        newlyLinked.push(entry);
        continue;
      }
      const childTitle = `[${t.id}] ${t.title}`.slice(0, 140);
      const childBody = [
        existing.epic?.number ? `Part of Epic #${existing.epic.number}` : "",
        "",
        `### Task Details`,
        `- **Task ID**: \`${t.id}\``,
        ...(t.owner ? [`- **Owner**: \`${t.owner}\``] : []),
        `- **Source Plan**: \`${stepId}\``,
        `- **Objective**: ${objective}`,
      ].filter((x, i) => i > 0 || x !== "").join("\n");

      const created = createIssueViaCli({
        provider: providerInfo.provider,
        bin: providerInfo.bin,
        repoDir,
        title: childTitle,
        body: childBody,
        labels: taskLabels,
        execFn,
      });
      if (created.ok) {
        const entry = { id: t.id, title: t.title, owner: t.owner, number: created.number, url: created.url };
        existing.tasks.push(entry);
        existingByTitle.set(t.title.toLowerCase(), entry);
        newlyLinked.push(entry);
        log(`[issues] created Task issue #${created.number} [${t.id}] ${t.title}`);
      } else {
        warn(`[issues] failed to create Task issue [${t.id}]: ${created.error}`);
      }
    }

    // 3) Post checklist comment on Epic linking newly created child issues
    if (existing.epic?.number && newlyLinked.length) {
      const checklist = [
        `### Linked Sub-Tasks (synced from \`${stepId}\`)`,
        "",
        ...newlyLinked.map((t) => `- [ ] #${t.number} — **${t.id}**: ${t.title}`),
      ].join("\n");
      const c = commentIssueViaCli({
        provider: providerInfo.provider,
        bin: providerInfo.bin,
        repoDir,
        number: existing.epic.number,
        body: checklist,
        execFn,
      });
      if (!c.ok) warn(`[issues] could not post sub-task checklist to Epic #${existing.epic.number}: ${c.stderr || c.error}`);
    }
  }

  existing.provider = providerInfo.provider;
  existing.repo = providerInfo.repo || existing.repo;
  existing.updatedAt = new Date().toISOString();
  saveIssueState(artDirAbs, existing);
  return existing;
}

export function formatIssuePrBlock(state, { closeOnPr = true } = {}) {
  if (!state || (!state.epic?.number && !(state.tasks || []).some((t) => t.number))) {
    return { epicIssue: "", issueRefs: "", issueCloses: "", block: "" };
  }
  const epicNum = state.epic?.number || null;
  const taskNums = (state.tasks || []).map((t) => t.number).filter((n) => Number.isInteger(n) && n > 0 && n !== epicNum);
  const allNums = [...(epicNum ? [epicNum] : []), ...taskNums];
  const epicIssue = epicNum ? `#${epicNum}` : "";
  const issueRefs = allNums.length ? `Refs ${allNums.map((n) => `#${n}`).join(", ")}` : "";

  let issueCloses = "";
  if (closeOnPr) {
    if (taskNums.length) {
      const closesPart = taskNums.map((n) => `Closes #${n}`).join(", ");
      issueCloses = epicNum ? `${closesPart}\nRefs #${epicNum}` : closesPart;
    } else if (epicNum) {
      issueCloses = `Closes #${epicNum}`;
    }
  } else {
    issueCloses = issueRefs;
  }

  const lines = [
    "ISSUE TRACEABILITY (REQUIRED IN PR DESCRIPTION):",
    ...(epicNum ? [`- Epic Issue: #${epicNum}${state.epic?.url ? ` (${state.epic.url})` : ""}`] : []),
    ...(taskNums.length ? [`- Task Issues: ${taskNums.map((n) => `#${n}`).join(", ")}`] : []),
    "- You MUST include the following GitHub/Gitea issue linking lines verbatim in the Pull Request description:",
    ...issueCloses.split("\n").map((l) => `  ${l}`),
  ];

  return { epicIssue, issueRefs, issueCloses, block: lines.join("\n") };
}

// --- Standalone CLI ---
const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0] || "status";
  const getFlag = (name, def = null) => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
  };
  const repoDir = resolve(getFlag("--repo", process.cwd()));
  const artDirAbs = resolve(repoDir, getFlag("--artifacts", ".orca/artifacts"));
  const prov = detectIssueProvider({ repoDir, mode: "auto", providerOverride: getFlag("--provider", "auto") });

  if (cmd === "status") {
    const state = loadIssueState(artDirAbs);
    const out = { provider: prov, state };
    if (args.includes("--json")) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`[orca-issues] provider=${prov.provider || "none"} enabled=${prov.enabled} (${prov.reason})`);
      if (state?.epic) console.log(`[orca-issues] epic=#${state.epic.number} tasks=${(state.tasks || []).length}`);
      else console.log("[orca-issues] no synced ISSUES.json in", artDirAbs);
    }
    process.exit(0);
  }

  if (cmd === "sync") {
    const planPath = getFlag("--plan", join(artDirAbs, "BACKLOG_DAG.md"));
    const objective = getFlag("--objective", "Orca-Pod Backlog Sync");
    const epicRaw = getFlag("--epic-issue", null);
    if (!prov.enabled) {
      console.error(`[orca-issues] cannot sync: ${prov.reason}`);
      process.exit(1);
    }
    const state = syncPlanIssues({
      providerInfo: prov,
      config: { ...DEFAULT_ISSUE_TRACKING, epicIssue: epicRaw ? Number(epicRaw.replace(/^#/, "")) : null },
      repoDir,
      artDirAbs,
      objective,
      stepId: "manual-sync",
      artifactPath: resolve(repoDir, planPath),
      log: (...a) => console.log(...a),
      warn: (...a) => console.warn(...a),
    });
    console.log(JSON.stringify(state, null, 2));
    process.exit(0);
  }

  console.error("Usage: node .orca/issue-tracker.mjs [status|sync] [--repo <dir>] [--plan <file>] [--objective <text>] [--epic-issue <n>] [--json]");
  process.exit(2);
}
