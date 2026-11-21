// Activity-aware Watchdog supervisor for Orca-Pod workers.
// Replaces blind fixed-timeout killing with continuous liveness & progress monitoring:
//   - Distinguishes healthy long-running progress (git/file/artifact/output deltas) from real hangs
//   - Detects output dead-loops (repeating error/cycle patterns with zero file/git progress)
//   - Detects stalled/hung workers (long silence + zero file/git/artifact progress)
//   - Distinguishes unattended workspace-trust CLI blocks from normal human approval waits
//   - Scans newly appended terminal deltas for gateway disconnects (ignoring recovered historic lines)
//   - Deduplicates repeated anomaly events and redacts secrets/PII from snippets
// Zero external dependencies (Node >= 18).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sanitizeText } from "./lib/sanitize.mjs";

export const WATCHDOG_PARKED_PROMPTS = [
  { sig: "Do you trust the contents of this project?", label: "the workspace-trust dialog (agent_prompt_blocked)", trustBlock: true },
  { sig: "Do you trust the files in this folder?", label: "the workspace-trust dialog (agent_prompt_blocked)", trustBlock: true },
  { sig: "Trust this workspace", label: "the workspace-trust dialog (agent_prompt_blocked)", trustBlock: true },
  { sig: "agent_prompt_blocked", label: "an interactive prompt block (agent_prompt_blocked)", trustBlock: true },
  { sig: "Quick safety check", label: "the folder-trust check", trustBlock: true },
  { sig: "Yes, I trust this folder", label: "the folder-trust check", trustBlock: true },
  { sig: "requires confirmation for this command", label: "a permission-rule confirmation", trustBlock: false },
  { sig: "Do you want to proceed?", label: "a permission confirmation", trustBlock: false },
  { sig: "Update available", label: "a CLI update prompt", trustBlock: false },
];

export const GATEWAY_ERROR_PATTERNS = [
  { name: "ECONNREFUSED", re: /\bECONNREFUSED\b/i },
  { name: "connection_refused", re: /connection refused/i },
  { name: "ECONNRESET", re: /\bECONNRESET\b/i },
  { name: "EHOSTUNREACH", re: /\bEHOSTUNREACH\b/i },
  { name: "ETIMEDOUT", re: /connect\s+ETIMEDOUT/i },
  { name: "socket_hang_up", re: /socket hang up/i },
  { name: "fetch_failed", re: /TypeError:\s*fetch failed|Failed to connect to\s+https?:\/\//i },
  { name: "http_gateway", re: /\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b/i },
  { name: "agent_gateway_error", re: /\bagent_gateway_error\b|provider(?:\s+gateway)?\s+unavailable/i },
];

export const DEFAULT_WATCHDOG_CONFIG = {
  enabled: true,
  extendOnActivity: true,
  extendStepMs: 300000,
  activityFreshMs: 180000,
  stallTimeoutMs: 0,
  loopThreshold: 4,
  loopWindowSize: 10,
  maxRuntimeMs: 0,
  fallbackOnGatewayError: true,
  fallbackOnLoop: true,
  fallbackOnStall: true,
  fallbackOnPromptBlocked: true,
};

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const VOLATILE_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b|\b\d{1,2}:\d{2}:\d{2}\b|\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|min|mins)\b|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;
const TRUST_WAIT_KIND_RE = /^(?:workspace_trust|folder_trust|trust|agent_prompt_blocked)$/i;

export function stripAnsi(text) {
  return typeof text === "string" ? text.replace(ANSI_RE, "") : "";
}

