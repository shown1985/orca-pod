#!/usr/bin/env node
// GitHub (gh) / Gitea (tea) Issue + PR full traceability loop for Orca-Pod.
// Auto-detects gh/tea when available, binds explicitly to origin host/repo,
// creates/links Epic & sub-task issues with atomic per-issue persistence,
// scopes ISSUES.json per repo+objective/run, and handles non-default targetBranch (e.g. dev)
// close semantics. Zero external dependencies (Node >= 18).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeText } from "./lib/sanitize.mjs";

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
  defaultBranch: null,
  maxSubtasks: 20,
  planningSteps: ["po-backlog", "micro-plan", "triage-root-cause"],
  prSteps: ["pr-submit", "pr-release-dev"],
};

const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

function hasValidTaskTitleLength(title) {
  if (!title) return false;
  const cjkMatches = title.match(CJK_CHAR_RE);
  if (cjkMatches && cjkMatches.length >= 2) return true;
  return title.length >= 4;
}

export function computeObjectiveHash(objective) {
  return createHash("sha256").update(String(objective || "").trim()).digest("hex").slice(0, 16);
}

export function computeIssueScopeKey({ provider = null, host = null, repo = null, objective = "" } = {}) {
  const normProv = String(provider || "unknown").toLowerCase();
  const normHost = String(host || "local").toLowerCase();
  const normRepo = String(repo || "local").toLowerCase();
  return `${normProv}:${normHost}:${normRepo}:${computeObjectiveHash(objective)}`;
}

function atomicWriteText(destPath, content) {
  mkdirSync(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, destPath);
}

function defaultExec(bin, args, { cwd = process.cwd(), timeoutMs = 15000 } = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", cwd, timeout: timeoutMs });
  const errCode = r.error?.code || null;
  const timedOut = Boolean(
    errCode === "ETIMEDOUT" ||
    r.signal === "SIGTERM" ||
    (r.error && /timed?\s*out/i.test(r.error.message || ""))
  );
  return {
    ok: !r.error && r.status === 0,
    status: r.status ?? (r.error ? -1 : 0),
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    error: r.error ? r.error.message : null,
    timedOut,
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
  if (cfg?.defaults?.defaultBranch && !merged.defaultBranch) {
    merged.defaultBranch = String(cfg.defaults.defaultBranch).trim();
  }
  if (opt.defaultBranch) merged.defaultBranch = String(opt.defaultBranch).trim();
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
    return { isRemote: false, host: null, repoSlug: null, raw: sanitizeText(u, { maxLen: 160 }) };
  }
  let host = null;
  let repoPath = null;
  const scp = u.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (scp) {
    host = scp[1].toLowerCase();
    repoPath = scp[2].replace(/^\/+/, "");
  } else {
    try {
      const parsed = new URL(u);
      host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      repoPath = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    } catch {
      return { isRemote: false, host: null, repoSlug: null, raw: sanitizeText(u, { maxLen: 160 }) };
    }
  }
  return {
    isRemote: Boolean(host),
    host,
    isGitHub: Boolean(host && (host === "github.com" || host.endsWith(".github.com"))),
    repoSlug: repoPath || null,
    raw: sanitizeText(u, { maxLen: 160 }),
  };
}

