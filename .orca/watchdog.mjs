// Activity-aware Watchdog supervisor for Orca-Pod workers.
// Replaces blind fixed-timeout killing with continuous liveness & progress monitoring:
//   - Prioritizes structured human approval waits (`user_approval`) over transient errors
//   - Restricts output dead-loop detection strictly to lines appended AFTER last real progress
//   - Stream-hashes full content of modified & untracked files (marking truncated probes unknown)
//   - Separates own vs shared-worktree signals cleanly across shared<->solo transitions
// Zero external dependencies (Node >= 18).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from "node:fs";
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
const MAX_HASHED_GIT_FILES = 2000;
const MAX_STREAM_FILE_BYTES = 16 * 1024 * 1024; // 16 MB streaming content hash cap per file

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

export function extractPreviewDelta(prevPreview, curPreview, maxTailLines = 16) {
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
  const lastPrev = prevLines[prevLines.length - 1];
  const lastIdx = curLines.lastIndexOf(lastPrev);
  if (lastIdx >= 0) {
    return curLines.slice(lastIdx + 1).slice(-maxTailLines).join("\n");
  }
  return curLines.slice(-maxTailLines).join("\n");
}

export function detectPromptBlocked(preview, agentWait = null) {
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

  // 1) Intra-delta / post-progress consecutive line repetition
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

  // 2) Cross-slice repetition across changed snapshots since last real progress
  if (!Array.isArray(history) || history.length < th) return null;
  const recent = history.slice(-th);
  const nonEmpty = recent.filter((x) => x && x.length >= 16);
  if (nonEmpty.length < th) return null;

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

function hashSymlinkTarget(filePath) {
  const target = readlinkSync(filePath);
  const h = createHash("sha256");
  h.update(`symlink:${target.length}:${target}`);
  return { exists: true, partial: false, size: target.length, digest: h.digest("hex").slice(0, 24) };
}

/**
 * Stream-hash file content in 64KB chunks so large files (>512KB) are content-hashed
 * without heap spikes; marks `partial: true` if file exceeds `maxBytes` or cannot be read.
 * Uses `lstatSync` first (never following symlinks); when `allowSymlinkTarget === true`
 * (Git working tree entries), hashes the symlink target string via `readlinkSync` without
 * opening or following the target.
 */
function hashFileStreaming(filePath, maxBytes = MAX_STREAM_FILE_BYTES, { allowSymlinkTarget = false } = {}) {
  let fd = null;
  try {
    const lst = lstatSync(filePath);
    if (lst.isSymbolicLink()) {
      if (!allowSymlinkTarget) {
        return { exists: false, partial: false, size: 0, digest: null };
      }
      return hashSymlinkTarget(filePath);
    }
    if (!lst.isFile()) return { exists: false, partial: false, size: 0, digest: null };
    if (lst.size > maxBytes) {
      return { exists: true, partial: true, size: lst.size, digest: null };
    }
    const h = createHash("sha256");
    fd = openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0)
    );
    const fst = fstatSync(fd);
    if (!fst.isFile()) return { exists: false, partial: false, size: 0, digest: null };
    if (fst.size > maxBytes) {
      return { exists: true, partial: true, size: fst.size, digest: null };
    }
    h.update(`${fst.size}:`);
    const buf = Buffer.allocUnsafe(65536);
    let offset = 0;
    while (offset < fst.size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, fst.size - offset), offset);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      offset += n;
    }
    return { exists: true, partial: false, size: fst.size, digest: h.digest("hex").slice(0, 24) };
  } catch (e) {
    if (e && e.code === "ENOENT") return { exists: false, partial: false, size: 0, digest: null };
    if (e && (e.code === "ELOOP" || e.code === "EMLINK" || e.code === "EFTYPE")) {
      if (allowSymlinkTarget) {
        try {
          return hashSymlinkTarget(filePath);
        } catch {
          return { exists: false, partial: false, size: 0, digest: null };
        }
      }
      return { exists: false, partial: false, size: 0, digest: null };
    }
    return { exists: false, partial: true, size: 0, digest: null };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch {} }
  }
}