export function normalizePreviewTail(preview, maxLines = 24) {
  if (typeof preview !== "string" || !preview.trim()) return { tail: "", lines: [] };
  const cleaned = stripAnsi(preview);
  const rawLines = cleaned
    .split(/\r?\n/)
    .map((l) => l.replace(VOLATILE_RE, "<T>").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const lines = rawLines.slice(-maxLines);
  return { tail: lines.join("\n"), lines };
}

/**
 * Extract only newly appended lines from `curPreview` compared to `prevPreview`
 * so historical errors that scrolled by before recovery do not re-trigger fallback.
 */
export function extractPreviewDelta(prevPreview, curPreview, maxTailLines = 12) {
  const curClean = stripAnsi(curPreview || "");
  if (!curClean.trim()) return "";
  const prevClean = stripAnsi(prevPreview || "");
  if (!prevClean.trim()) {
    return curClean.split(/\r?\n/).filter((l) => l.trim()).slice(-maxTailLines).join("\n");
  }
  if (curClean === prevClean) return "";
  if (curClean.startsWith(prevClean)) {
    const added = curClean.slice(prevClean.length);
    return added.split(/\r?\n/).filter((l) => l.trim()).slice(-maxTailLines).join("\n");
  }

  const prevLines = prevClean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const curLines = curClean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!prevLines.length) return curLines.slice(-maxTailLines).join("\n");

  // Find longest suffix of prevLines matching a contiguous slice in curLines
  const anchorLen = Math.min(3, prevLines.length);
  const anchor = prevLines.slice(-anchorLen);
  for (let i = curLines.length - anchorLen; i >= 0; i--) {
    let match = true;
    for (let k = 0; k < anchorLen; k++) {
      if (curLines[i + k] !== anchor[k]) { match = false; break; }
    }
    if (match) {
      return curLines.slice(i + anchorLen).slice(-maxTailLines).join("\n");
    }
  }
  // Fallback: match the single last line of prevLines
  const lastPrev = prevLines[prevLines.length - 1];
  const lastIdx = curLines.lastIndexOf(lastPrev);
  if (lastIdx >= 0) {
    return curLines.slice(lastIdx + 1).slice(-maxTailLines).join("\n");
  }
  return curLines.slice(-maxTailLines).join("\n");
}

export function detectPromptBlocked(preview, agentWait = null) {
  // Check structured Orca agentWait first: distinguish normal human approval (`user_approval`)
  // from workspace-trust / startup prompt blocks (`trustBlock`).
  if (agentWait && typeof agentWait === "object" && !Array.isArray(agentWait) && Object.keys(agentWait).length > 0) {
    const rawReason = String(agentWait.kind || agentWait.reason || "external approval");
    const safeReason = sanitizeText(rawReason, { maxLen: 80 });
    const isTrust = TRUST_WAIT_KIND_RE.test(rawReason.trim());
    return {
      matched: true,
      kind: "prompt_blocked",
      trustBlock: isTrust,
      humanApproval: !isTrust,
      sig: safeReason,
      label: `agentWait (${safeReason})`,
      diagnosis: isTrust
        ? `Worker blocked on unattended startup/trust prompt (${safeReason})`
        : `Worker waiting on human approval (${safeReason})`,
    };
  }

  if (typeof preview === "string" && preview.length > 0) {
    // Inspect only the active bottom tail (last 12 non-empty lines) so answered prompts higher up don't re-match
    const tailText = stripAnsi(preview).split(/\r?\n/).filter((l) => l.trim()).slice(-12).join("\n");
    const hit = WATCHDOG_PARKED_PROMPTS.find((p) => tailText.includes(p.sig));
    if (hit) {
      return {
        matched: true,
        kind: "prompt_blocked",
        trustBlock: Boolean(hit.trustBlock),
        humanApproval: !hit.trustBlock,
        sig: hit.sig,
        label: hit.label,
        diagnosis: `Worker blocked on ${hit.label} (matched "${hit.sig}")`,
      };
    }
  }
  return null;
}

export function detectGatewayDisconnect(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const clean = stripAnsi(text);
  for (const p of GATEWAY_ERROR_PATTERNS) {
    const m = clean.match(p.re);
    if (m) {
      const idx = Math.max(0, (m.index ?? 0) - 60);
      const rawSnippet = clean.slice(idx, idx + 180).replace(/\s+/g, " ").trim();
      const snippet = sanitizeText(rawSnippet, { maxLen: 180 });
      return {
        matched: true,
        kind: "gateway_disconnect",
        signature: p.name,
        snippet,
        diagnosis: `Gateway/provider disconnect detected (${p.name}): ${snippet}`,
      };
    }
  }
  return null;
}

