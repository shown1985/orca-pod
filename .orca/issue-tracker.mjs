#!/usr/bin/env node
// GitHub (gh) / Gitea (tea) Issue + PR full traceability loop for Orca-Pod.
// Auto-detects gh/tea when available, binds explicitly to origin host/repo/login,
// creates/links Epic & sub-task issues with atomic per-issue persistence,
// scopes ISSUES.json per run+repo+host+objective+epic (rejecting legacy unscoped files),
// and handles non-default or unverified defaultBranch close semantics.
// Zero external dependencies (Node >= 18).

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
const TRANSPORT_ERR_RE = /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|TLS|SSL|network error|connection refused|connection reset|dial tcp|50[0234]\b|bad gateway|service unavailable|gateway timeout)\b/i;

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
  if (u.startsWith("/") || u.startsWith("./") || u.startsWith("../") || u.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(u)) {
    return { isRemote: false, host: null, origin: null, basePath: "", repoSlug: null, raw: sanitizeText(u, { maxLen: 160 }) };
  }
  let host = null;
  let origin = null;
  let basePath = "";
  let repoPath = null;
  const scp = u.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (scp) {
    host = scp[1].toLowerCase();
    repoPath = scp[2].replace(/^\/+/, "");
  } else {
    try {
      const parsed = new URL(u);
      host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (/^https?:$/i.test(parsed.protocol)) {
        origin = parsed.origin.toLowerCase();
      }
      const cleanPath = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
      const segs = cleanPath.split("/").filter(Boolean);
      if (segs.length > 2 && host !== "github.com" && !host.endsWith(".github.com")) {
        basePath = "/" + segs.slice(0, -2).join("/");
        repoPath = segs.slice(-2).join("/");
      } else {
        repoPath = cleanPath;
      }
    } catch {
      return { isRemote: false, host: null, origin: null, basePath: "", repoSlug: null, raw: sanitizeText(u, { maxLen: 160 }) };
    }
  }
  return {
    isRemote: Boolean(host),
    host,
    origin,
    basePath,
    isGitHub: Boolean(host && (host === "github.com" || host.endsWith(".github.com"))),
    repoSlug: repoPath || null,
    raw: sanitizeText(u, { maxLen: 160 }),
  };
}

export function buildGhRepoSelector(host, repo) {
  if (!repo) return null;
  if (host && host !== "github.com" && !repo.startsWith(`${host}/`)) return `${host}/${repo}`;
  return repo;
}

function normalizeBasePath(bp) {
  const s = String(bp || "").trim().replace(/\/+$/, "");
  if (!s || s === "/") return "";
  return s.startsWith("/") ? s : `/${s}`;
}

/**
 * Parse `tea logins list` table/plain output to find a login entry whose server URL
 * matches BOTH `targetOrigin`/`targetHost` AND `targetBasePath` (refusing mismatched
 * basePaths or ambiguous multi-basePath host conflicts!).
 */
