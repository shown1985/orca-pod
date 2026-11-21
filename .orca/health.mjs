#!/usr/bin/env node
// Worker Start Proof (`turnStart: observed`) + 5-State Health State Machine for orca-pod (v0.3.0).
// Worst-of precedence: lost > blocked > unknown > degraded > healthy.
// Zero external dependencies: Node builtins only.

export const HEALTH_PRECEDENCE = {
  healthy: 0,
  degraded: 1,
  unknown: 2,
  blocked: 3,
  lost: 4,
};

// Only settled/terminal worker completion counts from dispatch.status (never creation-time "running"/"ready").
const SETTLED_DISPATCH_RE = /^(completed|settled|done)$/i;
const LOST_DISPATCH_RE = /^(lost|dead|crashed|exited|terminated|aborted|cancelled|canceled)$/i;

export function worstHealth(states) {
  let worst = "healthy";
  for (const st of states) {
    if ((HEALTH_PRECEDENCE[st] ?? 0) > (HEALTH_PRECEDENCE[worst] ?? 0)) {
      worst = st;
    }
  }
  return worst;
}

/**
 * Create initial per-member health tracker AFTER worker-start returns.
 * Note: `worker-start` returning `state: "ready"` or `status: "running"` is NOT proof
 * of a started turn. Only an explicit receipt `turnStart: "observed"` counts at dispatch time.
 */
export function initMemberHealth({
  startedAt = Date.now(),
  dispatchedAt = Date.now(),
  receiptTurnStart = null,
  turnStartWindowMs = 120000,
  turnStartEscalateMs = 600000,
  noProgressThreshold = 3,
} = {}) {
  const initialObserved = receiptTurnStart === "observed";
  return {
    turnStart: initialObserved ? "observed" : "unobserved",
    turnStartEvidence: initialObserved ? "receipt:turnStart=observed" : null,
    turnStartObservedAt: initialObserved ? dispatchedAt : null,
    dispatchedAt,
    initialHeartbeatMs: 0,
    turnStartWindowMs,
    turnStartEscalateMs,
    noProgressThreshold,
    turnStartWarned: false,
    nonProgressSlices: 0,
    lastEffectiveProgressAt: initialObserved ? dispatchedAt : 0,
    lastArtifactSize: 0,
    state: "healthy",
    signals: [],
    lastEvaluatedAt: startedAt,
  };
}

/**
 * Update start proof & evaluate the 5-state health machine on each poll slice.
 */