export function detectOutputLoop(history, latestLines = [], { threshold = 4 } = {}) {
  const th = Math.max(3, Number(threshold) || 4);

  // 1) Intra-preview repetition: `th` identical consecutive non-trivial lines in latest tail
  if (Array.isArray(latestLines) && latestLines.length >= th) {
    let run = 1;
    for (let i = 1; i < latestLines.length; i++) {
      const cur = latestLines[i];
      if (cur.length >= 16 && cur === latestLines[i - 1]) {
        run += 1;
        if (run >= th) {
          const safeSample = sanitizeText(cur, { maxLen: 140 });
          return {
            matched: true,
            kind: "output_loop",
            pattern: "intra_preview_repeat",
            repeats: run,
            sample: safeSample,
            diagnosis: `Output dead-loop detected: identical line repeated ${run}x without file/git progress ("${sanitizeText(cur, { maxLen: 100 })}")`,
          };
        }
      } else {
        run = 1;
      }
    }
  }

  // 2) Cross-slice repetition across changed snapshots (identical tail or A-B-A-B cycle)
  if (!Array.isArray(history) || history.length < th) return null;
  const recent = history.slice(-th);
  const nonEmpty = recent.filter((x) => x && x.length >= 16);
  if (nonEmpty.length < th) return null;

  // 2a) Same normalized tail repeating across `th` changed slices (e.g. timestamps/spinners moving, content stuck)
  if (nonEmpty.every((x) => x === nonEmpty[0])) {
    const rawSample = nonEmpty[0].split("\n").slice(-1)[0] || nonEmpty[0].slice(0, 120);
    const sample = sanitizeText(rawSample, { maxLen: 140 });
    return {
      matched: true,
      kind: "output_loop",
      pattern: "cross_slice_repeat",
      repeats: th,
      sample,
      diagnosis: `Output dead-loop detected: normalized terminal tail repeated ${th}x with zero file/git progress ("${sanitizeText(rawSample, { maxLen: 100 })}")`,
    };
  }

  // 2b) Period-2 oscillation (A, B, A, B, ...) across at least max(4, th) slices
  const cycLen = Math.max(4, th);
  if (history.length >= cycLen) {
    const seg = history.slice(-cycLen);
    if (seg.every((x) => x && x.length >= 16) && seg[0] !== seg[1]) {
      const isAlternating = seg.every((x, idx) => x === seg[idx % 2]);
      if (isAlternating) {
        const rawSample = seg[0].split("\n").slice(-1)[0] || seg[0].slice(0, 120);
        const sample = sanitizeText(rawSample, { maxLen: 140 });
        return {
          matched: true,
          kind: "output_loop",
          pattern: "period2_cycle",
          repeats: cycLen,
          sample,
          diagnosis: `Output dead-loop detected: terminal output cycling between 2 states across ${cycLen} slices without progress ("${sanitizeText(rawSample, { maxLen: 100 })}")`,
        };
      }
    }
  }

  return null;
}

function hashFileQuick(filePath, maxBytes = 512 * 1024) {
  try {
    const s = statSync(filePath);
    if (!s.isFile()) return null;
    const h = createHash("sha256");
    h.update(`${s.size}:${Math.floor(s.mtimeMs)}:`);
    if (s.size <= maxBytes) {
      h.update(readFileSync(filePath));
    }
    return { size: s.size, mtime: Math.floor(s.mtimeMs), digest: h.digest("hex").slice(0, 20) };
  } catch {
    return null;
  }
}

