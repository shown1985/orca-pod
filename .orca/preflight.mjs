// Pre-flight worker health check & primary/fallback agent candidate resolution.
// Solves local gateway failures (e.g. Magpie 127.0.0.1:3425 down -> ECONNREFUSED)
// by checking endpoint health before dispatch and seamlessly downgrading to a
// configured fallback agent/model/effort, with structured diagnostics for ledger.
// Zero external dependencies (Node >= 18).

import net from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

export function parseHostPort(spec) {
  if (!spec || typeof spec !== "string") return null;
  const trimmed = spec.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
      return { host: u.hostname, port, url: trimmed };
    } catch {
      return null;
    }
  }
  const m = trimmed.match(/^\[?([^\]]+)\]?:(\d+)$/);
  if (!m) return null;
  return { host: m[1], port: Number(m[2]), url: null };
}

export function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, reason = null, code = null) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve({ ok, host, port, reason, code });
    };
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false, `TCP ${host}:${port} timed out after ${timeoutMs}ms`, "ETIMEDOUT"));
    sock.once("error", (err) => {
      const code = err?.code || "TCP_ERROR";
      finish(false, `TCP ${host}:${port} ${code}${err?.message ? ` (${err.message})` : ""}`, code);
    });
  });
}

export async function probeHttp(url, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: "GET", signal: ctrl.signal });
    // Any HTTP response < 500 proves the gateway/server is reachable (even 401/404 on root)
    if (resp.status >= 500) {
      return { ok: false, url, status: resp.status, reason: `HTTP ${resp.status} from ${url}`, code: `HTTP_${resp.status}` };
    }
    return { ok: true, url, status: resp.status, reason: null, code: null };
  } catch (err) {
    const causeCode = err?.cause?.code || err?.code || (err?.name === "AbortError" ? "ETIMEDOUT" : "FETCH_FAILED");
    return { ok: false, url, status: null, reason: `HTTP ${url} ${causeCode} (${err?.message || "fetch failed"})`, code: causeCode };
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
 * Inspect opencode.json files to auto-discover localhost provider baseURLs
 * (such as local Magpie proxy at http://127.0.0.1:3425/v1).
 * Only returns localhost endpoints so cloud APIs never cause false-positive preflight blocks.
 */
export function discoverOpencodeLocalEndpoints({ projectDir = process.cwd(), model = null, configPaths = null } = {}) {
  const home = homedir();
  const paths = configPaths || [
    process.env.OPENCODE_CONFIG || null,
    projectDir ? join(projectDir, "opencode.json") : null,
    projectDir ? join(projectDir, ".opencode", "opencode.json") : null,
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".config", "opencode2", "opencode.json"),
  ].filter(Boolean);

  const modelPrefix = typeof model === "string" && model.includes("/") ? model.split("/")[0] : null;
  const endpoints = [];
  const seen = new Set();

  for (const p of paths) {
    if (!existsSync(p)) continue;
    let data = null;
    try { data = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    const providers = data?.provider && typeof data.provider === "object" ? data.provider : {};
    const entries = Object.entries(providers);
    // If model explicitly names a provider prefix (e.g. "magpie/..."), prioritize/filter to that provider when present
    const matching = modelPrefix && providers[modelPrefix]
      ? [[modelPrefix, providers[modelPrefix]]]
      : entries;

    for (const [provName, provCfg] of matching) {
      const baseURL = provCfg?.options?.baseURL || provCfg?.baseURL || provCfg?.apiUrl || null;
      if (!baseURL || typeof baseURL !== "string") continue;
      const hp = parseHostPort(baseURL);
      if (!hp || !LOCAL_HOSTS.has(hp.host.toLowerCase())) continue;
      const key = `${hp.host}:${hp.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      endpoints.push({ provider: provName, host: hp.host, port: hp.port, baseURL, source: p });
    }
    if (endpoints.length) break; // Closest config wins
  }
  return endpoints;
}

export function normalizeCandidate(raw, isPrimary = false) {
  if (!raw) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? { agent: trimmed, model: null, effort: null, preflight: null, isPrimary } : null;
  }
  if (typeof raw !== "object" || !raw.agent) return null;
  const model = raw.model != null && String(raw.model).trim() && String(raw.model).trim() !== "default"
    ? String(raw.model).trim()
    : null;
  return {
    agent: String(raw.agent).trim(),
    model,
    effort: raw.effort ? String(raw.effort).trim() : null,
    preflight: raw.preflight && typeof raw.preflight === "object" ? raw.preflight : null,
    isPrimary,
  };
}

export function buildCandidateChain(step, cfg = {}, { agentOf, modelOf } = {}) {
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

  const agentFallbacks = cfg?.defaults?.agentFallbacks;
  const baseAgentName = String(primaryAgent || "").trim().split(/\s+/)[0];
  if (agentFallbacks && typeof agentFallbacks === "object") {
    const specific = agentFallbacks[primaryAgent] || agentFallbacks[baseAgentName];
    if (Array.isArray(specific)) rawList.push(...specific);
    else if (specific) rawList.push(specific);
  }

  if (cfg?.defaults?.fallback) rawList.push(cfg.defaults.fallback);
  if (Array.isArray(cfg?.defaults?.fallbacks)) rawList.push(...cfg.defaults.fallbacks);

  const chain = [];
  const seen = new Set();
  const pushUnique = (cand) => {
    if (!cand) return;
    const key = `${cand.agent}::${cand.model || ""}::${cand.effort || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    chain.push(cand);
  };

  pushUnique(primary);
  for (const r of rawList) pushUnique(normalizeCandidate(r, false));
  return chain;
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

  // 2) Explicit TCP check
  const tcpList = [];
  if (candPf.tcp) tcpList.push(...(Array.isArray(candPf.tcp) ? candPf.tcp : [candPf.tcp]));
  const baseAgent = String(candidate.agent || "").trim().split(/\s+/)[0];
  const agentPf = globalPf.agents?.[candidate.agent] || globalPf.agents?.[baseAgent] || null;
  if (agentPf?.tcp) tcpList.push(...(Array.isArray(agentPf.tcp) ? agentPf.tcp : [agentPf.tcp]));

  for (const spec of tcpList) {
    const hp = parseHostPort(spec);
    if (!hp) continue;
    const r = await probeTcpFn(hp.host, hp.port, timeoutMs);
    checks.push({ type: "tcp", ...r });
    if (!r.ok) return { ok: false, checks, reason: r.reason, code: r.code || "TCP_ERROR" };
  }

  // 3) Explicit HTTP check
  const urlList = [];
  if (candPf.url) urlList.push(...(Array.isArray(candPf.url) ? candPf.url : [candPf.url]));
  if (agentPf?.url) urlList.push(...(Array.isArray(agentPf.url) ? agentPf.url : [agentPf.url]));
  for (const url of urlList) {
    const r = await probeHttpFn(url, timeoutMs);
    checks.push({ type: "http", ...r });
    if (!r.ok) return { ok: false, checks, reason: r.reason, code: r.code || "HTTP_ERROR" };
  }

  // 4) Auto-detect local OpenCode / Magpie gateway endpoints when agent is opencode / opencode2
  const autoDetect = candPf.autoDetectOpencodeEndpoints ?? globalPf.autoDetectOpencodeEndpoints ?? true;
  if (autoDetect && /^opencode2?$/.test(baseAgent) && tcpList.length === 0 && urlList.length === 0) {
    const localEndpoints = discoverOpencodeFn({ projectDir, model: candidate.model });
    for (const ep of localEndpoints) {
      const r = await probeTcpFn(ep.host, ep.port, timeoutMs);
      checks.push({ type: "opencode_local_tcp", provider: ep.provider, source: ep.source, ...r });
      if (!r.ok) {
        return {
          ok: false,
          checks,
          reason: `OpenCode provider "${ep.provider}" (${ep.baseURL}) unreachable: ${r.reason}`,
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
    });
  }
  // All candidates failed preflight — return primary with allFailed=true so caller can decide
  return {
    candidate: chain[0],
    index: 0,
    downgraded: false,
    allFailed: true,
    failures,
  };
}
