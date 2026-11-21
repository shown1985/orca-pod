// Activity-aware Watchdog supervisor for Orca-Pod workers.
// Replaces blind fixed-timeout killing with continuous liveness & progress monitoring:
//   - Distinguishes healthy long-running progress (git/file/artifact/output deltas) from real hangs
//   - Detects output dead-loops (repeating error/cycle patterns with zero file/git progress)
//   - Detects stalled/hung workers (long silence + zero file/git/artifact progress)
//   - Detects interactive/trust prompt blocking (agent_prompt_blocked, workspace trust dialogs)
//   - Detects gateway disconnects (ECONNREFUSED, ECONNRESET, 502/503/504, fetch failed)
// Zero external dependencies (Node >= 18).

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const WATCHDOG_PARKED_PROMPTS = [
  { sig: "Do you trust the contents of this project?", label: "the workspace-trust dialog (agent_prompt_blocked)" },
  { sig: "Do you trust the files in this folder?", label: "the workspace-trust dialog (agent_prompt_blocked)" },
  { sig: "Trust this workspace", label: "the workspace-trust dialog (agent_prompt_blocked)" },
  { sig: "agent_prompt_blocked", label: "an interactive prompt block (agent_prompt_blocked)" },
  { sig: "requires confirmation for this command", label: "a permission-rule confirmation" },
  { sig: "Do you want to proceed?", label: "a permission confirmation" },
  { sig: "Quick safety check", label: "the folder-trust check" },
  { sig: "Yes, I trust this folder", label: "the folder-trust check" },
  { sig: "Update available", label: "a CLI update prompt" },
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

export function detectPromptBlocked(preview, agentWait = null) {
  if (typeof preview === "string" && preview.length > 0) {
    const clean = stripAnsi(preview);
    const hit = WATCHDOG_PARKED_PROMPTS.find((p) => clean.includes(p.sig));
    if (hit) {
      return {
        matched: true,
        kind: "prompt_blocked",
        sig: hit.sig,
        label: hit.label,
        diagnosis: `Worker blocked on ${hit.label} (matched "${hit.sig}")`,
      };
    }
  }
  if (agentWait && typeof agentWait === "object" && !Array.isArray(agentWait) && Object.keys(agentWait).length > 0) {
    const reason = agentWait.kind || agentWait.reason || "external approval";
    return {
      matched: true,
      kind: "prompt_blocked",
      sig: String(reason),
      label: `agentWait (${reason})`,
      diagnosis: `Worker blocked waiting on ${reason}`,
    };
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
      const snippet = clean.slice(idx, idx + 180).replace(/\s+/g, " ").trim();
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

  // 1) Intra-preview repetition: same non-trivial line repeated consecutively in latest tail
  if (Array.isArray(latestLines) && latestLines.length >= th) {
    let run = 1;
    for (let i = 1; i < latestLines.length; i++) {
      const cur = latestLines[i];
      if (cur.length >= 16 && cur === latestLines[i - 1]) {
        run += 1;
        if (run >= th + 1) {
          return {
            matched: true,
            kind: "output_loop",
            pattern: "intra_preview_repeat",
            repeats: run,
            sample: cur.slice(0, 140),
            diagnosis: `Output dead-loop detected: identical line repeated ${run}x without file/git progress ("${cur.slice(0, 100)}")`,
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
    const sample = nonEmpty[0].split("\n").slice(-1)[0] || nonEmpty[0].slice(0, 120);
    return {
      matched: true,
      kind: "output_loop",
      pattern: "cross_slice_repeat",
      repeats: th,
      sample: sample.slice(0, 140),
      diagnosis: `Output dead-loop detected: normalized terminal tail repeated ${th}x with zero file/git progress ("${sample.slice(0, 100)}")`,
    };
  }

  // 2b) Period-2 oscillation (A, B, A, B, ...) across at least max(4, th) slices
  const cycLen = Math.max(4, th);
  if (history.length >= cycLen) {
    const seg = history.slice(-cycLen);
    if (seg.every((x) => x && x.length >= 16) && seg[0] !== seg[1]) {
      const isAlternating = seg.every((x, idx) => x === seg[idx % 2]);
      if (isAlternating) {
        const sample = seg[0].split("\n").slice(-1)[0] || seg[0].slice(0, 120);
        return {
          matched: true,
          kind: "output_loop",
          pattern: "period2_cycle",
          repeats: cycLen,
          sample: sample.slice(0, 140),
          diagnosis: `Output dead-loop detected: terminal output cycling between 2 states across ${cycLen} slices without progress ("${sample.slice(0, 100)}")`,
        };
      }
    }
  }

  return null;
}

export function probeWorktreeActivity(worktreeDir, { artifactPath = null, artDirPath = null } = {}) {
  let gitFingerprint = "";
  if (worktreeDir && existsSync(worktreeDir)) {
    const st = spawnSync("git", ["-C", worktreeDir, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (!st.error && st.status === 0) {
      const diff = spawnSync("git", ["-C", worktreeDir, "diff", "--shortstat"], {
        encoding: "utf8",
        timeout: 2000,
      });
      const head = spawnSync("git", ["-C", worktreeDir, "rev-parse", "--verify", "--quiet", "HEAD"], {
        encoding: "utf8",
        timeout: 2000,
      });
      gitFingerprint = [
        (head.stdout || "").trim(),
        (st.stdout || "").trim(),
        (diff.stdout || "").trim(),
      ].join("|");
    }
  }

  let artifactSize = 0;
  let artifactMtime = 0;
  if (artifactPath && existsSync(artifactPath)) {
    try {
      const s = statSync(artifactPath);
      artifactSize = s.size;
      artifactMtime = Math.floor(s.mtimeMs);
    } catch {}
  }

  const artEntries = [];
  if (artDirPath && existsSync(artDirPath)) {
    try {
      for (const name of readdirSync(artDirPath)) {
        // Ignore orchestrator-generated dashboard snapshots (status.*, <artifact>.js, *.tmp, ISSUES.*, WORKTREES.*)
        if (
          name === "status.js" || name === "status.html" || name === "status.json" ||
          name === "ISSUES.json" || name === "ISSUES.md" || name === "WORKTREES.json" ||
          name.endsWith(".md.js") || name.endsWith(".json.js") || name.endsWith(".tmp")
        ) continue;
        try {
          const s = statSync(join(artDirPath, name));
          if (s.isFile()) artEntries.push(`${name}:${s.size}:${Math.floor(s.mtimeMs)}`);
        } catch {}
      }
    } catch {}
  }
  artEntries.sort();
  const artifactFingerprint = `${artifactSize}:${artifactMtime}|${artEntries.join(",")}`;
  return { gitFingerprint, artifactFingerprint, artifactSize };
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
  artDirPath = null,
  probeFn = probeWorktreeActivity,
} = {}) {
  const config = resolveWatchdogConfig(step, cfg);
  const initial = probeFn(worktreeDir, { artifactPath, artDirPath });
  return {
    config,
    startedAt,
    worktreeDir,
    artifactPath,
    artDirPath,
    probeFn,
    lastGitFingerprint: initial.gitFingerprint,
    lastArtifactFingerprint: initial.artifactFingerprint,
    lastArtifactSize: initial.artifactSize,
    lastProgressAt: startedAt,
    lastRealCodeProgressAt: 0,
    previewHistory: [],
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

  if (!cfg.enabled) {
    return {
      status: "healthy",
      kind: null,
      action: "continue",
      activeProgress: false,
      gitChanged: false,
      artifactChanged: false,
      extendDeadline: false,
      diagnosis: null,
      evidence: null,
      parked: null,
    };
  }

  const probe = obs.probeOverride || w.probeFn(w.worktreeDir, {
    artifactPath: w.artifactPath,
    artDirPath: w.artDirPath,
  });
  const gitChanged = Boolean(probe.gitFingerprint && probe.gitFingerprint !== w.lastGitFingerprint);
  const artifactChanged = Boolean(
    probe.artifactFingerprint && probe.artifactFingerprint !== w.lastArtifactFingerprint
  );
  if (gitChanged) {
    w.lastGitFingerprint = probe.gitFingerprint;
    w.lastRealCodeProgressAt = now;
  }
  if (artifactChanged) {
    w.lastArtifactFingerprint = probe.artifactFingerprint;
    w.lastArtifactSize = probe.artifactSize;
    w.lastRealCodeProgressAt = now;
  }

  const preview = typeof obs.preview === "string" ? obs.preview : null;
  const { tail, lines } = normalizePreviewTail(preview);

  // 1) Immediate check: Gateway disconnect (ECONNREFUSED, 502/503/504, fetch failed, etc.)
  const gw = detectGatewayDisconnect(preview);
  if (gw) {
    const action = (cfg.fallbackOnGatewayError && fallbackAvailable) ? "fallback" : "escalate";
    const ev = { signature: gw.signature, snippet: gw.snippet };
    w.anomalies.push({ at: now, kind: gw.kind, action, diagnosis: gw.diagnosis });
    return {
      status: "anomaly",
      kind: gw.kind,
      action,
      activeProgress: false,
      gitChanged,
      artifactChanged,
      extendDeadline: false,
      diagnosis: gw.diagnosis,
      evidence: ev,
      parked: null,
    };
  }

  // 2) Interactive / Workspace trust prompt block
  const pb = detectPromptBlocked(preview, obs.agentWait);
  if (pb) {
    const action = (cfg.fallbackOnPromptBlocked && fallbackAvailable) ? "fallback" : "block";
    const ev = { sig: pb.sig, label: pb.label };
    w.anomalies.push({ at: now, kind: pb.kind, action, diagnosis: pb.diagnosis });
    return {
      status: "anomaly",
      kind: pb.kind,
      action,
      activeProgress: false,
      gitChanged,
      artifactChanged,
      extendDeadline: false,
      diagnosis: pb.diagnosis,
      evidence: ev,
      parked: { sig: pb.sig, label: pb.label },
    };
  }

  // 3) Output dead-loop detection (only when no real git/artifact progress occurred)
  if (obs.previewChanged && obs.previewSeenBefore && tail) {
    w.previewHistory.push(tail);
    if (w.previewHistory.length > (cfg.loopWindowSize || 10)) {
      w.previewHistory.shift();
    }
  }
  if (!gitChanged && !artifactChanged) {
    const loop = detectOutputLoop(w.previewHistory, lines, { threshold: cfg.loopThreshold });
    if (loop) {
      const action = (cfg.fallbackOnLoop && fallbackAvailable) ? "fallback" : "escalate";
      w.anomalies.push({ at: now, kind: loop.kind, action, diagnosis: loop.diagnosis });
      return {
        status: "anomaly",
        kind: loop.kind,
        action,
        activeProgress: false,
        gitChanged,
        artifactChanged,
        extendDeadline: false,
        diagnosis: loop.diagnosis,
        evidence: { pattern: loop.pattern, repeats: loop.repeats, sample: loop.sample },
        parked: null,
      };
    }
  } else {
    // Real file/git progress resets output loop suspicion
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
    w.anomalies.push({ at: now, kind: "stalled_hang", action, diagnosis });
    return {
      status: "anomaly",
      kind: "stalled_hang",
      action,
      activeProgress: false,
      gitChanged,
      artifactChanged,
      extendDeadline: false,
      diagnosis,
      evidence: { noProgressMs, stallTimeoutMs: cfg.stallTimeoutMs },
      parked: null,
    };
  }

  // 6) Activity-aware deadline extension: never blind-kill a healthy worker making real progress
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
    diagnosis: null,
    evidence: activeProgress ? { gitChanged, artifactChanged, nonLoopPreviewProgress } : null,
    parked: null,
  };
}