export function detectRepoDefaultBranch(repoDir = process.cwd(), execFn = defaultExec) {
  const sym = execFn("git", ["-C", repoDir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: repoDir, timeoutMs: 2500 });
  if (sym.ok && sym.stdout) {
    const cleaned = sym.stdout.trim().replace(/^origin\//, "");
    if (cleaned) return cleaned;
  }
  for (const cand of ["main", "master"]) {
    const chk = execFn("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${cand}`], { cwd: repoDir, timeoutMs: 2000 });
    if (chk.ok) return cand;
  }
  return "main";
}

export function detectIssueProvider({
  repoDir = process.cwd(),
  mode = "auto",
  providerOverride = "auto",
  defaultBranchOverride = null,
  execFn = defaultExec,
  allowLocalRemote = process.env.ORCA_ISSUE_ALLOW_LOCAL === "1",
} = {}) {
  if (mode === false || mode === "off" || mode === "disabled") {
    return { enabled: false, provider: null, bin: null, repo: null, host: null, defaultBranch: defaultBranchOverride || "main", reason: "disabled by config" };
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
      host: null,
      defaultBranch: defaultBranchOverride || "main",
      reason: remoteUrl ? `origin is local (${sanitizeText(remoteUrl, { maxLen: 120 })})` : "no git origin remote configured",
    };
  }

  const defaultBranch = defaultBranchOverride || detectRepoDefaultBranch(repoDir, execFn);
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
      // Bind auth check to exact origin host when known
      const authArgs = remote?.host ? ["auth", "status", "--hostname", remote.host] : ["auth", "status"];
      const auth = execFn(bin, authArgs, { cwd: repoDir, timeoutMs: 5000 });
      if (!auth.ok) continue;
      return {
        enabled: true,
        provider: "gh",
        bin,
        repo: remote?.repoSlug || null,
        host: remote?.host || null,
        defaultBranch,
        reason: "gh CLI authenticated",
      };
    }
    if (prov === "tea") {
      const ver = execFn(bin, ["--version"], { cwd: repoDir, timeoutMs: 3000 });
      if (!ver.ok) continue;
      const logins = execFn(bin, ["logins", "list"], { cwd: repoDir, timeoutMs: 5000 });
      if (!logins.ok || !logins.stdout) continue;
      if (remote?.host && !allowLocalRemote && !logins.stdout.toLowerCase().includes(remote.host.toLowerCase())) {
        continue;
      }
      return {
        enabled: true,
        provider: "tea",
        bin,
        repo: remote?.repoSlug || null,
        host: remote?.host || null,
        defaultBranch,
        reason: "tea CLI authenticated",
      };
    }
  }

  return {
    enabled: false,
    provider: null,
    bin: null,
    repo: remote?.repoSlug || null,
    host: remote?.host || null,
    defaultBranch,
    reason: "neither gh nor tea CLI is available & authenticated",
  };
}

/**
 * Parse sub-tasks from BACKLOG_DAG.md, MICRO_PLAN.md, or ROOT_CAUSE.md.
 * Hardened against code fences, checked-off `[x]` items, arbitrary `[bracket]` headings,
 * cross-repo `owner/repo#N` references, and short CJK titles.
 */