export function matchTeaLoginForHost(stdoutText, targetHost = null, targetOrigin = null, targetBasePath = null) {
  const lines = String(stdoutText || "").split(/\r?\n/);
  const entries = [];
  for (const rawLine of lines) {
    const urlMatch = rawLine.match(/https?:\/\/[^\s|│]+/i);
    if (!urlMatch) continue;
    let parsed = null;
    try {
      parsed = new URL(urlMatch[0]);
    } catch {
      continue;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const entryOrigin = parsed.origin.toLowerCase();
    const entryBasePath = normalizeBasePath(parsed.pathname);
    const cols = rawLine
      .split(/[|│]/)
      .map((c) => c.trim())
      .filter((c) => c && !/^[─━┌┐└┘├┤┬┴┼+-]+$/.test(c));
    let loginName = null;
    if (cols.length >= 2 && !/^https?:\/\//i.test(cols[0]) && !/^name$/i.test(cols[0])) {
      loginName = cols[0];
    } else {
      const tokens = rawLine.trim().split(/\s+/);
      if (tokens.length >= 2 && !/^https?:\/\//i.test(tokens[0]) && !/^name$/i.test(tokens[0])) {
        loginName = tokens[0];
      }
    }
    if (loginName && hostname) {
      entries.push({ login: loginName, host: hostname, origin: entryOrigin, basePath: entryBasePath, url: urlMatch[0] });
    }
  }

  const pickUnambiguous = (cands) => {
    if (!cands.length) return null;
    if (targetBasePath !== null && targetBasePath !== undefined) {
      const wantBp = normalizeBasePath(targetBasePath);
      const bpMatches = cands.filter((e) => e.basePath === wantBp);
      if (!bpMatches.length) return null;
      const distinctOrigins = new Set(bpMatches.map((e) => e.origin));
      if (distinctOrigins.size > 1) return null;
      return bpMatches[0];
    }
    // When `targetBasePath` is unknown (e.g. SCP remote without scheme/port), refuse if logins disagree on origin or basePath!
    const distinctTargets = new Set(cands.map((e) => `${e.origin}|${e.basePath}`));
    if (distinctTargets.size > 1) return null;
    return cands[0];
  };

  if (targetOrigin) {
    const wantOrigin = String(targetOrigin).trim().replace(/\/+$/, "").toLowerCase();
    return pickUnambiguous(entries.filter((e) => e.origin === wantOrigin));
  }
  if (!targetHost) return pickUnambiguous(entries);
  const want = String(targetHost).trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (want.includes(":")) {
    return pickUnambiguous(entries.filter((e) => { try { return new URL(e.url).host.toLowerCase() === want; } catch { return false; } }));
  }
  return pickUnambiguous(entries.filter((e) => e.host === want));
}

/**
 * Resolve the repository's verified default branch WITHOUT blindly guessing `main` or `master`!
 * Checks `refs/remotes/origin/HEAD` first, then `gh repo view --json defaultBranchRef` when available;
 * returns `null` if unverified.
 */
export function detectRepoDefaultBranch(repoDir = process.cwd(), execOrOpts = defaultExec, extraOpts = {}) {
  const execFn = typeof execOrOpts === "function" ? execOrOpts : (execOrOpts?.execFn || defaultExec);
  const opts = typeof execOrOpts === "object" && execOrOpts !== null ? execOrOpts : (extraOpts || {});
  const sym = execFn("git", ["-C", repoDir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: repoDir, timeoutMs: 2500 });
  if (sym.ok && sym.stdout) {
    const cleaned = sym.stdout.trim().replace(/^origin\//, "");
    if (cleaned) return cleaned;
  }
  if (opts.provider === "gh" && opts.bin && opts.repo) {
    const repoSel = buildGhRepoSelector(opts.host || null, opts.repo);
    const view = execFn(opts.bin, ["repo", "view", repoSel, "--json", "defaultBranchRef"], { cwd: repoDir, timeoutMs: 5000 });
    if (view.ok && view.stdout) {
      try {
        const parsed = JSON.parse(view.stdout);
        const name = parsed?.defaultBranchRef?.name;
        if (typeof name === "string" && name.trim()) return name.trim();
      } catch {}
    }
  }
  return null;
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
    return { enabled: false, provider: null, bin: null, repo: null, host: null, teaLogin: null, defaultBranch: defaultBranchOverride || null, reason: "disabled by config" };
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
      teaLogin: null,
      defaultBranch: defaultBranchOverride || null,
      reason: remoteUrl ? `origin is local (${sanitizeText(remoteUrl, { maxLen: 120 })})` : "no git origin remote configured",
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
      const authArgs = remote?.host ? ["auth", "status", "--hostname", remote.host] : ["auth", "status"];
      const auth = execFn(bin, authArgs, { cwd: repoDir, timeoutMs: 5000 });
      if (!auth.ok) continue;
      const defaultBranch = defaultBranchOverride || detectRepoDefaultBranch(repoDir, execFn, {
        provider: "gh",
        bin,
        host: remote?.host || null,
        repo: remote?.repoSlug || null,
      });
      return {
        enabled: true,
        provider: "gh",
        bin,
        repo: remote?.repoSlug || null,
        host: remote?.host || null,
        origin: remote?.origin || null,
        basePath: remote?.basePath || "",
        teaLogin: null,
        defaultBranch,
        reason: "gh CLI authenticated",
      };
    }
    if (prov === "tea") {
      const ver = execFn(bin, ["--version"], { cwd: repoDir, timeoutMs: 3000 });
      if (!ver.ok) continue;
      const logins = execFn(bin, ["logins", "list"], { cwd: repoDir, timeoutMs: 5000 });
      if (!logins.ok || !logins.stdout) continue;
      const expectedBp = remote?.origin ? (remote?.basePath ?? "") : (remote?.basePath ? remote.basePath : null);
      const matchedLogin = matchTeaLoginForHost(logins.stdout, remote?.host || null, remote?.origin || null, expectedBp);
      if (remote?.host && !allowLocalRemote && !matchedLogin) {
        continue;
      }
      const defaultBranch = defaultBranchOverride || detectRepoDefaultBranch(repoDir, execFn, {
        provider: "tea",
        bin,
        host: remote?.host || null,
        repo: remote?.repoSlug || null,
      });
      return {
        enabled: true,
        provider: "tea",
        bin,
        repo: remote?.repoSlug || null,
        host: remote?.host || null,
        origin: matchedLogin?.origin || remote?.origin || null,
        basePath: matchedLogin?.basePath ?? remote?.basePath ?? "",
        teaLogin: matchedLogin?.login || null,
        defaultBranch,
        reason: "tea CLI authenticated",
      };
    }
  }

  const fallbackDefault = defaultBranchOverride || detectRepoDefaultBranch(repoDir, execFn);
  return {
    enabled: false,
    provider: null,
    bin: null,
    repo: remote?.repoSlug || null,
    host: remote?.host || null,
    teaLogin: null,
    defaultBranch: fallbackDefault,
    reason: "neither gh nor tea CLI is available & authenticated",
  };
}