export function probeWorktreeActivity(worktreeDir, {
  artifactPath = null,
  progressPath = null,
  artDirPath = null,
  sharedWorktree = false,
} = {}) {
  let gitFingerprint = null;
  let gitOk = false;

  if (worktreeDir && existsSync(worktreeDir)) {
    const st = spawnSync("git", ["--no-optional-locks", "-C", worktreeDir, "status", "--porcelain", "-uall", "-z"], {
      encoding: "utf8",
      timeout: 2500,
    });
    const head = spawnSync("git", ["--no-optional-locks", "-C", worktreeDir, "rev-parse", "--verify", "--quiet", "HEAD"], {
      encoding: "utf8",
      timeout: 2000,
    });
    // Treat git command failure/timeout as unknown (null), never as an empty string that fakes progress later
    if (!st.error && st.status === 0) {
      gitOk = true;
      const headSha = (!head.error && head.status === 0) ? (head.stdout || "").trim() : "NO_HEAD";
      const entries = (st.stdout || "").split("\0").filter(Boolean);
      const fileDigests = [];
      let inspected = 0;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.length < 4) continue;
        const xy = entry.slice(0, 2);
        const relPath = entry.slice(3);
        // In porcelain -z, rename/copy has an extra NUL-terminated source path entry following
        if (xy.includes("R") || xy.includes("C")) i++;
        if (relPath.startsWith(".orca/artifacts/") || relPath === ".orca-agent-config.json") continue;
        if (inspected < 200) {
          inspected++;
          const info = hashFileQuick(join(worktreeDir, relPath));
          fileDigests.push(info ? `${xy}:${relPath}:${info.digest}` : `${xy}:${relPath}:gone`);
        } else {
          fileDigests.push(`${xy}:${relPath}`);
        }
      }
      fileDigests.sort();
      const gh = createHash("sha256");
      gh.update(`${headSha}\n${fileDigests.join("\n")}`);
      gitFingerprint = gh.digest("hex").slice(0, 32);
    }
  }

  let artifactSize = 0;
  const ownParts = [];
  if (artifactPath) {
    const info = hashFileQuick(artifactPath);
    if (info) {
      artifactSize = info.size;
      ownParts.push(`writes:${info.size}:${info.digest}`);
    }
  }
  if (progressPath) {
    const pInfo = hashFileQuick(progressPath);
    if (pInfo) {
      ownParts.push(`progress:${pInfo.size}:${pInfo.digest}`);
    }
  }

  const artEntries = [];
  // Only scan sibling files in artDirPath when this worker exclusively owns the worktree
  if (!sharedWorktree && artDirPath && existsSync(artDirPath)) {
    try {
      for (const name of readdirSync(artDirPath)) {
        if (
          name === "status.js" || name === "status.html" || name === "status.json" ||
          name === "ISSUES.json" || name === "ISSUES.md" || name === "WORKTREES.json" ||
          name.endsWith(".md.js") || name.endsWith(".json.js") || name.endsWith(".tmp") ||
          name.includes(".tmp.")
        ) continue;
        const info = hashFileQuick(join(artDirPath, name), 256 * 1024);
        if (info) artEntries.push(`${name}:${info.size}:${info.digest}`);
      }
    } catch {}
  }
  artEntries.sort();
  const artifactFingerprint = `${ownParts.join("|")}||${artEntries.join(",")}`;
  return { gitFingerprint, gitOk, artifactFingerprint, artifactSize };
}

export function resolveWatchdogConfig(step = {}, cfg = {}) {
  const globalW = cfg?.defaults?.watchdog && typeof cfg.defaults.watchdog === "object" ? cfg.defaults.watchdog : {};
  const stepW = step?.watchdog && typeof step.watchdog === "object" ? step.watchdog : {};
  return {
    ...DEFAULT_WATCHDOG_CONFIG,
    ...globalW,
    ...stepW,
  };
}

export function createWatchdogTracker({
  step = {},
  cfg = {},
  startedAt = Date.now(),
  worktreeDir = null,
  artifactPath = null,
  progressPath = null,
  artDirPath = null,
  sharedWorktree = false,
  probeFn = probeWorktreeActivity,
} = {}) {
  const config = resolveWatchdogConfig(step, cfg);
  const initial = probeFn(worktreeDir, { artifactPath, progressPath, artDirPath, sharedWorktree });
  return {
    config,
    startedAt,
    worktreeDir,
    artifactPath,
    progressPath,
    artDirPath,
    sharedWorktree: Boolean(sharedWorktree),
    probeFn,
    lastGitFingerprint: initial.gitFingerprint ?? null,
    lastArtifactFingerprint: initial.artifactFingerprint,
    lastArtifactSize: initial.artifactSize,
    lastRawPreview: "",
    lastProgressAt: startedAt,
    lastRealCodeProgressAt: 0,
    previewHistory: [],
    emittedAnomalyKeys: new Set(),
    extensionsCount: 0,
    anomalies: [],
    lastEvaluatedAt: startedAt,
  };
}

