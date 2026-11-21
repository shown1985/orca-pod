// Pre-flight worker health check, primary/fallback candidate resolution,
// and Cross-Family Review isolation helpers.
// Solves local gateway failures (e.g. Magpie 127.0.0.1:3425 down -> ECONNREFUSED)
// by checking endpoint health before dispatch and seamlessly downgrading to a
// configured fallback agent/model/effort, while strictly preventing review gates
// from falling back into an upstream author's model family.
// Zero external dependencies (Node >= 18).

import net from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeText } from "./lib/sanitize.mjs";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

export const REVIEW_STEP_ID_RE = /^(?:contract-review|task-review-merge|senior-audit|diff-audit|code-review|security-review|review)$/i;
const NON_REVIEW_VERDICT_RE = /^(?:serial-integration|visual-gate|pr-submit|pr-release-dev)$/i;
const NON_AUTHOR_STEP_RE = /^(?:grill|po-backlog|micro-plan|triage-root-cause|visual-gate|pr-submit|pr-release-dev)$/i;

/**
 * Classify the effective LLM provider/model family from `{ agent, model }`.
 * Model ID takes precedence over CLI harness name because multi-provider CLIs
 * (e.g. `agy`, `opencode2`, `cursor`) can route to Anthropic, OpenAI, Google, DeepSeek, etc.
 * Returns `null` for synthetic test stubs (e.g. `stub`) or unrecognized custom commands.
 */
