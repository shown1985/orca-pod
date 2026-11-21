// Pre-flight worker health check, primary/fallback candidate resolution,
// OpenCode official config precedence resolver, and Cross-Family Review isolation helpers.
// Zero external dependencies (Node >= 18).

import net from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sanitizeText } from "./lib/sanitize.mjs";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

export const REVIEW_STEP_ID_RE = /^(?:contract-review|task-review-merge|senior-audit|diff-audit|code-review|security-review|review)$/i;
const NON_REVIEW_VERDICT_RE = /^(?:serial-integration|visual-gate|pr-submit|pr-release-dev)$/i;
const NON_AUTHOR_STEP_RE = /^(?:grill|po-backlog|micro-plan|triage-root-cause|visual-gate|pr-submit|pr-release-dev)$/i;

/**
 * Strip `//` line comments, `/* ... *\/` block comments, and trailing commas outside
 * string literals so JSONC config files (`opencode.jsonc` / commented `opencode.json`) parse cleanly.
 */
export function parseJsoncSafe(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) return null;
  let out = "";
  let inStr = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    const next = rawText[i + 1];

    if (inLineComment) {
      if (ch === "\n" || ch === "\r") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }

  let cleaned = "";
  inStr = false;
  escaped = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inStr) {
      cleaned += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") {
      inStr = true;
      cleaned += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    cleaned += ch;
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Collect ancestor directories from repo/worktree root (or bounded ancestor) down to `projectDir`,
 * matching OpenCode's hierarchical directory traversal where deeper directories override parent directories
 * and `.opencode/opencode.json(c)` overrides root `opencode.json(c)`.
 */
function collectOpencodeSearchDirs(projectDir) {
  if (!projectDir) return [];
  const start = resolve(projectDir);
  const home = resolve(homedir());
  let stopBoundary = null;
  const gitTop = spawnSync("git", ["--no-optional-locks", "-C", start, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 1500,
  });
  if (!gitTop.error && gitTop.status === 0 && (gitTop.stdout || "").trim()) {
    stopBoundary = resolve((gitTop.stdout || "").trim());
  }

  const chain = [];
  let cur = start;
  for (let depth = 0; depth < 16; depth++) {
    if (cur === home) break;
    chain.push(cur);
    if (stopBoundary && cur === stopBoundary) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    if (!stopBoundary && existsSync(join(cur, ".git"))) break;
    cur = parent;
  }
  return chain.reverse(); // Outermost ancestor -> innermost projectDir
}

/**
 * Resolve merged OpenCode configuration following official OpenCode precedence (lowest -> highest):
 *   1. Global `~/.config/opencode2/opencode.json` -> `opencode.jsonc`
 *   2. Global `~/.config/opencode/opencode.json` -> `opencode.jsonc`
 *   3. Custom `OPENCODE_CONFIG` file (if set)
 *   4. Ancestor -> `projectDir` hierarchy:
 *      `<dir>/opencode.json` -> `<dir>/opencode.jsonc` -> `<dir>/.opencode/opencode.json` -> `<dir>/.opencode/opencode.jsonc`
 */
export function resolveOpencodeConfig({ projectDir = process.cwd(), configPaths = null } = {}) {
  const home = homedir();
  let orderedPaths;
  if (Array.isArray(configPaths)) {
    orderedPaths = configPaths.filter(Boolean);
  } else {
    orderedPaths = [
      join(home, ".config", "opencode2", "opencode.json"),
      join(home, ".config", "opencode2", "opencode.jsonc"),
      join(home, ".config", "opencode", "opencode.json"),
      join(home, ".config", "opencode", "opencode.jsonc"),
      process.env.OPENCODE_CONFIG || null,
    ].filter(Boolean);

    for (const dir of collectOpencodeSearchDirs(projectDir)) {
      orderedPaths.push(
        join(dir, "opencode.json"),
        join(dir, "opencode.jsonc"),
        join(dir, ".opencode", "opencode.json"),
        join(dir, ".opencode", "opencode.jsonc"),
      );
    }
  }

  let configuredModel = null;
  const mergedProviders = {};
  const providerSources = {};
  const disabledProviders = new Set();
  let enabledProviders = null;

  for (const p of orderedPaths) {
    if (!existsSync(p)) continue;
    let data = null;
    try { data = parseJsoncSafe(readFileSync(p, "utf8")); } catch { continue; }
    if (!data || typeof data !== "object") continue;

    if (typeof data.model === "string" && data.model.trim() && data.model.trim() !== "default") {
      configuredModel = data.model.trim();
    }
    if (Array.isArray(data.disabled_providers)) {
      for (const dp of data.disabled_providers) if (typeof dp === "string") disabledProviders.add(dp);
    }
    if (Array.isArray(data.enabled_providers)) {
      enabledProviders = new Set(data.enabled_providers.filter((ep) => typeof ep === "string"));
    }
    const providers = data.provider && typeof data.provider === "object" ? data.provider : {};
    for (const [provName, provCfg] of Object.entries(providers)) {
      if (!provCfg || typeof provCfg !== "object") continue;
      const prev = mergedProviders[provName] || {};
      mergedProviders[provName] = {
        ...prev,
        ...provCfg,
        options: { ...(prev.options || {}), ...(provCfg.options || {}) },
      };
      providerSources[provName] = p;
    }
  }

  return {
    model: configuredModel,
    configuredModel,
    mergedProviders,
    providerSources,
    disabledProviders,
    enabledProviders,
  };
}

export function resolveEffectiveCandidateModel(agent, model = null, { projectDir = null, configPaths = null } = {}) {
  if (model != null && String(model).trim() && String(model).trim().toLowerCase() !== "default") {
    return String(model).trim();
  }
  const baseAgent = String(agent || "").trim().split(/\s+/)[0].toLowerCase();
  if ((baseAgent === "opencode" || baseAgent === "opencode2") && (projectDir || configPaths)) {
    const oc = resolveOpencodeConfig({ projectDir: projectDir || process.cwd(), configPaths });
    if (oc.configuredModel) return oc.configuredModel;
  }
  return null;
}

function matchModelIdFamily(modelStr) {
  const m = String(modelStr || "").trim().toLowerCase();
  if (!m) return null;
  if (/\bclaude\b|\banthropic\b/.test(m)) return "anthropic";
  if (/\b(?:gpt-[a-z0-9]|gpt\d|o1\b|o3\b|o4\b|codex\b|openai\b)/.test(m)) return "openai";
  if (/\bgemini\b|\bgoogle\b/.test(m)) return "google";
  if (/\bdeepseek\b/.test(m)) return "deepseek";
  if (/\bglm\b|\bzhipu\b|\bzai\b|\bzcode\b/.test(m)) return "zhipu";
  if (/\bkimi\b|\bmoonshot\b/.test(m)) return "moonshot";
  if (/\bqwen\b|\balibaba\b|\bdashscope\b/.test(m)) return "qwen";
  if (/\bgrok\b|\bxai\b/.test(m)) return "xai";
  if (/\bmistral\b|\bcodestral\b/.test(m)) return "mistral";
  if (/\bllama\b|\bmeta\b/.test(m)) return "meta";
  if (/\bhy4\b|\bhunyuan\b/.test(m)) return "hunyuan";
  return null;
}

/**
 * Classify the effective LLM provider/model family from `{ agent, model }`:
 *   - Explicit or config-resolved model ID is authoritative; if a model ID is present
 *     but unrecognized, returns `"unknown"` (NEVER guesses from the CLI harness name!).
 *   - When model is omitted/`"default"`, resolves `opencode`/`opencode2` default model from
 *     `opencode.json(c)` when `projectDir` is provided.
 *   - Multi-provider router CLIs (`opencode`, `opencode2`, `agy`, `antigravity`, `cursor`,
 *     `omp`, `pi`) without a resolved model return `"unknown"` so cross-family gates fail closed.
 *   - Synthetic test harness `"stub"` returns `"stub"`.
 */
export function classifyModelFamily(agent, model = null, { projectDir = null, configPaths = null } = {}) {
  const baseAgent = String(agent || "").trim().split(/\s+/)[0].toLowerCase();
  const explicitModel = (model != null && String(model).trim() && String(model).trim().toLowerCase() !== "default")
    ? String(model).trim()
    : null;

  if (!baseAgent) return "unknown";
  if (baseAgent === "stub" && !explicitModel) return "stub";

  const effModel = explicitModel || resolveEffectiveCandidateModel(baseAgent, null, { projectDir, configPaths });
  if (effModel) {
    return matchModelIdFamily(effModel) || "unknown";
  }

  // Single-vendor CLIs with deterministic provider identity when model is omitted
  if (baseAgent === "codex") return "openai";
  if (baseAgent === "claude") return "anthropic";
  if (baseAgent === "gemini") return "google";
  if (baseAgent === "zcode") return "zhipu";
  if (baseAgent === "kimi") return "moonshot";
  if (baseAgent === "grok") return "xai";

  // Multi-provider routers (`opencode`, `opencode2`, `agy`, `antigravity`, `cursor`, `omp`, `pi`)
  // or unrecognized CLIs without an explicit/configured model cannot prove model family!
  return "unknown";
}

export function isCrossFamilyReviewStep(step) {
  if (!step || typeof step !== "object") return false;
  if (step.crossFamily === false) return false;
  if (Array.isArray(step.crossFamilyWith) && step.crossFamilyWith.length > 0) return true;
  if (typeof step.crossFamilyWith === "string" && step.crossFamilyWith.trim()) return true;
  const id = String(step.id || "");
  if (REVIEW_STEP_ID_RE.test(id)) return true;
  if (step.verify?.requireVerdict && !NON_REVIEW_VERDICT_RE.test(id) && !/(?:integration|visual|pr-|release)/i.test(id)) {
    return true;
  }
  return false;
}

export function validateCrossFamilyConfig(allSteps = [], byId = {}, die = (m) => { throw new Error(m); }) {
  const idxMap = new Map(allSteps.map((s, idx) => [s.id, idx]));
  for (const step of allSteps) {
    if (step.crossFamilyWith === undefined || step.crossFamilyWith === null) continue;
    const list = Array.isArray(step.crossFamilyWith)
      ? step.crossFamilyWith
      : (typeof step.crossFamilyWith === "string" ? [step.crossFamilyWith] : null);
    if (!list || list.length === 0 || list.some((x) => typeof x !== "string" || !x.trim())) {
      die(`step "${step.id}": crossFamilyWith must be a non-empty step ID string or non-empty array of step IDs.`);
    }
    const selfIdx = idxMap.get(step.id) ?? -1;
    for (const rawTarget of list) {
      const targetId = rawTarget.trim();
      if (targetId === step.id) {
        die(`step "${step.id}": crossFamilyWith cannot reference itself.`);
      }
      if (!byId[targetId]) {
        die(`step "${step.id}": crossFamilyWith references unknown step "${targetId}".`);
      }
      const targetIdx = idxMap.get(targetId) ?? -1;
      if (targetIdx >= selfIdx) {
        die(`step "${step.id}": crossFamilyWith "${targetId}" must appear EARLIER in the pipeline.`);
      }
    }
  }
}

export function resolveAuthorStepIds(step, byId = {}) {
  if (!isCrossFamilyReviewStep(step)) return [];
  if (Array.isArray(step.crossFamilyWith) && step.crossFamilyWith.length > 0) {
    return [...new Set(step.crossFamilyWith.map((x) => String(x || "").trim()).filter(Boolean))];
  }
  if (typeof step.crossFamilyWith === "string" && step.crossFamilyWith.trim()) {
    return [step.crossFamilyWith.trim()];
  }
  const out = new Set();
  for (const rId of step.reads || []) {
    const target = byId[rId];
    if (!rId) continue;
    if (NON_AUTHOR_STEP_RE.test(rId) || REVIEW_STEP_ID_RE.test(rId)) continue;
    if (target && isCrossFamilyReviewStep(target)) continue;
    out.add(rId);
  }
  if (step.onFailGoto && !NON_AUTHOR_STEP_RE.test(step.onFailGoto) && !REVIEW_STEP_ID_RE.test(step.onFailGoto)) {
    out.add(step.onFailGoto);
  }
  return [...out];
}

export function normalizeHost(rawHost) {
  return String(rawHost || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function validateEndpointSpec(spec, kind = "tcp") {
  if (!spec || typeof spec !== "string" || !spec.trim()) {
    return { ok: false, reason: `empty ${kind} preflight endpoint`, code: "INVALID_ENDPOINT" };
  }
  const trimmed = spec.trim();
  const safeSpec = sanitizeText(trimmed, { maxLen: 160 });

  if (kind === "http" || /^https?:\/\//i.test(trimmed)) {
    let u;
    try {
      u = new URL(trimmed);
    } catch {
      return { ok: false, reason: `invalid preflight URL "${safeSpec}"`, code: "INVALID_ENDPOINT" };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: `unsupported preflight URL protocol "${u.protocol}" in "${safeSpec}"`, code: "INVALID_ENDPOINT" };
    }
    const port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
    if (!isValidPort(port)) {
      return { ok: false, reason: `invalid TCP port in "${safeSpec}" (must be 1..65535)`, code: "INVALID_ENDPOINT" };
    }
    const host = normalizeHost(u.hostname);
    if (!host) {
      return { ok: false, reason: `missing hostname in "${safeSpec}"`, code: "INVALID_ENDPOINT" };
    }
    return { ok: true, host, port, url: trimmed };
  }

  const ipv6Match = trimmed.match(/^\[([^\]]+)\]:(\d+)$/);
  const ipv4Match = !ipv6Match ? trimmed.match(/^([^:\s[\]]+):(\d+)$/) : null;
  const m = ipv6Match || ipv4Match;
  if (!m) {
    return { ok: false, reason: `invalid host:port endpoint "${safeSpec}"`, code: "INVALID_ENDPOINT" };
  }
  const host = normalizeHost(m[1]);
  const port = Number(m[2]);
  if (!host || !isValidPort(port)) {
    return { ok: false, reason: `invalid TCP port "${m[2]}" in "${safeSpec}" (must be 1..65535)`, code: "INVALID_ENDPOINT" };
  }
  return { ok: true, host, port, url: null };
}

export function parseHostPort(spec) {
  const res = validateEndpointSpec(spec, /^https?:\/\//i.test(String(spec || "").trim()) ? "http" : "tcp");
  if (!res.ok) return null;
  return { host: res.host, port: res.port, url: res.url };
}

export function probeTcp(host, port, timeoutMs = 1500) {
  const normHost = normalizeHost(host);
  const numPort = Number(port);
  if (!normHost || !isValidPort(numPort)) {
    return Promise.resolve({
      ok: false,
      host: normHost || String(host || ""),
      port: numPort,
      reason: `Invalid TCP endpoint ${normHost || host}:${port} (port must be 1..65535)`,
      code: "INVALID_ENDPOINT",
    });
  }
  return new Promise((resolveProbe) => {
    let done = false;
    let sock = null;
    const finish = (ok, reason = null, code = null) => {
      if (done) return;
      done = true;
      try { sock?.destroy(); } catch {}
      resolveProbe({ ok, host: normHost, port: numPort, reason: reason ? sanitizeText(reason, { maxLen: 220 }) : null, code });
    };
    try {
      sock = net.createConnection({ host: normHost, port: numPort });
    } catch (err) {
      const code = err?.code || "INVALID_ENDPOINT";
      finish(false, `TCP ${normHost}:${numPort} ${code}${err?.message ? ` (${err.message})` : ""}`, code);
      return;
    }
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false, `TCP ${normHost}:${numPort} timed out after ${timeoutMs}ms`, "ETIMEDOUT"));
    sock.once("error", (err) => {
      const code = err?.code || "TCP_ERROR";
      finish(false, `TCP ${normHost}:${numPort} ${code}${err?.message ? ` (${err.message})` : ""}`, code);
    });
  });
}