export function evaluateMemberHealth(h, obs) {
  const now = obs.now ?? Date.now();
  const prevState = h.state;
  const elapsedMs = Math.max(0, now - (obs.startedAt ?? h.dispatchedAt ?? now));
  let turnStartJustObserved = false;
  let effectiveProgress = false;

  const markTurnStart = (evidence) => {
    if (h.turnStart !== "observed") {
      h.turnStart = "observed";
      h.turnStartEvidence = evidence;
      h.turnStartObservedAt = now;
      turnStartJustObserved = true;
    }
  };

  // 1) Positive worker-emitted evidence of turnStart (state: ready / creation status NEVER count)
  if (obs.receiptTurnStart === "observed") {
    markTurnStart("receipt:turnStart=observed");
  }
  if (obs.workerDone) {
    markTurnStart("event:worker_done");
    effectiveProgress = true;
  }
  if (obs.previewChanged && obs.previewSeenBefore) {
    // Only a redraw AFTER the initial screen proves active TUI execution
    markTurnStart("terminal:preview_changed");
    effectiveProgress = true;
  }
  if (obs.parkedLabel) {
    // A rendered permission/trust dialog proves the CLI process actually booted
    markTurnStart(`terminal:parked(${obs.parkedLabel})`);
  }
  if (obs.artifactSize > 0 && obs.artifactSize !== h.lastArtifactSize) {
    h.lastArtifactSize = obs.artifactSize;
    markTurnStart(`artifact:bytes=${obs.artifactSize}`);
    effectiveProgress = true;
  }
  if (obs.gitChanged) {
    markTurnStart("git:worktree_changed");
    effectiveProgress = true;
  }
  if (obs.dispatchStatus && SETTLED_DISPATCH_RE.test(String(obs.dispatchStatus))) {
    markTurnStart(`dispatch:settled=${obs.dispatchStatus}`);
  }
  // M4 FIX: A dispatch-creation timestamp cannot satisfy turnStart. Require a heartbeat
  // strictly AFTER post-dispatch completion AND strictly advancing past any first-seen stamp.
  if (obs.heartbeatMs && obs.heartbeatMs > h.dispatchedAt) {
    if (h.initialHeartbeatMs === 0) {
      h.initialHeartbeatMs = obs.heartbeatMs;
    } else if (obs.heartbeatMs > h.initialHeartbeatMs) {
      markTurnStart(`dispatch:heartbeat_advanced=${obs.heartbeatMs}`);
    }
  }

  // Track effective progress (heartbeats alone do NOT count as effective progress)
  if (effectiveProgress) {
    h.nonProgressSlices = 0;
    h.lastEffectiveProgressAt = now;
  } else if (h.turnStart === "observed") {
    h.nonProgressSlices += 1;
  }

  // 2) Collect signals
  const signals = [];

  // Signal: lost (terminated without worker_done)
  if (obs.dispatchStatus && LOST_DISPATCH_RE.test(String(obs.dispatchStatus)) && !obs.workerDone) {
    signals.push({
      name: "dispatch_lost",
      state: "lost",
      detail: `dispatch status=${obs.dispatchStatus} without worker_done`,
    });
  }

  // Signal: blocked (parked dialog OR non-empty Orca agentWait object)
  if (obs.parkedLabel) {
    signals.push({
      name: "parked_prompt",
      state: "blocked",
      detail: `parked on ${obs.parkedLabel}`,
    });
  }
  if (obs.agentWait && typeof obs.agentWait === "object" && !Array.isArray(obs.agentWait) && Object.keys(obs.agentWait).length > 0) {
    signals.push({
      name: "agent_wait",
      state: "blocked",
      detail: `worker waiting on ${obs.agentWait.kind || obs.agentWait.reason || "external approval"}`,
    });
  }

  // Signal: turnStart unobserved past window
  let turnStartWarnDue = false;
  let turnStartEscalateDue = false;
  if (h.turnStart !== "observed") {
    if (elapsedMs >= h.turnStartEscalateMs) {
      signals.push({
        name: "turn_start",
        state: "unknown",
        detail: `turnStart still unobserved after ${Math.round(elapsedMs / 1000)}s (escalate threshold ${Math.round(h.turnStartEscalateMs / 1000)}s)`,
      });
      turnStartEscalateDue = true;
    } else if (elapsedMs >= h.turnStartWindowMs) {
      signals.push({
        name: "turn_start",
        state: "unknown",
        detail: `turnStart unobserved after ${Math.round(elapsedMs / 1000)}s (state=ready is not start proof)`,
      });
      if (!h.turnStartWarned) {
        h.turnStartWarned = true;
        turnStartWarnDue = true;
      }
    }
  }

  // Signal: silence / no effective progress (degraded)
  if (obs.silenceMs != null && obs.maxIdleMs != null && obs.silenceMs >= obs.maxIdleMs) {
    signals.push({
      name: "silence",
      state: "degraded",
      detail: `quiet for ${Math.round(obs.silenceMs / 1000)}s`,
    });
  } else if (h.turnStart === "observed" && h.nonProgressSlices >= h.noProgressThreshold && obs.silenceMs >= Math.min(60000, obs.maxIdleMs || 60000)) {
    signals.push({
      name: "no_effective_progress",
      state: "degraded",
      detail: `${h.nonProgressSlices} consecutive slices without effective progress`,
    });
  }

  const nextState = worstHealth(signals.map((s) => s.state));
  h.state = nextState;
  h.signals = signals;
  h.lastEvaluatedAt = now;

  let note = null;
  if (nextState !== "healthy" && signals.length) {
    const primary = signals.slice().sort((a, b) => (HEALTH_PRECEDENCE[b.state] ?? 0) - (HEALTH_PRECEDENCE[a.state] ?? 0))[0];
    note = `[health:${nextState}] ${primary.detail}`;
  }

  return {
    state: nextState,
    previousState: prevState,
    changed: nextState !== prevState,
    turnStart: h.turnStart,
    turnStartJustObserved,
    turnStartWarnDue,
    turnStartEscalateDue,
    signals,
    note,
  };
}