export function probeWorktreeActivity(worktreeDir, {
  artifactPath = null,
  progressPath = null,
  artDirPath = null,
  sharedWorktree = false,
  maxGitFiles = MAX_HASHED_GIT_FILES,
} = {}) {
  let gitFingerprint = null;
  let gitOk = false;
  let gitPartial = false;

  if (worktreeDir && existsSync(worktreeDir)) {
    const st = spawnSync("git", ["--no-optional-locks", "-C", worktreeDir, "status", "--porcelain", "-uall", "-z"], {
      encoding: "utf8",
      timeout: 3000,
    });
    const head = spawnSync("git", ["--no-optional-locks", "-C", worktreeDir, "rev-parse", "--verify", "--quiet", "HEAD"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (!st.error && st.status === 0) {
      const headSha = (!head.error && head.status === 0) ? (head.stdout || "").trim() : "NO_HEAD";
      const entries = (st.stdout || "").split("\0").filter(Boolean);
      const fileDigests = [];
      let inspected = 0;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.length < 4) continue;
        const xy = entry.slice(0, 2);
        const relPath = entry.slice(3);
        if (xy.includes("R") || xy.includes("C")) i++;
        if (relPath.startsWith(".orca/artifacts/") || relPath === ".orca-agent-config.json") continue;
        if (inspected >= maxGitFiles) {
          gitPartial = true;
          break;
        }
        inspected++;
        const info = hashFileStreaming(join(worktreeDir, relPath), MAX_STREAM_FILE_BYTES, { allowSymlinkTarget: true });
        if (info.partial) {
          gitPartial = true;
          break;
        }
        fileDigests.push(info.exists ? `${xy}:${relPath}:${info.digest}` : `${xy}:${relPath}:gone`);
      }
      // If file count exceeded maxGitFiles or a file exceeded streaming content hash limits,
      // explicitly mark gitFingerprint as null (unknown/partial) rather than claiming false certainty!
      if (!gitPartial) {
        gitOk = true;
        fileDigests.sort();
        const gh = createHash("sha256");
        gh.update(`${headSha}\n${fileDigests.join("\n")}`);
        gitFingerprint = gh.digest("hex").slice(0, 32);
      }
    }
  }

  let artifactSize = 0;
  const ownParts = [];
  if (artifactPath) {
    const info = hashFileStreaming(artifactPath);
    if (info.exists && info.digest) {
      artifactSize = info.size;
      ownParts.push(`writes:${info.size}:${info.digest}`);
    }
  }
  if (progressPath) {
    const pInfo = hashFileStreaming(progressPath);
    if (pInfo.exists && pInfo.digest) {
      ownParts.push(`progress:${pInfo.size}:${pInfo.digest}`);
    }
  }
  const ownArtifactFingerprint = ownParts.join("|");

  // Always compute directory-wide extra artifact fingerprint separately from `ownArtifactFingerprint`
  // so transitions between sharedWorktree=true and sharedWorktree=false never treat pre-existing
  // untouched sibling files as newly written progress!
  const artEntries = [];
  if (artDirPath && existsSync(artDirPath)) {
    try {
      for (const name of readdirSync(artDirPath)) {
        if (
          name === "status.js" || name === "status.html" || name === "status.json" ||
          name === "ISSUES.json" || name === "ISSUES.md" || name === "WORKTREES.json" ||
          name.endsWith(".md.js") || name.endsWith(".json.js") || name.endsWith(".tmp") ||
          name.includes(".tmp.")
        ) continue;
        const full = join(artDirPath, name);
        if (artifactPath && full === artifactPath) continue;
        if (progressPath && full === progressPath) continue;
        const info = hashFileStreaming(full, 2 * 1024 * 1024);
        if (info.exists && info.digest) artEntries.push(`${name}:${info.size}:${info.digest}`);
      }
    } catch {}
  }
  artEntries.sort();
  const dirArtifactFingerprint = artEntries.join(",");
  const artifactFingerprint = sharedWorktree
    ? ownArtifactFingerprint
    : `${ownArtifactFingerprint}||${dirArtifactFingerprint}`;

  return {
    gitFingerprint,
    gitOk,
    gitPartial,
    ownArtifactFingerprint,
    dirArtifactFingerprint,
    artifactFingerprint,
    artifactSize,
  };
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
    lastSharedWorktree: Boolean(sharedWorktree),
    probeFn,
    lastGitFingerprint: initial.gitFingerprint ?? null,
    lastOwnArtifactFingerprint: initial.ownArtifactFingerprint ?? initial.artifactFingerprint ?? "",
    lastDirArtifactFingerprint: initial.dirArtifactFingerprint ?? "",
    lastArtifactFingerprint: initial.artifactFingerprint ?? "",
    lastArtifactSize: initial.artifactSize ?? 0,
    lastRawPreview: "",
    postProgressLines: [],
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
  const switchedToSolo = w.lastSharedWorktree === true && sharedWorktree === false;
  w.lastSharedWorktree = sharedWorktree;

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

  // Compute git change: when transitioning from shared->solo worktree, re-baseline git & sibling dir
  // fingerprints without treating pre-existing sibling edits as new progress!
  let gitChanged = false;
  if (probe.gitFingerprint != null) {
    if (w.lastGitFingerprint == null || switchedToSolo || sharedWorktree) {
      w.lastGitFingerprint = probe.gitFingerprint;
    } else if (probe.gitFingerprint !== w.lastGitFingerprint) {
      w.lastGitFingerprint = probe.gitFingerprint;
      gitChanged = true;
    }
  }

  let artifactChanged = false;
  if (probe.ownArtifactFingerprint !== undefined && probe.dirArtifactFingerprint !== undefined) {
    const ownChanged = probe.ownArtifactFingerprint !== w.lastOwnArtifactFingerprint;
    w.lastOwnArtifactFingerprint = probe.ownArtifactFingerprint;
    let dirChanged = false;
    if (switchedToSolo || sharedWorktree) {
      w.lastDirArtifactFingerprint = probe.dirArtifactFingerprint;
    } else if (probe.dirArtifactFingerprint !== w.lastDirArtifactFingerprint) {
      w.lastDirArtifactFingerprint = probe.dirArtifactFingerprint;
      dirChanged = true;
    }
    artifactChanged = ownChanged || dirChanged;
    w.lastArtifactFingerprint = probe.artifactFingerprint;
    w.lastArtifactSize = probe.artifactSize;
  } else if (probe.artifactFingerprint != null && probe.artifactFingerprint !== w.lastArtifactFingerprint) {
    // Support lightweight unit-test probeOverride objects `{ gitFingerprint, artifactFingerprint, artifactSize }`
    w.lastArtifactFingerprint = probe.artifactFingerprint;
    w.lastArtifactSize = probe.artifactSize ?? w.lastArtifactSize;
    artifactChanged = !switchedToSolo;
  }

  if (gitChanged || artifactChanged) {
    w.lastRealCodeProgressAt = now;
  }

  const realProgressNow = gitChanged || artifactChanged;
  if (realProgressNow) {
    // Real code/artifact progress clears anomaly dedup latches AND wipes pre-progress loop buffers!
    w.emittedAnomalyKeys.clear();
    w.postProgressLines = [];
    w.previewHistory = [];
  }

  const preview = typeof obs.preview === "string" ? obs.preview : null;
  const freshDelta = preview != null ? extractPreviewDelta(w.lastRawPreview, preview, 16) : "";
  if (preview != null) {
    w.lastRawPreview = preview;
  }
  const deltaNorm = normalizePreviewTail(freshDelta, 16);

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

  // 1) Structured Human Approval (`user_approval`) check FIRST:
  //    Never preempt an active human-approval wait with fallback on transient terminal error text!
  const pb = detectPromptBlocked(preview, obs.agentWait);
  if (pb && pb.humanApproval) {
    return emitAnomaly({
      kind: pb.kind,
      dedupSig: pb.sig,
      action: "block",
      diagnosis: pb.diagnosis,
      evidence: { sig: pb.sig, label: pb.label, trustBlock: false, humanApproval: true },
      parked: { sig: pb.sig, label: pb.label },
    });
  }

  // 2) Gateway disconnect check: ONLY scan newly appended preview delta when no real git/artifact progress occurred
  if (!realProgressNow && freshDelta) {
    const gw = detectGatewayDisconnect(freshDelta);
    if (gw) {
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

  // 3) Unattended workspace-trust / startup prompt block (`trustBlock === true`)
  if (pb) {
    const canFallback = Boolean(pb.trustBlock && cfg.fallbackOnPromptBlocked && fallbackAvailable);
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

  // 4) Output dead-loop detection: strictly restricted to lines appended AFTER last real progress!
  const previewDidAdvance = obs.previewChanged !== false;
  if (!realProgressNow && previewDidAdvance && deltaNorm.lines.length > 0) {
    w.postProgressLines.push(...deltaNorm.lines);
    if (w.postProgressLines.length > 36) {
      w.postProgressLines = w.postProgressLines.slice(-36);
    }
    if (obs.previewSeenBefore && deltaNorm.tail) {
      w.previewHistory.push(deltaNorm.tail);
      if (w.previewHistory.length > (cfg.loopWindowSize || 10)) {
        w.previewHistory.shift();
      }
    }
    const loop = detectOutputLoop(w.previewHistory, w.postProgressLines, { threshold: cfg.loopThreshold });
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
  }

  // 5) Update effective progress clock
  const nonLoopPreviewProgress = Boolean(obs.previewChanged && obs.previewSeenBefore);
  const activeProgress = gitChanged || artifactChanged || nonLoopPreviewProgress;
  if (activeProgress) {
    w.lastProgressAt = now;
  }

  // 6) Stalled/hang detection
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

  // 7) Activity-aware deadline extension
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