export async function probeHttp(url, timeoutMs = 2000) {
  const valid = validateEndpointSpec(url, "http");
  const safeUrl = sanitizeText(String(url || ""), { maxLen: 180 });
  if (!valid.ok) {
    return { ok: false, url: safeUrl, status: null, reason: valid.reason, code: valid.code };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp = null;
  try {
    const parsedUrl = new URL(url);
    const headers = {};
    if (parsedUrl.username || parsedUrl.password) {
      const creds = `${decodeURIComponent(parsedUrl.username)}:${decodeURIComponent(parsedUrl.password)}`;
      headers.Authorization = `Basic ${Buffer.from(creds, "utf8").toString("base64")}`;
      parsedUrl.username = "";
      parsedUrl.password = "";
    }
    resp = await fetch(parsedUrl.toString(), { method: "GET", signal: ctrl.signal, headers });
    const status = resp.status;
    try { await resp.body?.cancel?.(); } catch {}
    if (status >= 500) {
      return { ok: false, url: safeUrl, status, reason: `HTTP ${status} from ${safeUrl}`, code: `HTTP_${status}` };
    }
    return { ok: true, url: safeUrl, status, reason: null, code: null };
  } catch (err) {
    try { await resp?.body?.cancel?.(); } catch {}
    const causeCode = err?.cause?.code || err?.code || (err?.name === "AbortError" ? "ETIMEDOUT" : "FETCH_FAILED");
    return {
      ok: false,
      url: safeUrl,
      status: null,
      reason: sanitizeText(`HTTP ${safeUrl} ${causeCode} (${err?.message || "fetch failed"})`, { maxLen: 220 }),
      code: causeCode,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function probeBinary(agentCmd) {
  const bin = String(agentCmd || "").trim().split(/\s+/)[0];
  if (!bin) return { ok: false, bin: "", reason: "empty agent command" };
  const cmd = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(cmd, [bin], { encoding: "utf8", timeout: 2000 });
  if (!r.error && r.status === 0) return { ok: true, bin, path: (r.stdout || "").trim().split(/\r?\n/)[0] };
  return { ok: false, bin, reason: `binary "${bin}" not found on PATH` };
}

/**
 * Inspect OpenCode config files (official hierarchical merge order) to auto-discover
 * localhost provider baseURLs for the effective model.
 * Respects both `disabled_providers` and `enabled_providers` on explicit and default models.
 */
export function discoverOpencodeLocalEndpoints({ projectDir = process.cwd(), model = null, configPaths = null } = {}) {
  const {
    configuredModel,
    mergedProviders,
    providerSources,
    disabledProviders,
    enabledProviders,
  } = resolveOpencodeConfig({ projectDir, configPaths });

  const isProviderAllowed = (name) => {
    if (disabledProviders.has(name)) return false;
    if (enabledProviders && !enabledProviders.has(name)) return false;
    return true;
  };

  const effectiveModel = (typeof model === "string" && model.trim() && model.trim() !== "default")
    ? model.trim()
    : configuredModel;
  const modelPrefix = typeof effectiveModel === "string" && effectiveModel.includes("/")
    ? effectiveModel.split("/")[0]
    : null;

  let candidateProviders = [];
  if (modelPrefix) {
    if (mergedProviders[modelPrefix] && isProviderAllowed(modelPrefix)) {
      candidateProviders = [[modelPrefix, mergedProviders[modelPrefix]]];
    } else {
      return [];
    }
  } else {
    candidateProviders = Object.entries(mergedProviders).filter(([name]) => isProviderAllowed(name));
  }

  const endpoints = [];
  const seen = new Set();
  for (const [provName, provCfg] of candidateProviders) {
    const baseURL = provCfg?.options?.baseURL || provCfg?.baseURL || provCfg?.apiUrl || null;
    if (!baseURL || typeof baseURL !== "string") continue;
    const valid = validateEndpointSpec(baseURL, "http");
    if (!valid.ok) {
      endpoints.push({
        provider: provName,
        host: null,
        port: null,
        baseURL: sanitizeText(baseURL, { maxLen: 160 }),
        source: providerSources[provName] || null,
        invalid: true,
        reason: valid.reason,
      });
      continue;
    }
    if (!LOCAL_HOSTS.has(valid.host)) continue;
    const key = `${valid.host}:${valid.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({
      provider: provName,
      host: valid.host,
      port: valid.port,
      baseURL: sanitizeText(baseURL, { maxLen: 160 }),
      source: providerSources[provName] || null,
      invalid: false,
    });
  }
  return endpoints;
}

export function normalizeCandidate(raw, isPrimary = false, { projectDir = null } = {}) {
  if (!raw) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const resolvedModel = resolveEffectiveCandidateModel(trimmed, null, { projectDir });
    return {
      agent: trimmed,
      model: null,
      resolvedModel,
      effort: null,
      preflight: null,
      isPrimary,
      family: classifyModelFamily(trimmed, resolvedModel, { projectDir }),
    };
  }
  if (typeof raw !== "object" || !raw.agent) return null;
  const agent = String(raw.agent).trim();
  if (!agent) return null;
  const model = raw.model != null && String(raw.model).trim() && String(raw.model).trim() !== "default"
    ? String(raw.model).trim()
    : null;
  const resolvedModel = model || resolveEffectiveCandidateModel(agent, null, { projectDir });
  return {
    agent,
    model,
    resolvedModel,
    effort: raw.effort ? String(raw.effort).trim() : null,
    preflight: raw.preflight && typeof raw.preflight === "object" ? raw.preflight : null,
    isPrimary,
    family: classifyModelFamily(agent, resolvedModel, { projectDir }),
  };
}

export function buildCandidateChain(step, cfg = {}, { agentOf, modelOf, forbiddenFamilies = null, projectDir = null } = {}) {
  const primaryAgent = agentOf ? agentOf(step) : step.agent;
  const primaryModel = modelOf ? modelOf(step) : (step.model && step.model !== "default" ? step.model : null);
  const primary = normalizeCandidate({
    agent: primaryAgent,
    model: primaryModel,
    effort: step.effort || cfg?.defaults?.effort || null,
    preflight: step.preflight || null,
  }, true, { projectDir });

  const rawList = [];
  if (step.fallback) rawList.push(step.fallback);
  if (Array.isArray(step.fallbacks)) rawList.push(...step.fallbacks);

  const isReview = isCrossFamilyReviewStep(step);
  if (isReview && cfg?.defaults?.reviewerFallbacks) {
    const rf = cfg.defaults.reviewerFallbacks;
    if (Array.isArray(rf)) rawList.push(...rf);
    else rawList.push(rf);
  }

  const agentFallbacks = cfg?.defaults?.agentFallbacks;
  const baseAgentName = String(primaryAgent || "").trim().split(/\s+/)[0];
  if (agentFallbacks && typeof agentFallbacks === "object") {
    const specific = agentFallbacks[primaryAgent] || agentFallbacks[baseAgentName];
    if (Array.isArray(specific)) rawList.push(...specific);
    else if (specific) rawList.push(specific);
  }

  if (!isReview || step.allowGlobalFallback === true) {
    if (cfg?.defaults?.fallback) rawList.push(cfg.defaults.fallback);
    if (Array.isArray(cfg?.defaults?.fallbacks)) rawList.push(...cfg.defaults.fallbacks);
  }

  const forbiddenSet = forbiddenFamilies instanceof Set
    ? forbiddenFamilies
    : (Array.isArray(forbiddenFamilies) ? new Set(forbiddenFamilies.filter(Boolean)) : null);

  const chain = [];
  const seen = new Set();
  const pushUnique = (cand) => {
    if (!cand) return;
    if (isReview && forbiddenSet && forbiddenSet.size > 0) {
      if (!cand.family || cand.family === "unknown" || forbiddenSet.has(cand.family)) {
        return;
      }
    }
    const key = `${cand.agent}::${cand.model || ""}::${cand.effort || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    chain.push(cand);
  };

  pushUnique(primary);
  for (const r of rawList) pushUnique(normalizeCandidate(r, false, { projectDir }));
  return chain;
}

/**
 * Filter a review step's candidate chain against ALL upstream author families.
 * Fails closed when:
 *   - Any upstream author step lacks proven execution family (`unprovenAuthors.length > 0`)
 *   - A reviewer candidate's family is `"unknown"` / unresolvable
 *   - A reviewer candidate's family matches any upstream author's executed family
 */
export function filterCrossFamilyCandidates(
  chain,
  forbiddenByFamily = new Map(),
  { unprovenAuthors = [], projectDir = null, allowSyntheticStub = false } = {}
) {
  const allowed = [];
  const rejected = [];

  if (unprovenAuthors.length > 0) {
    const detail = unprovenAuthors.map((u) => `${u.stepId} (${u.reason})`).join(", ");
    for (const cand of chain || []) {
      rejected.push({
        agent: cand.agent,
        model: cand.model,
        effort: cand.effort,
        isPrimary: Boolean(cand.isPrimary),
        family: cand.family ?? classifyModelFamily(cand.agent, cand.model, { projectDir }),
        conflictSteps: unprovenAuthors,
        reason: `cross-family isolation cannot prove upstream author independence: ${detail}`,
      });
    }
    return { allowed: [], rejected };
  }

  for (const cand of chain || []) {
    const fam = cand.family ?? classifyModelFamily(cand.agent, cand.model, { projectDir });
    if (fam === "stub" && allowSyntheticStub) {
      allowed.push(cand);
      continue;
    }
    if (!fam || fam === "unknown" || fam === "stub") {
      rejected.push({
        agent: cand.agent,
        model: cand.model,
        effort: cand.effort,
        isPrimary: Boolean(cand.isPrimary),
        family: fam || "unknown",
        conflictSteps: [],
        reason: `cross-family isolation blocked "${cand.agent}"${cand.model ? ` (${cand.model})` : ""}: reviewer model family is "${fam || "unknown"}" (must specify a verifiable cross-family model)`,
      });
      continue;
    }
    if (forbiddenByFamily && forbiddenByFamily.has(fam)) {
      const src = forbiddenByFamily.get(fam);
      rejected.push({
        agent: cand.agent,
        model: cand.model,
        effort: cand.effort,
        isPrimary: Boolean(cand.isPrimary),
        family: fam,
        conflictSteps: src,
        reason: `cross-family isolation blocked "${cand.agent}"${cand.model ? ` (${cand.model})` : ""}: family "${fam}" matches upstream author ${src.map((s) => `${s.stepId}[${s.agent}${s.model && s.model !== "default" ? `:${s.model}` : ""}]`).join(", ")}`,
      });
      continue;
    }
    allowed.push(cand);
  }
  return { allowed, rejected };
}

export async function checkCandidateHealth(candidate, {
  cfg = {},
  projectDir = process.cwd(),
  probeTcpFn = probeTcp,
  probeHttpFn = probeHttp,
  probeBinaryFn = probeBinary,
  discoverOpencodeFn = discoverOpencodeLocalEndpoints,
} = {}) {
  const globalPf = cfg?.defaults?.preflight && typeof cfg.defaults.preflight === "object" ? cfg.defaults.preflight : {};
  const candPf = candidate?.preflight && typeof candidate.preflight === "object" ? candidate.preflight : {};
  const enabled = candPf.enabled ?? globalPf.enabled ?? true;
  if (!enabled) return { ok: true, checks: [], reason: null };

  const timeoutMs = candPf.timeoutMs ?? globalPf.timeoutMs ?? 1500;
  const checks = [];

  const shouldCheckBin = Boolean(candPf.checkBin ?? globalPf.checkBin ?? false);
  if (shouldCheckBin) {
    const b = probeBinaryFn(candidate.agent);
    checks.push({ type: "binary", ...b });
    if (!b.ok) return { ok: false, checks, reason: b.reason, code: "BIN_NOT_FOUND" };
  }

  const tcpList = [];
  if (candPf.tcp) tcpList.push(...(Array.isArray(candPf.tcp) ? candPf.tcp : [candPf.tcp]));
  const baseAgent = String(candidate.agent || "").trim().split(/\s+/)[0];
  const agentPf = globalPf.agents?.[candidate.agent] || globalPf.agents?.[baseAgent] || null;
  if (agentPf?.tcp) tcpList.push(...(Array.isArray(agentPf.tcp) ? agentPf.tcp : [agentPf.tcp]));

  for (const spec of tcpList) {
    const valid = validateEndpointSpec(spec, "tcp");
    if (!valid.ok) {
      checks.push({ type: "tcp", ok: false, spec: sanitizeText(String(spec), { maxLen: 120 }), reason: valid.reason, code: valid.code });
      return { ok: false, configError: true, checks, reason: valid.reason, code: valid.code };
    }
    const r = await probeTcpFn(valid.host, valid.port, timeoutMs);
    checks.push({ type: "tcp", ...r });
    if (!r.ok) return { ok: false, checks, reason: r.reason, code: r.code || "TCP_ERROR" };
  }

  const urlList = [];
  if (candPf.url) urlList.push(...(Array.isArray(candPf.url) ? candPf.url : [candPf.url]));
  if (agentPf?.url) urlList.push(...(Array.isArray(agentPf.url) ? agentPf.url : [agentPf.url]));
  for (const url of urlList) {
    const valid = validateEndpointSpec(url, "http");
    if (!valid.ok) {
      checks.push({ type: "http", ok: false, url: sanitizeText(String(url), { maxLen: 160 }), reason: valid.reason, code: valid.code });
      return { ok: false, configError: true, checks, reason: valid.reason, code: valid.code };
    }
    const r = await probeHttpFn(url, timeoutMs);
    checks.push({ type: "http", ...r });
    if (!r.ok) return { ok: false, checks, reason: r.reason, code: r.code || "HTTP_ERROR" };
  }

  const autoDetect = candPf.autoDetectOpencodeEndpoints ?? globalPf.autoDetectOpencodeEndpoints ?? true;
  if (autoDetect && /^opencode2?$/.test(baseAgent) && tcpList.length === 0 && urlList.length === 0) {
    const localEndpoints = discoverOpencodeFn({ projectDir, model: candidate.model });
    for (const ep of localEndpoints) {
      if (ep.invalid) {
        checks.push({ type: "opencode_local_tcp", provider: ep.provider, source: ep.source, ok: false, reason: ep.reason, code: "INVALID_ENDPOINT" });
        return {
          ok: false,
          configError: true,
          checks,
          reason: `OpenCode provider "${ep.provider}" has invalid baseURL: ${ep.reason}`,
          code: "INVALID_ENDPOINT",
        };
      }
      const r = await probeTcpFn(ep.host, ep.port, timeoutMs);
      checks.push({ type: "opencode_local_tcp", provider: ep.provider, source: ep.source, ...r });
      if (!r.ok) {
        return {
          ok: false,
          checks,
          reason: sanitizeText(`OpenCode provider "${ep.provider}" (${ep.baseURL}) unreachable: ${r.reason}`, { maxLen: 240 }),
          code: r.code || "ECONNREFUSED",
        };
      }
    }
  }

  return { ok: true, checks, reason: null, code: null };
}

export async function selectHealthyCandidate(chain, opts = {}) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return { candidate: null, index: -1, downgraded: false, failures: [] };
  }
  const failures = [];
  for (let i = 0; i < chain.length; i++) {
    const cand = chain[i];
    const health = await checkCandidateHealth(cand, opts);
    if (health.ok) {
      return {
        candidate: cand,
        index: i,
        downgraded: i > 0,
        failures,
        checks: health.checks,
      };
    }
    failures.push({
      index: i,
      agent: cand.agent,
      model: cand.model,
      effort: cand.effort,
      reason: health.reason,
      code: health.code,
      configError: Boolean(health.configError),
    });
  }
  const allConfigErrors = failures.length > 0 && failures.every((f) => f.configError);
  return {
    candidate: chain[0],
    index: 0,
    downgraded: false,
    allFailed: true,
    allConfigErrors,
    failures,
  };
}