export function parseBacklogTasks(markdown, { maxTasks = 20 } = {}) {
  if (typeof markdown !== "string" || !markdown.trim()) return [];
  const tasks = [];
  const seenTitles = new Set();
  const seenIds = new Set();

  const extractLocalIssueNum = (text) => {
    // Only match standalone `#123` (never `owner/repo#123`, `PR#123`, or URLs)
    const m = String(text || "").match(/(?:^|[\s(\[])#(\d+)\b/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  const addTask = ({ id = null, title, owner = null, existingNumber = null }) => {
    const cleanTitle = String(title || "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!hasValidTaskTitleLength(cleanTitle)) return;
    // Skip common boilerplate / non-task headings
    if (/^(?:overview|summary|objective|background|assumptions|decisions|verdict|risks?|dependencies|acceptance criteria|testing|notes?|references|dag|architecture|scope|non-goals?)$/i.test(cleanTitle)) {
      return;
    }
    const normId = id ? String(id).trim().replace(/\s+/g, "") : null;
    if (normId && seenIds.has(normId.toLowerCase())) return;
    const titleKey = cleanTitle.toLowerCase();
    if (seenTitles.has(titleKey)) return;
    seenTitles.add(titleKey);
    if (normId) seenIds.add(normId.toLowerCase());

    const num = (Number.isInteger(existingNumber) && existingNumber > 0)
      ? existingNumber
      : extractLocalIssueNum(cleanTitle);

    const inferredOwner = owner || (/\b(backend|server|api|db|mysql|sql|python)\b|(?:后端|数据库|建表|迁移|接口)/i.test(cleanTitle)
      ? "backend"
      : /\b(frontend|vue|react|ui|web|css|vite)\b|(?:前端|页面|组件|界面|登录页)/i.test(cleanTitle)
        ? "frontend"
        : null);

    tasks.push({
      id: normId || `T${tasks.length + 1}`,
      title: cleanTitle.slice(0, 140),
      owner: inferredOwner,
      number: num || null,
    });
  };

  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  for (const rawLine of lines) {
    if (tasks.length >= maxTasks) break;
    const trimmedFence = rawLine.trimStart();
    const fm = trimmedFence.match(/^(`{3,}|~{3,})/);
    if (fm) {
      const ch = fm[1][0];
      const len = fm[1].length;
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        fenceLen = len;
        continue;
      } else if (ch === fenceChar && len >= fenceLen && trimmedFence.slice(len).trim() === "") {
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
        continue;
      }
    }
    if (inFence) continue;

    const line = rawLine.trim();
    if (!line) continue;

    // 1) Markdown table row: | T1 | Task title | owner | ... |
    if (line.startsWith("|") && line.endsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length >= 2 && !cells.every((c) => /^[-:\s]+$/.test(c))) {
        const c0 = cells[0].replace(/[*_`]/g, "").trim();
        const c1 = cells[1].replace(/[*_`]/g, "").trim();
        if (/^(?:id|task|#|step|epic|编号|任务)$/i.test(c0) && /^(?:title|task|name|description|summary|标题|任务|名称|说明)$/i.test(c1)) {
          continue;
        }
        if (/^(?:T\d+|TASK[-_ ]?\d+|BE[-_ ]?\d+|FE[-_ ]?\d+|S\d+|#\d+|\d+)$/i.test(c0) && hasValidTaskTitleLength(c1)) {
          const explicitNum = /^#(\d+)$/.test(c0) ? Number(c0.slice(1)) : null;
          addTask({ id: c0.replace(/^#/, "T"), title: c1, owner: cells[2] || null, existingNumber: explicitNum });
          continue;
        }
      }
    }

    // 2) Headings with explicit Task IDs ONLY: ### T1: Title | ### Task 1 - Title | ### [BE-1] Title
    const hMatch = line.match(/^#{2,4}\s+(?:\[((?:T|TASK|BE|FE|S|SUBTASK)[-_ ]?\d+)\]\s*[:\-–—.]?\s*|((?:T|TASK|BE|FE|S|SUBTASK)[-_ ]?\d+)\s*[:\-–—.]\s*)(.+)$/i);
    if (hMatch) {
      addTask({ id: (hMatch[1] || hMatch[2]).replace(/\s+/g, ""), title: hMatch[3] });
      continue;
    }

    // 3) Unchecked / in-progress task checklist items ONLY (skip already-completed `- [x]`)
    const cbMatch = line.match(/^[-*]\s+\[[ ~]\]\s+(?:(?:\*\*|`)?((?:T|TASK|BE|FE|S|SUBTASK)[-_ ]?\d+)(?:\*\*|`)?\s*[:\-–—.]?\s+)?(.+)$/i);
    if (cbMatch) {
      addTask({ id: cbMatch[1] ? cbMatch[1].replace(/\s+/g, "") : null, title: cbMatch[2] });
      continue;
    }

    // 4) Numbered or explicit bullet tasks: - **T1**: Title  or  1. **T1** - Title
    const bMatch = line.match(/^(?:[-*]|\d+[.)])\s+(?:\*\*|`)?((?:T|TASK|BE|FE|SUBTASK)[-_ ]?\d+)(?:\*\*|`)?\s*[:\-–—.]\s+(.+)$/i);
    if (bMatch) {
      addTask({ id: bMatch[1].replace(/\s+/g, ""), title: bMatch[2] });
    }
  }

  return tasks;
}

export function parseIssueNumberFromOutput(text) {
  if (!text) return { number: null, url: null };
  const urlMatch = String(text).match(/https?:\/\/[^\s"'<>]+\/issues\/(\d+)/);
  if (urlMatch) {
    const n = Number(urlMatch[1]);
    return { number: Number.isInteger(n) && n > 0 ? n : null, url: urlMatch[0] };
  }
  const numMatch = String(text).match(/(?:^|\s)#(\d+)\b/);
  if (numMatch) {
    const n = Number(numMatch[1]);
    return { number: Number.isInteger(n) && n > 0 ? n : null, url: null };
  }
  return { number: null, url: null };
}

export function isMissingLabelError(stderr = "", stdout = "", timedOut = false) {
  if (timedOut) return false;
  const combined = `${stderr}\n${stdout}`;
  return /label.*(?:not found|does not exist|invalid|unknown|cannot find|could not add|not exist)|(?:not found|does not exist|unknown).*label|\b422\b.*label/i.test(combined);
}

function buildGhRepoSelector(host, repo) {
  if (!repo) return null;
  if (host && host !== "github.com" && !repo.includes(host)) return `${host}/${repo}`;
  return repo;
}

export function createIssueViaCli({
  provider,
  bin,
  repoDir,
  repo = null,
  host = null,
  title,
  body,
  labels = [],
  execFn = defaultExec,
}) {
  const runCreate = (withLabels) => {
    if (provider === "gh") {
      const args = ["issue", "create"];
      const repoSel = buildGhRepoSelector(host, repo);
      if (repoSel) args.push("--repo", repoSel);
      args.push("--title", title, "--body", body);
      if (withLabels && labels.length) {
        for (const l of labels) args.push("--label", l);
      }
      return execFn(bin, args, { cwd: repoDir, timeoutMs: 20000 });
    }
    if (provider === "tea") {
      const args = ["issues", "create"];
      if (repo) args.push("--repo", repo);
      args.push("--title", title, "--description", body);
      if (withLabels && labels.length) args.push("--labels", labels.join(","));
      return execFn(bin, args, { cwd: repoDir, timeoutMs: 20000 });
    }
    return { ok: false, stdout: "", stderr: `unsupported provider: ${provider}`, timedOut: false };
  };

  let res = runCreate(true);
  // ONLY retry without labels when the CLI explicitly rejected an unknown/missing label (never on timeouts or network errors)
  if (!res.ok && labels.length && isMissingLabelError(res.stderr, res.stdout, res.timedOut)) {
    res = runCreate(false);
  }
  if (!res.ok) {
    const rawErr = res.stderr || res.stdout || res.error || "issue create failed";
    return { ok: false, number: null, url: null, error: sanitizeText(rawErr, { maxLen: 240 }) };
  }
  const parsed = parseIssueNumberFromOutput(`${res.stdout}\n${res.stderr}`);
  return {
    ok: parsed.number != null,
    number: parsed.number,
    url: parsed.url,
    raw: sanitizeText(res.stdout, { maxLen: 240 }),
    error: parsed.number == null ? "could not parse issue number" : null,
  };
}

export function commentIssueViaCli({ provider, bin, repoDir, repo = null, host = null, number, body, execFn = defaultExec }) {
  if (!Number.isInteger(Number(number)) || Number(number) <= 0) return { ok: false, error: "missing or invalid issue number" };
  if (provider === "gh") {
    const args = ["issue", "comment", String(number)];
    const repoSel = buildGhRepoSelector(host, repo);
    if (repoSel) args.push("--repo", repoSel);
    args.push("--body", body);
    const r = execFn(bin, args, { cwd: repoDir, timeoutMs: 15000 });
    return { ...r, stderr: sanitizeText(r.stderr, { maxLen: 240 }) };
  }
  if (provider === "tea") {
    const args = ["comment"];
    if (repo) args.push("--repo", repo);
    args.push(String(number), body);
    const r = execFn(bin, args, { cwd: repoDir, timeoutMs: 15000 });
    return { ...r, stderr: sanitizeText(r.stderr, { maxLen: 240 }) };
  }
  return { ok: false, error: `unsupported provider: ${provider}` };
}

function normalizeLoadedState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = { ...raw };
  if (out.epic != null) {
    const en = Number(out.epic?.number);
    if (!Number.isInteger(en) || en <= 0) {
      out.epic = null;
    } else {
      out.epic = { ...out.epic, number: en };
    }
  }
  if (Array.isArray(out.tasks)) {
    out.tasks = out.tasks
      .filter((t) => t && typeof t === "object" && (typeof t.title === "string" || Number.isInteger(Number(t.number))))
      .map((t) => {
        const tn = Number(t.number);
        return {
          ...t,
          number: Number.isInteger(tn) && tn > 0 ? tn : null,
        };
      });
  } else {
    out.tasks = [];
  }
  return out;
}

/**
 * Load `ISSUES.json` from `artDirAbs`, validating positive integer issue numbers and
 * optionally enforcing run/repo/objective scope isolation so stale runs never leak.
 */
export function loadIssueState(artDirAbs, matchScope = null) {
  if (matchScope && (matchScope.mode === false || matchScope.mode === "off" || matchScope.mode === "disabled")) {
    return null;
  }
  const p = join(artDirAbs, ISSUES_JSON);
  if (!existsSync(p)) return null;
  let parsed = null;
  try { parsed = normalizeLoadedState(JSON.parse(readFileSync(p, "utf8"))); } catch { return null; }
  if (!parsed) return null;

  if (matchScope && typeof matchScope === "object") {
    if (matchScope.provider && parsed.provider && parsed.provider !== matchScope.provider) return null;
    if (matchScope.repo && parsed.repo && parsed.repo.toLowerCase() !== matchScope.repo.toLowerCase()) return null;
    if (matchScope.host && parsed.host && parsed.host.toLowerCase() !== matchScope.host.toLowerCase()) return null;
    if (matchScope.epicIssue != null) {
      const wantEpic = Number(matchScope.epicIssue);
      if (Number.isInteger(wantEpic) && wantEpic > 0 && parsed.epic?.number && parsed.epic.number !== wantEpic) {
        return null;
      }
    }
    if (matchScope.objective != null && String(matchScope.objective).trim()) {
      const wantHash = computeObjectiveHash(matchScope.objective);
      if (parsed.objectiveHash && parsed.objectiveHash !== wantHash) return null;
      if (!parsed.objectiveHash && parsed.objective && parsed.objective.trim() !== String(matchScope.objective).trim()) return null;
    }
  }
  return parsed;
}

export function saveIssueState(artDirAbs, state) {
  mkdirSync(artDirAbs, { recursive: true });
  const normalized = normalizeLoadedState(state) || { tasks: [] };
  normalized.updatedAt = normalized.updatedAt || new Date().toISOString();
  atomicWriteText(join(artDirAbs, ISSUES_JSON), JSON.stringify(normalized, null, 2) + "\n");

  const lines = [
    "# Issue Traceability (Orca-Pod)",
    "",
    `- **Provider**: \`${normalized.provider || "none"}\``,
    ...(normalized.repo ? [`- **Repository**: \`${normalized.repo}\``] : []),
    ...(normalized.defaultBranch ? [`- **Default Branch**: \`${normalized.defaultBranch}\``] : []),
    ...(normalized.epic ? [`- **Epic Issue**: #${normalized.epic.number}${normalized.epic.url ? ` (${normalized.epic.url})` : ""} — ${normalized.epic.title || ""}`] : []),
    `- **Updated At**: ${normalized.updatedAt}`,
    "",
  ];
  if (Array.isArray(normalized.tasks) && normalized.tasks.length) {
    lines.push("## Linked Sub-Tasks", "", "| Task ID | Issue | Owner | Title |", "| --- | --- | --- | --- |");
    for (const t of normalized.tasks) {
      const ref = t.number ? (t.url ? `[#${t.number}](${t.url})` : `#${t.number}`) : "(unlinked)";
      lines.push(`| ${t.id} | ${ref} | ${t.owner || "-"} | ${t.title} |`);
    }
    lines.push("");
  }
  const pr = formatIssuePrBlock(normalized, { defaultBranch: normalized.defaultBranch || "main" });
  if (pr.issueCloses) {
    lines.push("## PR Linking Trailers", "", "```text", pr.issueCloses, "```", "");
  }
  atomicWriteText(join(artDirAbs, ISSUES_MD), lines.join("\n"));
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
  if (config?.mode === false) return null;
  const matchScope = {
    mode: config?.mode ?? "auto",
    provider: providerInfo?.provider || null,
    host: providerInfo?.host || null,
    repo: providerInfo?.repo || null,
    objective,
    epicIssue: config?.epicIssue ?? null,
  };
  if (!providerInfo?.enabled) return loadIssueState(artDirAbs, matchScope);

  const safeObj = sanitizeText(String(objective || "Orca-Pod Run"), { maxLen: 240 });
  const objHash = computeObjectiveHash(objective);
  const scopeKey = computeIssueScopeKey({
    provider: providerInfo.provider,
    host: providerInfo.host,
    repo: providerInfo.repo,
    objective,
  });

  const existing = loadIssueState(artDirAbs, matchScope) || {
    schemaVersion: 2,
    scopeKey,
    provider: providerInfo.provider,
    host: providerInfo.host || null,
    repo: providerInfo.repo || null,
    defaultBranch: providerInfo.defaultBranch || config.defaultBranch || "main",
    objective: safeObj,
    objectiveHash: objHash,
    epic: null,
    tasks: [],
    updatedAt: null,
  };
  existing.schemaVersion = 2;
  existing.scopeKey = scopeKey;
  existing.provider = providerInfo.provider;
  existing.host = providerInfo.host || existing.host || null;
  existing.repo = providerInfo.repo || existing.repo || null;
  existing.defaultBranch = providerInfo.defaultBranch || config.defaultBranch || existing.defaultBranch || "main";
  existing.objective = safeObj;
  existing.objectiveHash = objHash;

  const persistNow = () => {
    existing.updatedAt = new Date().toISOString();
    saveIssueState(artDirAbs, existing);
  };

  // 1) Ensure Epic Issue (and persist immediately before creating child issues!)
  const explicitEpicNum = Number(config.epicIssue);
  if (Number.isInteger(explicitEpicNum) && explicitEpicNum > 0 && existing.epic?.number !== explicitEpicNum) {
    existing.epic = {
      number: explicitEpicNum,
      url: null,
      title: `[Epic] ${safeObj.slice(0, 120)}`,
      linkedExisting: true,
    };
    persistNow();
    log(`[issues] linked existing Epic issue #${existing.epic.number}`);
  } else if (!existing.epic) {
    const epicTitle = `[Epic] ${safeObj.slice(0, 120)}`;
    const epicBody = [
      `## Objective`,
      `${safeObj}`,
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
      repo: providerInfo.repo,
      host: providerInfo.host,
      title: epicTitle,
      body: epicBody,
      labels,
      execFn,
    });
    if (created.ok) {
      existing.epic = { number: created.number, url: created.url, title: epicTitle };
      persistNow();
      log(`[issues] created Epic issue #${created.number}${created.url ? ` (${created.url})` : ""}`);
    } else {
      warn(`[issues] failed to create Epic issue: ${created.error}`);
    }
  }

  // 2) Parse sub-tasks from planning artifact and create/link child issues atomically one-by-one
  const newlyLinked = [];
  if (artifactPath && existsSync(artifactPath)) {
    const md = readFileSync(artifactPath, "utf8");
    const parsed = parseBacklogTasks(md, { maxTasks: config.maxSubtasks ?? 20 });
    const existingByTitle = new Map((existing.tasks || []).map((t) => [t.title.toLowerCase(), t]));
    const existingById = new Map((existing.tasks || []).filter((t) => t.id).map((t) => [String(t.id).toLowerCase(), t]));
    const taskLabels = [...(config.labels || []), config.taskLabel].filter(Boolean);

    for (const t of parsed) {
      const safeTaskTitle = sanitizeText(t.title, { maxLen: 140 });
      const prev = existingById.get(String(t.id).toLowerCase()) || existingByTitle.get(safeTaskTitle.toLowerCase());
      if (prev?.number) continue;
      if (t.number) {
        const entry = { ...t, title: safeTaskTitle, url: null, linkedExisting: true };
        existing.tasks.push(entry);
        existingByTitle.set(safeTaskTitle.toLowerCase(), entry);
        existingById.set(String(t.id).toLowerCase(), entry);
        newlyLinked.push(entry);
        persistNow();
        continue;
      }
      const childTitle = `[${t.id}] ${safeTaskTitle}`.slice(0, 140);
      const childBody = [
        existing.epic?.number ? `Part of Epic #${existing.epic.number}` : "",
        "",
        `### Task Details`,
        `- **Task ID**: \`${t.id}\``,
        ...(t.owner ? [`- **Owner**: \`${t.owner}\``] : []),
        `- **Source Plan**: \`${stepId}\``,
        `- **Objective**: ${safeObj}`,
      ].filter((x, i) => i > 0 || x !== "").join("\n");

      const created = createIssueViaCli({
        provider: providerInfo.provider,
        bin: providerInfo.bin,
        repoDir,
        repo: providerInfo.repo,
        host: providerInfo.host,
        title: childTitle,
        body: childBody,
        labels: taskLabels,
        execFn,
      });
      if (created.ok) {
        const entry = { id: t.id, title: safeTaskTitle, owner: t.owner, number: created.number, url: created.url };
        existing.tasks.push(entry);
        existingByTitle.set(safeTaskTitle.toLowerCase(), entry);
        existingById.set(String(t.id).toLowerCase(), entry);
        newlyLinked.push(entry);
        persistNow();
        log(`[issues] created Task issue #${created.number} [${t.id}] ${safeTaskTitle}`);
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
        repo: providerInfo.repo,
        host: providerInfo.host,
        number: existing.epic.number,
        body: checklist,
        execFn,
      });
      if (!c.ok) warn(`[issues] could not post sub-task checklist to Epic #${existing.epic.number}: ${c.stderr || c.error}`);
    }
  }

  persistNow();
  return existing;
}

export function formatIssuePrBlock(state, {
  closeOnPr = true,
  targetBranch = "dev",
  defaultBranch = "main",
  provider = null,
  repo = null,
} = {}) {
  const norm = normalizeLoadedState(state);
  if (!norm || (!norm.epic?.number && !(norm.tasks || []).some((t) => t.number))) {
    return { epicIssue: "", issueRefs: "", issueCloses: "", nonDefaultBranchGuidance: "", block: "" };
  }
  const epicNum = norm.epic?.number || null;
  const taskNums = (norm.tasks || []).map((t) => t.number).filter((n) => Number.isInteger(n) && n > 0 && n !== epicNum);
  const allNums = [...(epicNum ? [epicNum] : []), ...taskNums];
  const epicIssue = epicNum ? `#${epicNum}` : "";
  const issueRefs = allNums.length ? `Refs ${allNums.map((n) => `#${n}`).join(", ")}` : "";

  let issueCloses = "";
  const closeTargets = taskNums.length ? taskNums : (epicNum ? [epicNum] : []);
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

  const effDefault = defaultBranch || norm.defaultBranch || "main";
  const effProv = provider || norm.provider || "gh";
  const effRepo = repo || norm.repo || null;
  const isNonDefaultTarget = Boolean(targetBranch && effDefault && targetBranch !== effDefault);

  let nonDefaultBranchGuidance = "";
  if (closeOnPr && isNonDefaultTarget && closeTargets.length) {
    const repoFlag = effRepo ? ` --repo "${effRepo}"` : "";
    const closeCmds = effProv === "tea"
      ? closeTargets.map((n) => `tea issues close${repoFlag} ${n}`).join(" && ")
      : closeTargets.map((n) => `gh issue close ${n}${repoFlag} --comment "Merged to ${targetBranch} via PR #<pr_number>"`).join(" && ");
    nonDefaultBranchGuidance = [
      `NON-DEFAULT TARGET BRANCH ISSUE CLOSE RULE (\`${targetBranch}\` != default branch \`${effDefault}\`):`,
      `- GitHub/Gitea \`Closes #N\` keywords only auto-close issues when merged into the repository's default branch (\`${effDefault}\`).`,
      `- Keep \`${issueCloses.replace(/\n/g, " / ")}\` in the PR description for timeline traceability AND future \`${targetBranch} -> ${effDefault}\` release tracking.`,
      `- ONLY AFTER confirming the PR is actually MERGED into \`${targetBranch}\` (\`Merge-Status: MERGED\`, NEVER when held for \`PENDING_HUMAN_MERGE\`), explicitly close the completed issue(s) via CLI:`,
      `  \`${closeCmds}\``,
    ].join("\n");
  }

  const lines = [
    "ISSUE TRACEABILITY (REQUIRED IN PR DESCRIPTION):",
    ...(epicNum ? [`- Epic Issue: #${epicNum}${norm.epic?.url ? ` (${norm.epic.url})` : ""}`] : []),
    ...(taskNums.length ? [`- Task Issues: ${taskNums.map((n) => `#${n}`).join(", ")}`] : []),
    "- You MUST include the following GitHub/Gitea issue linking lines verbatim in the Pull Request description:",
    ...issueCloses.split("\n").map((l) => `  ${l}`),
    ...(nonDefaultBranchGuidance ? ["", nonDefaultBranchGuidance] : []),
  ];

  return {
    epicIssue,
    issueRefs,
    issueCloses,
    nonDefaultBranchGuidance,
    targetsDefaultBranch: !isNonDefaultTarget,
    block: lines.join("\n"),
  };
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
