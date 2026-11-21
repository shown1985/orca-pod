// Optional nudge state machine for missing artifacts (ships disabled by default: nudgeRetries = 0).

export function createNudgeController({
  orca, pick, res, sleepMs, parkedPromptOf,
  nudgeRetriesOf, nudgeTimeoutOf, outPath, artifactReady,
  statusSet, writeStatus, warn, settleMember,
  syncOutputsFromIsolatedWorktree, getWtDir, artDir,
}) {
  function deadlineCapOf(m) {
    const capAt = Math.min(
      Number.isFinite(m.deadlineAt) ? m.deadlineAt : Infinity,
      Number.isFinite(m.maxDeadlineAt) ? m.maxDeadlineAt : Infinity,
    );
    return Number.isFinite(capAt) ? capAt : null;
  }

  function remainingBudgetMs(m) {
    const capAt = deadlineCapOf(m);
    return capAt != null ? (capAt - Date.now()) : Infinity;
  }

  // P0-01 & P1-02: Never mutate `m.terminal` (which belongs to `m.startMode === "manual"`),
  // check remaining deadline BEFORE issuing `worker-show`, AND verify `worker-show`'s
  // returned `dispatchId` matches `m.dispatchId` before caching or sending to any terminal!
  function terminalOf(m) {
    if (m.terminal) return m.terminal;
    if (m.nudgeTerminal && m.nudgeTerminalDispatchId === m.dispatchId) return m.nudgeTerminal;
    if (!m.dispatchId) return null;
    const rem = remainingBudgetMs(m);
    if (rem <= 0) return null;
    const ws = orca(["orchestration", "worker-show", "--dispatch", m.dispatchId], {
      timeoutMs: Number.isFinite(rem) ? Math.max(1, Math.floor(rem)) : undefined,
      deadlineAt: deadlineCapOf(m),
    });
    if (ws.deadlineExceeded || !ws.ok) return null;
    const wsJson = res(ws.json);
    const wsDispId = pick(wsJson, ["dispatchId", "dispatch_id"])
      || pick(wsJson.dispatch || {}, ["id", "dispatchId", "dispatch_id"])
      || pick(ws.json || {}, ["dispatchId", "dispatch_id"])
      || null;
    if (!wsDispId || wsDispId !== m.dispatchId) {
      warn(`[nudge] ignoring worker-show terminal for "${m.step.title}": returned dispatchId "${wsDispId || "missing"}" !== active "${m.dispatchId}"`);
      return null;
    }
    const t = pick(wsJson, ["terminal"]) || {};
    const id = pick(t, ["id", "terminalId", "terminal_id", "handle", "terminalHandle"]);
    if (id) {
      m.nudgeTerminal = id;
      m.nudgeTerminalDispatchId = m.dispatchId;
    }
    return id || null;
  }

  function send(m, text) {
    const term = terminalOf(m);
    if (!term) return false;
    const capAt = deadlineCapOf(m);
    const remBefore = remainingBudgetMs(m);
    if (remBefore <= 0) return false;
    const rpcTimeout = Number.isFinite(remBefore) ? Math.max(1, Math.floor(remBefore)) : undefined;
    const s = orca(["terminal", "send", "--terminal", term, "--text", text, "--enter"], { timeoutMs: rpcTimeout, deadlineAt: capAt });
    if (!s.ok) { warn(`nudge send '${m.step.title}' failed: ${s.stderr || s.raw}`); return false; }
    const remSleep = remainingBudgetMs(m);
    if (remSleep > 0) {
      sleepMs(Math.min(3000, remSleep));
    }
    const remAfter = remainingBudgetMs(m);
    if (remAfter > 0) {
      orca(["terminal", "send", "--terminal", term, "--text", "", "--enter"], {
        timeoutMs: Number.isFinite(remAfter) ? Math.max(1, Math.floor(remAfter)) : undefined,
        deadlineAt: capAt,
      });
    }
    m.nudge.left--; m.nudge.count++; m.nudge.sentAt = Date.now();
    m.lastBusy = Date.now();
    warn(`[nudge] ${m.nudge.count}/${nudgeRetriesOf(m.step)} sent to "${m.step.title}" (artifact \`${outPath(m.step.writes)}\` missing)`);
    statusSet(m.step.id, { note: `nudged (${m.nudge.count}/${nudgeRetriesOf(m.step)}) — asked the agent to write ${outPath(m.step.writes)}` });
    writeStatus();
    return true;
  }

  function maybeNudgeMidRun(m, v) {
    if (m.nudge.phase || m.nudge.left <= 0) return false;
    if (remainingBudgetMs(m) <= 0) return false;
    if (!m.step.writes || artifactReady(m.step.id)) return false;
    if (v.preview == null || parkedPromptOf(v.preview)) return false;
    if (Date.now() - m.lastBusy < nudgeTimeoutOf(m.step)) return false;
    if (v.heartbeatMs > 0 && Date.now() - v.heartbeatMs < nudgeTimeoutOf(m.step)) return false;
    if (!terminalOf(m)) return false;
    const ok = send(m, `[orca-flow] Your response appears truncated — write your complete output to ${outPath(m.step.writes)} now (Markdown). Automated nudge; do not ask questions.`);
    if (!ok) m.nudge.left = 0;
    return ok;
  }

  function holdForNudge(m, outcome, done) {
    if (!m.step.writes || artifactReady(m.step.id)) return false;
    if (nudgeRetriesOf(m.step) <= 0) { m.note = "artifact missing (nudge disabled)"; return false; }
    if (remainingBudgetMs(m) <= 0) {
      m.note = "artifact missing (deadline reached before nudge)";
      return false;
    }
    if (m.nudge.left <= 0) {
      if (m.nudge.count > 0) { m.note = `artifact missing after ${m.nudge.count} nudge(s)`; m.outcome = "failed"; }
      else m.note = "artifact missing (nudge undeliverable)";
      return false;
    }
    const term = terminalOf(m);
    if (!term) { m.note = "artifact missing (no terminal to nudge)"; return false; }
    const remShow = remainingBudgetMs(m);
    if (remShow <= 0) { m.note = "artifact missing (deadline reached before nudge)"; return false; }
    const ts = orca(["terminal", "show", "--terminal", term], {
      timeoutMs: Number.isFinite(remShow) ? Math.max(1, Math.floor(remShow)) : undefined,
      deadlineAt: deadlineCapOf(m),
    });
    if (ts.deadlineExceeded) { m.note = "artifact missing (deadline reached during nudge check)"; return false; }
    const tinfo = pick(res(ts.json), ["terminal"]) || {};
    const parked = parkedPromptOf(pick(tinfo, ["preview"]) ?? null);
    if (parked) { m.note = `artifact missing (terminal parked on ${parked.label})`; return false; }
    const ok = send(m, `[orca-flow] Your session completed but the output file was not written — write your complete output to ${outPath(m.step.writes)} now (Markdown). Automated nudge; do not ask questions.`);
    if (!ok) { m.note = "artifact missing (nudge send failed)"; return false; }
    m.nudge.phase = "post-done";
    m.nudge.outcome = outcome;
    m.nudge.done = done;
    return true;
  }

  function nudgePoll(m) {
    if (m.ctx?.isolated) syncOutputsFromIsolatedWorktree({ step: m.step, stepWtDir: m.ctx.dir, wtDir: getWtDir() || ".", artDirRel: artDir, minSourceMtimeMs: m.fsEpochMtimeMs ?? m.clearedAtMs, dispatchId: m.dispatchId || null });
    if (artifactReady(m.step.id)) {
      m.note = `artifact recovered via nudge (${m.nudge.count} sent)`;
      settleMember(m, m.nudge.outcome || "succeeded", m.nudge.done);
      return;
    }
    const hitDeadline = remainingBudgetMs(m) <= 0 || (!m.deadlineAt && Date.now() - m.startedAt >= m.hardCapMs);
    if (hitDeadline) {
      m.note = "artifact still missing after hard cap";
      settleMember(m, "failed", m.nudge.done);
      return;
    }
    if (Date.now() - m.nudge.sentAt >= nudgeTimeoutOf(m.step)) {
      if (m.nudge.left > 0) {
        const term = terminalOf(m);
        const remShow = remainingBudgetMs(m);
        if (!term || remShow <= 0) {
          m.note = "artifact still missing after hard cap";
          settleMember(m, "failed", m.nudge.done);
          return;
        }
        const ts = orca(["terminal", "show", "--terminal", term], {
          timeoutMs: Number.isFinite(remShow) ? Math.max(1, Math.floor(remShow)) : undefined,
          deadlineAt: deadlineCapOf(m),
        });
        if (ts.deadlineExceeded) {
          m.note = "artifact still missing after hard cap";
          settleMember(m, "failed", m.nudge.done);
          return;
        }
        const tinfo = pick(res(ts.json), ["terminal"]) || {};
        const parked = parkedPromptOf(pick(tinfo, ["preview"]) ?? null);
        if (parked) {
          m.note = `artifact missing (terminal parked on ${parked.label})`;
          settleMember(m, m.nudge.outcome || "succeeded", m.nudge.done);
          return;
        }
        if (!send(m, `[orca-flow] Still missing ${outPath(m.step.writes)} — write your complete output now. (automated nudge ${m.nudge.count + 1}/${nudgeRetriesOf(m.step)})`))
          m.nudge.left = 0;
      } else {
        m.note = `artifact missing after ${m.nudge.count} nudge(s)`;
        settleMember(m, "failed", m.nudge.done);
      }
    }
  }

  return { maybeNudgeMidRun, holdForNudge, nudgePoll };
}