function normalizeMarkdownRefKey(k) {
  return String(k || "").trim().replace(/\s+/g, " ").toLowerCase();
}

const MULTILINE_MD_REF_DEF_RE = /^[ \t]{0,3}\[((?:\\.|[^\[\]\\]){1,999})\]:[ \t]*(?:\r?\n[ \t]*)?<?([^\s>\[\]]+)>?(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)\r\n]*\)))?[ \t]*$/gm;

function stripFencedBlocksForRefs(markdown) {
  const out = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const unq = rawLine.replace(/^\s*(?:>\s*)+/, "");
    const tf = unq.trimStart();
    const fm = tf.match(/^(`{3,}|~{3,})/);
    if (fm) {
      const ch = fm[1][0];
      const len = fm[1].length;
      if (!inFence) { inFence = true; fenceChar = ch; fenceLen = len; continue; }
      if (ch === fenceChar && len >= fenceLen && tf.slice(len).trim() === "") { inFence = false; fenceChar = ""; fenceLen = 0; continue; }
    }
    if (!inFence) out.push(rawLine);
  }
  return out.join("\n");
}

export function parseMarkdownRefDefinitions(markdown) {
  const defs = new Map();
  if (typeof markdown !== "string" || !markdown) return defs;
  const unfenced = stripFencedBlocksForRefs(markdown);
  const re = new RegExp(MULTILINE_MD_REF_DEF_RE.source, "gm");
  let m = null;
  while ((m = re.exec(unfenced)) !== null) {
    const rawLabel = m[1];
    // CommonMark link labels cannot contain blank lines
    if (/\r?\n[ \t]*\r?\n/.test(rawLabel)) continue;
    const key = normalizeMarkdownRefKey(rawLabel);
    const url = (m[2] || "").trim();
    if (key && url && !defs.has(key)) {
      defs.set(key, url);
    }
  }
  return defs;
}

/**
 * Extract an explicit current-repo issue linkage marker from a task title.
 * Plain prose numbers like `"Retry step #2"`, cross-repo `"owner/repo#17"`, inline Markdown links
 * `[Issue #42](https://github.com/other/repo/issues/42)`, or reference-style Markdown links
 * `[Issue #42][upstream]` pointing to external repositories are NEVER treated as local issues!
 */
export function extractExplicitLocalIssueNumber(text, { currentHost = null, currentRepo = null, refDefs = null } = {}) {
  const srcText = String(text || "");
  const effectiveRefs = refDefs instanceof Map ? refDefs : parseMarkdownRefDefinitions(srcText);
  let linkedSameRepoNum = null;

  const inspectResolvedLink = (label, rawUrl) => {
    const cleanUrl = String(rawUrl || "").trim().replace(/^<|>$/g, "").split(/\s+/)[0] || "";
    const issueUrlMatch = cleanUrl.match(/^https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i);
    if (issueUrlMatch && currentRepo) {
      const linkHost = issueUrlMatch[1].replace(/^\[|\]$/g, "").toLowerCase();
      const linkRepo = issueUrlMatch[2].replace(/\.git$/i, "").toLowerCase();
      const wantRepo = String(currentRepo).toLowerCase();
      const hostOk = !currentHost || linkHost === String(currentHost).replace(/^\[|\]$/g, "").toLowerCase();
      if (hostOk && linkRepo === wantRepo) {
        const n = Number(issueUrlMatch[3]);
        if (Number.isInteger(n) && n > 0 && linkedSameRepoNum == null) linkedSameRepoNum = n;
        return label;
      }
    }
    // External or non-issue URL: strip `#<digits>` inside the link label so external `#42` never leaks!
    return String(label || "").replace(/#\d+\b/g, "");
  };

  // Remove single-line and multiline CommonMark reference definition blocks before scanning
  let sanitizedForScan = srcText.replace(new RegExp(MULTILINE_MD_REF_DEF_RE.source, "gm"), "");
  // 1) Inline Markdown links `[label](url)` (supporting backslash-escaped `\[` / `\]`)
  sanitizedForScan = sanitizedForScan.replace(/\[((?:\\.|[^\[\]\\])+)\]\(([^)]+)\)/g, (_full, label, rawUrl) => inspectResolvedLink(label, rawUrl));
  // 2) Full & collapsed reference-style Markdown links `[label][ref]` / `[label][]`
  sanitizedForScan = sanitizedForScan.replace(/\[((?:\\.|[^\[\]\\])+)\]\[((?:\\.|[^\[\]\\])*)\]/g, (full, label, ref) => {
    const key = normalizeMarkdownRefKey(ref || label);
    if (!effectiveRefs.has(key)) {
      // Unresolved reference link: strip `#<digits>` from bracketed reference label to fail closed
      return String(label || "").replace(/#\d+\b/g, "");
    }
    return inspectResolvedLink(label, effectiveRefs.get(key));
  });
  // 3) Shortcut reference links `[label]` when `label` matches a defined reference key
  if (effectiveRefs.size > 0) {
    sanitizedForScan = sanitizedForScan.replace(/\[((?:\\.|[^\[\]\\])+)\](?![(\[])/g, (full, label) => {
      const key = normalizeMarkdownRefKey(label);
      if (!effectiveRefs.has(key)) return full;
      return inspectResolvedLink(label, effectiveRefs.get(key));
    });
  }

  if (linkedSameRepoNum != null) return linkedSameRepoNum;

  const m = sanitizedForScan.match(/(?:^|[\s(\[])(?:\[#(\d+)\]|(?:issue|gh|gitea)\s*[:#]?\s*#(\d+)|(?:refs?|closes|fixes|resolves)\s+#(\d+))(?=$|[\s)\],.;:])/i);
  if (!m) return null;
  const n = Number(m[1] || m[2] || m[3]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Parse sub-tasks from BACKLOG_DAG.md, MICRO_PLAN.md, or ROOT_CAUSE.md.
 * Hardened against code fences, checked-off `[x]` items, arbitrary `[bracket]` headings,
 * cross-repo `owner/repo#N` references, inline & reference-style external Markdown links,
 * prose `#N` false links, auto/explicit `T<n>` ID collisions, and short CJK titles.
 */
export function parseBacklogTasks(markdown, { maxTasks = 20, currentHost = null, currentRepo = null } = {}) {
  if (typeof markdown !== "string" || !markdown.trim()) return [];
  const docRefDefs = parseMarkdownRefDefinitions(markdown);
  const rawCandidates = [];

  const collectCandidate = ({ id = null, title, owner = null, existingNumber = null }) => {
    const cleanTitle = String(title || "")
      .replace(/\[((?:\\.|[^\[\]\\])+)\]\([^)]+\)/g, "$1")
      .replace(/\[((?:\\.|[^\[\]\\])+)\]\[(?:\\.|[^\[\]\\])*\]/g, "$1")
      .replace(/\[((?:\\.|[^\[\]\\])+)\](?![(\[])/g, (full, label) => (
        docRefDefs.has(normalizeMarkdownRefKey(label)) ? label : full
      ))
      .replace(/\\([\[\]])/g, "$1")
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!hasValidTaskTitleLength(cleanTitle)) return;
    if (/^(?:overview|summary|objective|background|assumptions|decisions|verdict|risks?|dependencies|acceptance criteria|testing|notes?|references|dag|architecture|scope|non-goals?)$/i.test(cleanTitle)) {
      return;
    }
    const normId = id ? String(id).trim().replace(/\s+/g, "") : null;
    const num = (Number.isInteger(existingNumber) && existingNumber > 0)
      ? existingNumber
      : extractExplicitLocalIssueNumber(title, { currentHost, currentRepo, refDefs: docRefDefs });

    const inferredOwner = owner || (/\b(backend|server|api|db|mysql|sql|python)\b|(?:后端|数据库|建表|迁移|接口)/i.test(cleanTitle)
      ? "backend"
      : /\b(frontend|vue|react|ui|web|css|vite)\b|(?:前端|页面|组件|界面|登录页)/i.test(cleanTitle)
        ? "frontend"
        : null);

    rawCandidates.push({
      explicitId: normId,
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
          collectCandidate({ id: c0.replace(/^#/, "T"), title: c1, owner: cells[2] || null, existingNumber: explicitNum });
          continue;
        }
      }
    }

    // 2) Headings with explicit Task IDs ONLY: ### T1: Title | ### Task 1 - Title | ### [BE-1] Title
    const hMatch = line.match(/^#{2,4}\s+(?:\[((?:T|TASK|BE|FE|S|SUBTASK)[-_ ]?\d+)\]\s*[:\-–—.]?\s*|((?:T|TASK|BE|FE|S|SUBTASK)[-_ ]?\d+)\s*[:\-–—.]\s*)(.+)$/i);
    if (hMatch) {
      collectCandidate({ id: (hMatch[1] || hMatch[2]).replace(/\s+/g, ""), title: hMatch[3] });
      continue;
    }

    // 3) Unchecked / in-progress task checklist items ONLY (skip already-completed `- [x]`)
    const cbMatch = line.match(/^[-*]\s+\[[ ~]\]\s+(?:(?:\*\*|`)?((?:T|TASK|BE|FE|S|SUBTASK)[-_ ]?\d+)(?:\*\*|`)?\s*[:\-–—.]?\s+)?(.+)$/i);
    if (cbMatch) {
      collectCandidate({ id: cbMatch[1] ? cbMatch[1].replace(/\s+/g, "") : null, title: cbMatch[2] });
      continue;
    }

    // 4) Numbered or explicit bullet tasks: - **T1**: Title  or  1. **T1** - Title
    const bMatch = line.match(/^(?:[-*]|\d+[.)])\s+(?:\*\*|`)?((?:T|TASK|BE|FE|SUBTASK)[-_ ]?\d+)(?:\*\*|`)?\s*[:\-–—.]\s+(.+)$/i);
    if (bMatch) {
      collectCandidate({ id: bMatch[1].replace(/\s+/g, ""), title: bMatch[2] });
    }
  }

  // Reserve all explicit IDs up-front so auto-assigned `T<n>` IDs NEVER collide with later explicit `T<n>` items!
  const reservedExplicitIds = new Set(
    rawCandidates
      .map((c) => (c.explicitId ? c.explicitId.toLowerCase() : null))
      .filter(Boolean)
  );
  const seenIds = new Set();
  const seenTitles = new Set();
  const tasks = [];
  let nextAuto = 1;

  for (const cand of rawCandidates) {
    if (tasks.length >= maxTasks) break;
    const titleKey = cand.title.toLowerCase();
    if (seenTitles.has(titleKey)) continue;

    let finalId = cand.explicitId;
    if (finalId) {
      if (seenIds.has(finalId.toLowerCase())) continue;
    } else {
      while (seenIds.has(`t${nextAuto}`) || reservedExplicitIds.has(`t${nextAuto}`)) {
        nextAuto++;
      }
      finalId = `T${nextAuto}`;
      nextAuto++;
    }

    seenTitles.add(titleKey);
    seenIds.add(finalId.toLowerCase());
    tasks.push({
      id: finalId,
      title: cand.title,
      owner: cand.owner,
      number: cand.number,
    });
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

/**
 * Extract an already-created issue URL ONLY from trusted `stdout` (NEVER `stderr` diagnostics!),
 * requiring exact `host` and `owner/repo` match when known.
 */
export function parseTrustedCreatedIssueUrl(stdout = "", { host = null, origin = null, basePath = "", repo = null, requireRepo = false } = {}) {
  if (!stdout) return { number: null, url: null };
  if (requireRepo && !repo) return { number: null, url: null };
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^(https?:\/\/[^\s"'<>]+\/issues\/(\d+))\/?$/i);
    if (!m) continue;
    const urlStr = m[1];
    const num = Number(m[2]);
    if (!Number.isInteger(num) || num <= 0) continue;
    let parsedUrl = null;
    try { parsedUrl = new URL(urlStr); } catch { continue; }
    if (origin) {
      const wantOrigin = String(origin).trim().replace(/\/+$/, "").toLowerCase();
      if (parsedUrl.origin.toLowerCase() !== wantOrigin) continue;
    } else if (host) {
      const rawWantHost = String(host).trim().toLowerCase();
      if (rawWantHost.includes(":") && !rawWantHost.startsWith("[")) {
        if (parsedUrl.host.toLowerCase() !== rawWantHost) continue;
      } else {
        const wantHostname = rawWantHost.replace(/^\[|\]$/g, "");
        const gotHostname = parsedUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        if (gotHostname !== wantHostname) continue;
        // Reject unverified custom port when target host had no port and no explicit origin authorized it!
        if (parsedUrl.port !== "") continue;
      }
    }
    if (repo) {
      const rawBase = String(basePath || "").trim().replace(/\/+$/, "");
      const exactBasePrefix = rawBase && rawBase !== "/" ? (rawBase.startsWith("/") ? rawBase : `/${rawBase}`) : "";
      const normRepo = String(repo).replace(/^\/+|\/+$/g, "").toLowerCase();
      const gotPath = parsedUrl.pathname.replace(/\/+$/, "");
      // P1-07: Preserve exact case of `basePath` (HTTP server routing is case-sensitive!),
      // requiring exact `<basePath>/<owner>/<repo>/issues/<id>` match!
      if (exactBasePrefix) {
        if (!gotPath.startsWith(`${exactBasePrefix}/`)) continue;
        const remainder = gotPath.slice(exactBasePrefix.length);
        if (remainder.toLowerCase() !== `/${normRepo}/issues/${num}`) continue;
      } else {
        if (gotPath.toLowerCase() !== `/${normRepo}/issues/${num}`) continue;
      }
    }
    return { number: num, url: urlStr };
  }
  return { number: null, url: null };
}

/**
 * Return `true` ONLY when an issue-create invocation failed BEFORE creating any issue on the forge
 * due to an explicit missing/unknown LABEL rejection (NEVER on generic 404 "repository" not found,
 * timeouts, transport errors, or partial post-create label errors).
 */
export function isMissingLabelError(stderr = "", stdout = "", timedOut = false) {
  if (timedOut) return false;
  const combined = `${stderr}\n${stdout}`;
  if (/https?:\/\/[^\s"'<>]+\/issues\/\d+/.test(stdout)) return false;
  if (TRANSPORT_ERR_RE.test(combined)) return false;
  if (/\b(?:repository|repo|project|organization|owner|user|endpoint)\b[^\r\n]*not found/i.test(combined) && !/\blabels?\b/i.test(combined)) {
    return false;
  }
  return /\blabels?\b[^\r\n]*(?:not found|does not exist|doesn't exist|unknown|invalid|cannot find)|(?:not found|does not exist|doesn't exist|unknown)\s+\blabels?\b/i.test(combined);
}

export function createIssueViaCli({
  provider,
  bin,
  repoDir,
  repo = null,
  host = null,
  origin = null,
  basePath = "",
  teaLogin = null,
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
      if (teaLogin) args.push("--login", teaLogin);
      if (repo) args.push("--repo", repo);
      args.push("--title", title, "--description", body);
      if (withLabels && labels.length) args.push("--labels", labels.join(","));
      return execFn(bin, args, { cwd: repoDir, timeoutMs: 20000 });
    }
    return { ok: false, stdout: "", stderr: `unsupported provider: ${provider}`, timedOut: false };
  };

  let res = runCreate(true);
  // P1-07: Reconcile ALREADY-CREATED issue URL ONLY from trusted `stdout` matching exact host + owner/repo!
  // Never trust an external issue URL mentioned inside `stderr` error diagnostics!
  const mustHaveRepo = Boolean(repo) || (provider === "gh" && process.env.ORCA_ISSUE_ALLOW_LOCAL !== "1");
  const firstCreated = parseTrustedCreatedIssueUrl(res.stdout, { host, origin, basePath, repo, requireRepo: mustHaveRepo });
  if (firstCreated.url && firstCreated.number != null) {
    return {
      ok: true,
      number: firstCreated.number,
      url: firstCreated.url,
      raw: sanitizeText(res.stdout, { maxLen: 240 }),
      labelWarning: !res.ok ? sanitizeText(res.stderr || "label attach failed after create", { maxLen: 200 }) : null,
      error: null,
    };
  }

  // ONLY retry without labels when no issue URL was created and the CLI explicitly rejected a missing label
  if (!res.ok && labels.length && isMissingLabelError(res.stderr, res.stdout, res.timedOut)) {
    res = runCreate(false);
  }
  if (!res.ok) {
    const rawErr = res.stderr || res.stdout || res.error || "issue create failed";
    return { ok: false, number: null, url: null, error: sanitizeText(rawErr, { maxLen: 240 }) };
  }
  // P1-07: If stdout contains ANY HTTP(S) URL, it MUST pass strict origin + basePath + owner/repo + /issues/<id>
  // verification (NEVER fall back to a loose regex that accepts external repo URLs!).
  const stdoutStr = String(res.stdout || "");
  if (/https?:\/\/[^\s"'<>]+/i.test(stdoutStr)) {
    const trustedUrl = parseTrustedCreatedIssueUrl(stdoutStr, { host, origin, basePath, repo, requireRepo: mustHaveRepo });
    if (!trustedUrl.url || trustedUrl.number == null) {
      return {
        ok: false,
        number: null,
        url: null,
        raw: sanitizeText(stdoutStr, { maxLen: 240 }),
        error: "created issue URL failed host/repository ownership verification",
      };
    }
    return {
      ok: true,
      number: trustedUrl.number,
      url: trustedUrl.url,
      raw: sanitizeText(stdoutStr, { maxLen: 240 }),
      error: null,
    };
  }
  // Bare issue number output is ONLY accepted from `tea` (e.g. `#42` / `Index: 42`) when no URL is emitted
  let bareNum = null;
  if (provider === "tea") {
    const tm = stdoutStr.match(/(?:^|\s|\|)#(\d+)\b|(?:^|\n)\s*Index\s*:\s*(\d+)\b/i);
    if (tm) {
      const n = Number(tm[1] || tm[2]);
      if (Number.isInteger(n) && n > 0) bareNum = n;
    }
  }
  return {
    ok: bareNum != null,
    number: bareNum,
    url: null,
    raw: sanitizeText(stdoutStr, { maxLen: 240 }),
    error: bareNum == null ? "could not parse verified issue URL/number" : null,
  };
}

export function commentIssueViaCli({ provider, bin, repoDir, repo = null, host = null, teaLogin = null, number, body, execFn = defaultExec }) {
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
    if (teaLogin) args.push("--login", teaLogin);
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
 * Load `ISSUES.json` from `artDirAbs`.
 * When `matchScope` is provided (pipeline execution / resume), strictly requires complete v2 scope
 * fields (`schemaVersion >= 2`, `provider`, `host`, `repo`, `objectiveHash`, `epic`, and `runScopeId`
 * when resuming) unless `matchScope.adoptLegacy === true` is explicitly passed.
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

  if (matchScope && typeof matchScope === "object" && !matchScope.adoptLegacy) {
    if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion < 2) return null;
    if (!parsed.provider) return null;
    if (matchScope.provider && parsed.provider !== matchScope.provider) return null;

    if (matchScope.repo != null) {
      if (!parsed.repo || parsed.repo.toLowerCase() !== String(matchScope.repo).toLowerCase()) return null;
    } else if (parsed.repo) {
      return null;
    }

    if (matchScope.host != null) {
      if (!parsed.host || parsed.host.toLowerCase() !== String(matchScope.host).toLowerCase()) return null;
    } else if (parsed.host) {
      return null;
    }

    if (matchScope.objective != null && String(matchScope.objective).trim()) {
      const wantHash = computeObjectiveHash(matchScope.objective);
      if (!parsed.objectiveHash || parsed.objectiveHash !== wantHash) return null;
    }

    if (matchScope.epicIssue != null) {
      const wantEpic = Number(matchScope.epicIssue);
      if (Number.isInteger(wantEpic) && wantEpic > 0 && parsed.epic?.number !== wantEpic) {
        return null;
      }
    }

    const allowedRunIds = [
      ...new Set(
        [
          matchScope.runScopeId,
          matchScope.priorRunScopeId,
          ...(Array.isArray(matchScope.priorRunScopeIds) ? matchScope.priorRunScopeIds : []),
        ].filter(Boolean)
      ),
    ];
    const wantLineage = matchScope.lineageId || null;
    const lineageMatches = Boolean(wantLineage && parsed.lineageId && parsed.lineageId === wantLineage);
    if (matchScope.requireRunScope && allowedRunIds.length === 0 && !wantLineage) return null;
    if ((allowedRunIds.length > 0 || wantLineage) && !lineageMatches) {
      if (!parsed.runScopeId || !allowedRunIds.includes(parsed.runScopeId)) {
        return null;
      }
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
    ...(normalized.host ? [`- **Host**: \`${normalized.host}\``] : []),
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
  const pr = formatIssuePrBlock(normalized, { defaultBranch: normalized.defaultBranch || null });
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
  runScopeId = null,
  priorRunScopeId = null,
  priorRunScopeIds = [],
  lineageId = null,
  requireRunScope = false,
  adoptLegacy = false,
  execFn = defaultExec,
  log = () => {},
  warn = () => {},
}) {
  if (config?.mode === false) return null;
  const matchScope = {
    mode: config?.mode ?? "auto",
    provider: providerInfo?.provider || null,
    host: providerInfo?.host ?? null,
    repo: providerInfo?.repo ?? null,
    objective,
    epicIssue: config?.epicIssue ?? null,
    runScopeId,
    priorRunScopeId,
    priorRunScopeIds,
    lineageId,
    requireRunScope,
    adoptLegacy,
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
    runScopeId: runScopeId || null,
    lineageId: lineageId || runScopeId || null,
    provider: providerInfo.provider,
    host: providerInfo.host || null,
    origin: providerInfo.origin || null,
    basePath: providerInfo.basePath || "",
    repo: providerInfo.repo || null,
    teaLogin: providerInfo.teaLogin || null,
    defaultBranch: providerInfo.defaultBranch || config.defaultBranch || null,
    objective: safeObj,
    objectiveHash: objHash,
    epic: null,
    tasks: [],
    updatedAt: null,
  };
  existing.schemaVersion = 2;
  existing.scopeKey = scopeKey;
  if (runScopeId) existing.runScopeId = runScopeId;
  if (lineageId || existing.lineageId || runScopeId) {
    existing.lineageId = lineageId || existing.lineageId || runScopeId;
  }
  existing.provider = providerInfo.provider;
  existing.host = providerInfo.host || existing.host || null;
  existing.origin = providerInfo.origin || existing.origin || null;
  existing.basePath = providerInfo.basePath ?? existing.basePath ?? "";
  existing.repo = providerInfo.repo || existing.repo || null;
  existing.teaLogin = providerInfo.teaLogin || existing.teaLogin || null;
  existing.defaultBranch = providerInfo.defaultBranch || config.defaultBranch || existing.defaultBranch || null;
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
      origin: existing.origin,
      basePath: existing.basePath,
      teaLogin: providerInfo.teaLogin || null,
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
    const parsed = parseBacklogTasks(md, {
      maxTasks: config.maxSubtasks ?? 20,
      currentHost: providerInfo.host || null,
      currentRepo: providerInfo.repo || null,
    });
    const existingByTitle = new Map((existing.tasks || []).filter((t) => t.title).map((t) => [t.title.toLowerCase(), t]));
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
        origin: existing.origin,
        basePath: existing.basePath,
        teaLogin: providerInfo.teaLogin || null,
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
        teaLogin: providerInfo.teaLogin || null,
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
  defaultBranch = undefined,
  provider = null,
  host = null,
  repo = null,
  teaLogin = null,
} = {}) {
  const norm = normalizeLoadedState(state);
  if (!norm || (!norm.epic?.number && !(norm.tasks || []).some((t) => t.number))) {
    return { epicIssue: "", issueRefs: "", issueCloses: "", nonDefaultBranchGuidance: "", targetsDefaultBranch: false, block: "" };
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

  const effDefault = defaultBranch !== undefined ? defaultBranch : (norm.defaultBranch || null);
  const effProv = provider || norm.provider || "gh";
  const effHost = host || norm.host || null;
  const effRepo = repo || norm.repo || null;
  const effTeaLogin = teaLogin || norm.teaLogin || null;
  const ghRepoSel = buildGhRepoSelector(effHost, effRepo);

  const buildCloseCommands = () => {
    if (effProv === "tea") {
      const loginFlag = effTeaLogin ? ` --login "${effTeaLogin}"` : "";
      const repoFlag = effRepo ? ` --repo "${effRepo}"` : "";
      return closeTargets.map((n) => `tea issues close${loginFlag}${repoFlag} ${n}`).join(" && ");
    }
    const repoFlag = ghRepoSel ? ` --repo "${ghRepoSel}"` : "";
    return closeTargets
      .map((n) => `gh issue close ${n}${repoFlag} --comment "Merged to ${targetBranch} via PR #<pr_number>"`)
      .join(" && ");
  };

  const isVerifiedDefaultTarget = Boolean(targetBranch && effDefault && targetBranch === effDefault);
  let nonDefaultBranchGuidance = "";
  if (closeOnPr && closeTargets.length && !isVerifiedDefaultTarget) {
    const closeCmds = buildCloseCommands();
    if (effDefault && targetBranch !== effDefault) {
      nonDefaultBranchGuidance = [
        `NON-DEFAULT TARGET BRANCH ISSUE CLOSE RULE (\`${targetBranch}\` != default branch \`${effDefault}\`):`,
        `- GitHub/Gitea \`Closes #N\` keywords only auto-close issues when merged into the repository's default branch (\`${effDefault}\`).`,
        `- Keep \`${issueCloses.replace(/\n/g, " / ")}\` in the PR description for timeline traceability AND future \`${targetBranch} -> ${effDefault}\` release tracking.`,
        `- ONLY AFTER verifying on the forge that the PR is \`MERGED\` into base \`${targetBranch}\` containing the expected HEAD commit (\`Merge-Status: MERGED\`, NEVER when held for \`PENDING_HUMAN_MERGE\`), explicitly close the completed issue(s) via host-qualified CLI:`,
        `  \`${closeCmds}\``,
      ].join("\n");
    } else {
      nonDefaultBranchGuidance = [
        `UNVERIFIED DEFAULT BRANCH ISSUE CLOSE RULE (target \`${targetBranch}\`, repository default branch unverified):`,
        `- Repository default branch could not be verified locally via \`origin/HEAD\` or forge metadata; do NOT assume \`Closes #N\` auto-closed issues on \`${targetBranch}\`.`,
        `- Keep \`${issueCloses.replace(/\n/g, " / ")}\` in the PR description. ONLY AFTER verifying on the forge that the PR is \`MERGED\` into base \`${targetBranch}\` (\`Merge-Status: MERGED\`, NEVER \`PENDING_HUMAN_MERGE\`), check whether the issue(s) remain open and close them explicitly if \`${targetBranch}\` is not the default branch:`,
        `  \`${closeCmds}\``,
      ].join("\n");
    }
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
    targetsDefaultBranch: isVerifiedDefaultTarget,
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
    const adoptLegacy = args.includes("--adopt-legacy");
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
      adoptLegacy,
      log: (...a) => console.log(...a),
      warn: (...a) => console.warn(...a),
    });
    console.log(JSON.stringify(state, null, 2));
    process.exit(0);
  }

  console.error("Usage: node .orca/issue-tracker.mjs [status|sync] [--repo <dir>] [--plan <file>] [--objective <text>] [--epic-issue <n>] [--adopt-legacy] [--json]");
  process.exit(2);
}