export function evaluateWatchdog(w, obs = {}) {
  const now = obs.now ?? Date.now();
  w.lastEvaluatedAt = now;
  const cfg = w.config;
  const fallbackAvailable = Boolean(obs.fallbackAvailable);
  const sharedWorktree = obs.sharedWorktree !== undefined ? Boolean(obs.sharedWorktree) : Boolean(w.sharedWorktree);

  if (!cfg.enabled) {
    return {
      status: "healthy",
      kind: null,
      action: "continue",
      activeProgress: false,
      gitChanged: false,
      artifactChanged: false,
      extendDeadline: false,
      deduplicated: false,
      diagnosis: null,
      evidence: null,
      parked: null,
    };
  }

  const probe = obs.probeOverride || w.probeFn(w.worktreeDir, {
    artifactPath: w.artifactPath,
    progressPath: w.progressPath,
    artDirPath: w.artDirPath,
    sharedWorktree,
  });

  // Treat null gitFingerprint (probe error/not-a-git-repo) as unknown, never as fake progress.
  // In a shared worktree with multiple concurrent members, do NOT attribute shared git diffs to solo progress.
  let rawGitChanged = false;
  if (probe.gitFingerprint != null) {
    if (w.lastGitFingerprint == null) {
      w.lastGitFingerprint = probe.gitFingerprint;
    } else if (probe.gitFingerprint !== w.lastGitFingerprint) {
      w.lastGitFingerprint = probe.gitFingerprint;
      rawGitChanged = true;
    }
  }
  const gitChanged = sharedWorktree ? false : rawGitChanged;

  const artifactChanged = Boolean(
    probe.artifactFingerprint != null && probe.artifactFingerprint !== w.lastArtifactFingerprint
  );
  if (gitChanged) {
    w.lastRealCodeProgressAt = now;
  }
  if (artifactChanged) {
    w.lastArtifactFingerprint = probe.artifactFingerprint;
    w.lastArtifactSize = probe.artifactSize;
    w.lastRealCodeProgressAt = now;
  }

  const realProgressNow = gitChanged || artifactChanged;
  if (realProgressNow) {
    // Real code/artifact progress clears prior anomaly dedup latches & loop history
    w.emittedAnomalyKeys.clear();
  }

  const preview = typeof obs.preview === "string" ? obs.preview : null;
  const freshDelta = preview != null ? extractPreviewDelta(w.lastRawPreview, preview, 12) : "";
  if (preview != null) {
    w.lastRawPreview = preview;
  }
  const { tail, lines } = normalizePreviewTail(preview);

  const emitAnomaly = ({ kind, dedupSig, action, diagnosis, evidence, parked = null }) => {
    const key = `${kind}:${action}:${dedupSig}`;
    const deduplicated = w.emittedAnomalyKeys.has(key);
    if (!deduplicated) {
      w.emittedAnomalyKeys.add(key);
      w.anomalies.push({ at: now, kind, action, diagnosis });
    }
    return {
      status: "anomaly",
      kind,
      action,
      activeProgress: false,
      gitChanged,
      artifactChanged,
      extendDeadline: false,
      deduplicated,
      diagnosis,
      evidence,
      parked,
    };
  };

  // 1) Gateway disconnect check: ONLY scan newly appended preview delta, and skip if worker just made real git/artifact progress
  if (!realProgressNow && freshDelta) {
    const gw = detectGatewayDisconnect(freshDelta);
    if (gw) {
      // Check if subsequent lines in the same delta already recovered (last 2 lines have no error while >3 lines followed)
      const deltaLines = freshDelta.split(/\r?\n/).filter((l) => l.trim());
      const lastErrorLineIdx = deltaLines.reduce((acc, l, idx) => (detectGatewayDisconnect(l) ? idx : acc), -1);
      const trailingHealthyLines = lastErrorLineIdx >= 0 ? (deltaLines.length - 1 - lastErrorLineIdx) : 0;
      if (trailingHealthyLines < 3) {
        const action = (cfg.fallbackOnGatewayError && fallbackAvailable) ? "fallback" : "escalate";
        return emitAnomaly({
          kind: gw.kind,
          dedupSig: gw.signature,
          action,
          diagnosis: gw.diagnosis,
          evidence: { signature: gw.signature, snippet: gw.snippet },
        });
      }
    }
  }

  // 2) Interactive / Workspace trust vs Human approval prompt check
  const pb = detectPromptBlocked(preview, obs.agentWait);
  if (pb) {
    // Human approval (`user_approval` / permission prompt) MUST block & notify, NEVER blindly fallback!
    const canFallback = Boolean(pb.trustBlock && !pb.humanApproval && cfg.fallbackOnPromptBlocked && fallbackAvailable);
    const action = canFallback ? "fallback" : "block";
    return emitAnomaly({
      kind: pb.kind,
      dedupSig: pb.sig,
      action,
      diagnosis: pb.diagnosis,
      evidence: { sig: pb.sig, label: pb.label, trustBlock: pb.trustBlock, humanApproval: pb.humanApproval },
      parked: { sig: pb.sig, label: pb.label },
    });
  }

  // 3) Output dead-loop detection (only when output actually changed and no real git/artifact progress occurred)
  const previewDidAdvance = obs.previewChanged !== false;
  if (obs.previewChanged && obs.previewSeenBefore && tail) {
    w.previewHistory.push(tail);
    if (w.previewHistory.length > (cfg.loopWindowSize || 10)) {
      w.previewHistory.shift();
    }
  }
  if (!realProgressNow && previewDidAdvance) {
    const loop = detectOutputLoop(w.previewHistory, lines, { threshold: cfg.loopThreshold });
    if (loop) {
      const action = (cfg.fallbackOnLoop && fallbackAvailable) ? "fallback" : "escalate";
      return emitAnomaly({
        kind: loop.kind,
        dedupSig: `${loop.pattern}:${loop.sample.slice(0, 48)}`,
        action,
        diagnosis: loop.diagnosis,
        evidence: { pattern: loop.pattern, repeats: loop.repeats, sample: loop.sample },
      });
    }
  } else if (realProgressNow) {
    w.previewHistory = tail ? [tail] : [];
  }

  // 4) Update effective progress clock
  const nonLoopPreviewProgress = Boolean(obs.previewChanged && obs.previewSeenBefore);
  const activeProgress = gitChanged || artifactChanged || nonLoopPreviewProgress;
  if (activeProgress) {
    w.lastProgressAt = now;
  }

  // 5) Stalled/hang detection (only when stallTimeoutMs > 0 is configured)
  const noProgressMs = Math.max(0, now - w.lastProgressAt);
  if (cfg.stallTimeoutMs > 0 && noProgressMs >= cfg.stallTimeoutMs && !activeProgress) {
    const action = (cfg.fallbackOnStall && fallbackAvailable) ? "fallback" : "escalate";
    const mins = Math.round(noProgressMs / 60000);
    const secs = Math.round(noProgressMs / 1000);
    const diagnosis = `Worker stalled/hung: zero output, file, or git progress for ${mins >= 1 ? `${mins}min` : `${secs}s`} (threshold ${Math.round(cfg.stallTimeoutMs / 1000)}s)`;
    return emitAnomaly({
      kind: "stalled_hang",
      dedupSig: `stall:${cfg.stallTimeoutMs}`,
      action,
      diagnosis,
      evidence: { noProgressMs, stallTimeoutMs: cfg.stallTimeoutMs },
    });
  }

  // 6) Activity-aware deadline extension: never blind-kill a healthy worker making real progress,
  //    while strictly respecting maxRuntimeMs ceiling when configured.
  const runtimeMs = Math.max(0, now - w.startedAt);
  const underMaxRuntime = !cfg.maxRuntimeMs || cfg.maxRuntimeMs <= 0 || runtimeMs < cfg.maxRuntimeMs;
  const recentlyProgressed = (w.lastProgressAt > w.startedAt) && (noProgressMs < (cfg.activityFreshMs || 180000));
  const extendDeadline = Boolean(cfg.extendOnActivity && underMaxRuntime && (activeProgress || recentlyProgressed));

  return {
    status: "healthy",
    kind: null,
    action: extendDeadline ? "extend" : "continue",
    activeProgress,
    gitChanged,
    artifactChanged,
    extendDeadline,
    deduplicated: false,
    diagnosis: null,
    evidence: activeProgress ? { gitChanged, artifactChanged, nonLoopPreviewProgress } : null,
    parked: null,
  };
}