export function classifyModelFamily(agent, model = null) {
  const m = model != null && String(model).trim() && String(model).trim().toLowerCase() !== "default"
    ? String(model).trim().toLowerCase()
    : "";

  if (m) {
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
  }

  const baseAgent = String(agent || "").trim().split(/\s+/)[0].toLowerCase();
  if (!baseAgent || baseAgent === "stub") return null;
  if (baseAgent === "codex") return "openai";
  if (baseAgent === "claude") return "anthropic";
  if (baseAgent === "gemini" || baseAgent === "agy" || baseAgent === "antigravity") return "google";
  if (baseAgent === "opencode" || baseAgent === "opencode2") return "deepseek";
  if (baseAgent === "zcode") return "zhipu";
  if (baseAgent === "kimi") return "moonshot";
  if (baseAgent === "grok") return "xai";
  if (baseAgent === "cursor" || baseAgent === "cursor-agent") return "cursor";
  return null;
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

export function resolveAuthorStepIds(step, byId = {}) {
  if (!isCrossFamilyReviewStep(step)) return [];
  if (Array.isArray(step.crossFamilyWith) && step.crossFamilyWith.length > 0) {
    return [...new Set(step.crossFamilyWith.map((x) => String(x || "").trim()).filter((id) => id && (!Object.keys(byId).length || byId[id])))];
  }
  if (typeof step.crossFamilyWith === "string" && step.crossFamilyWith.trim()) {
    const id = step.crossFamilyWith.trim();
    return (!Object.keys(byId).length || byId[id]) ? [id] : [];
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

  // Bracketed IPv6 [::1]:3425 or host:port
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
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    const finish = (ok, reason = null, code = null) => {
      if (done) return;
      done = true;
      try { sock?.destroy(); } catch {}
      resolve({ ok, host: normHost, port: numPort, reason: reason ? sanitizeText(reason, { maxLen: 220 }) : null, code });
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
    // Always cancel/release response body stream so local HTTP sockets are never left dangling
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

  // Strip trailing commas before } or ] outside strings
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
 * Inspect opencode.json / opencode.jsonc files (merging global -> project -> OPENCODE_CONFIG)
 * to auto-discover localhost provider baseURLs for the effective model.
 * If the effective model (step model or configured default `model`) targets a cloud provider,
 * unrelated localhost providers in the config are NOT probed.
 */
export function discoverOpencodeLocalEndpoints({ projectDir = process.cwd(), model = null, configPaths = null } = {}) {
  const home = homedir();
  // Precedence from lowest (global) to highest (project -> explicit OPENCODE_CONFIG)
  const orderedPaths = configPaths
    ? [...configPaths].reverse()
    : [
      join(home, ".config", "opencode2", "opencode.jsonc"),
      join(home, ".config", "opencode2", "opencode.json"),
      join(home, ".config", "opencode", "opencode.jsonc"),
      join(home, ".config", "opencode", "opencode.json"),
      projectDir ? join(projectDir, ".opencode", "opencode.jsonc") : null,
      projectDir ? join(projectDir, ".opencode", "opencode.json") : null,
      projectDir ? join(projectDir, "opencode.jsonc") : null,
      projectDir ? join(projectDir, "opencode.json") : null,
      process.env.OPENCODE_CONFIG || null,
    ].filter(Boolean);

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

  const effectiveModel = (typeof model === "string" && model.trim() && model.trim() !== "default")
    ? model.trim()
    : configuredModel;
  const modelPrefix = typeof effectiveModel === "string" && effectiveModel.includes("/")
    ? effectiveModel.split("/")[0]
    : null;

  let candidateProviders = [];
  if (modelPrefix) {
    // Explicit or configured model specifies a provider prefix:
    // ONLY inspect that exact provider. If it is a cloud/built-in provider not in mergedProviders,
    // do NOT probe unrelated localhost providers!
    if (mergedProviders[modelPrefix] && !disabledProviders.has(modelPrefix)) {
      candidateProviders = [[modelPrefix, mergedProviders[modelPrefix]]];
    } else {
      return [];
    }
  } else {
    candidateProviders = Object.entries(mergedProviders).filter(([name]) => {
      if (disabledProviders.has(name)) return false;
      if (enabledProviders && !enabledProviders.has(name)) return false;
      return true;
    });
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

export function normalizeCandidate(raw, isPrimary = false) {
  if (!raw) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return {
      agent: trimmed,
      model: null,
      effort: null,
      preflight: null,
      isPrimary,
      family: classifyModelFamily(trimmed, null),
    };
  }
  if (typeof raw !== "object" || !raw.agent) return null;
  const agent = String(raw.agent).trim();
  if (!agent) return null;
  const model = raw.model != null && String(raw.model).trim() && String(raw.model).trim() !== "default"
    ? String(raw.model).trim()
    : null;
  return {
    agent,
    model,
    effort: raw.effort ? String(raw.effort).trim() : null,
    preflight: raw.preflight && typeof raw.preflight === "object" ? raw.preflight : null,
    isPrimary,
    family: classifyModelFamily(agent, model),
  };
}

export function buildCandidateChain(step, cfg = {}, { agentOf, modelOf, forbiddenFamilies = null } = {}) {
  const primaryAgent = agentOf ? agentOf(step) : step.agent;
  const primaryModel = modelOf ? modelOf(step) : (step.model && step.model !== "default" ? step.model : null);
  const primary = normalizeCandidate({
    agent: primaryAgent,
    model: primaryModel,
    effort: step.effort || cfg?.defaults?.effort || null,
    preflight: step.preflight || null,
  }, true);

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

  // Review gates NEVER inherit unrestricted global `defaults.fallback` unless explicitly opted in,
  // preventing a coordinator/coder global fallback from silently self-reviewing contracts or code.
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
    if (isReview && forbiddenSet && forbiddenSet.size > 0 && cand.family && forbiddenSet.has(cand.family)) {
      return;
    }
    const key = `${cand.agent}::${cand.model || ""}::${cand.effort || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    chain.push(cand);
  };

  pushUnique(primary);
  for (const r of rawList) pushUnique(normalizeCandidate(r, false));
  return chain;
}

/**
 * Filter a candidate chain against upstream author families, returning both the
 * allowed cross-family candidates and detailed records of rejected candidates.
 */
export function filterCrossFamilyCandidates(chain, forbiddenByFamily = new Map()) {
  if (!forbiddenByFamily || forbiddenByFamily.size === 0) {
    return { allowed: chain, rejected: [] };
  }
  const allowed = [];
  const rejected = [];
  for (const cand of chain || []) {
    const fam = cand.family ?? classifyModelFamily(cand.agent, cand.model);
    if (fam && forbiddenByFamily.has(fam)) {
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
    } else {
      allowed.push(cand);
    }
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

  // 1) Optional CLI binary presence check (explicitly opted in)
  const shouldCheckBin = Boolean(candPf.checkBin ?? globalPf.checkBin ?? false);
  if (shouldCheckBin) {
    const b = probeBinaryFn(candidate.agent);
    checks.push({ type: "binary", ...b });
    if (!b.ok) return { ok: false, checks, reason: b.reason, code: "BIN_NOT_FOUND" };
  }

  // 2) Explicit TCP check (with strict port & IPv6 validation)
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

  // 3) Explicit HTTP check
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

  // 4) Auto-detect local OpenCode / Magpie gateway endpoints when agent is opencode / opencode2
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

/**
 * Evaluate candidate chain in order and return the first healthy candidate.
 * If primary fails and a healthy fallback is found, returns `downgraded: true`
 * along with failure details for ledger & operator logs.
 */
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
