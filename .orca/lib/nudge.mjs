// Optional nudge state machine for missing artifacts (ships disabled by default: nudgeRetries = 0).

export function createNudgeController({
  orca, pick, res, sleepMs, parkedPromptOf,
  nudgeRetriesOf, nudgeTimeoutOf, outPath, artifactReady,
  statusSet, writeStatus, warn, settleMember,
  syncOutputsFromIsolatedWorktree, getWtDir, artDir,
}) {
  function terminalOf(m) {
    if (m.terminal) return m.terminal;
    if (!m.dispatchId) return null;
    const t = pick(res(orca(["orchestration", "worker-show", "--dispatch", m.dispatchId]).json), ["terminal"]) || {};
    const id = pick(t, ["id", "terminalId", "terminal_id"]);
    if (id) m.terminal = id;
    return id || null;
  }

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

  function send(m, text) {
    const capAt = deadlineCapOf(m);
    const remBefore = remainingBudgetMs(m);
    if (remBefore <= 0) return false;
    const rpcTimeout = Number.isFinite(remBefore) ? Math.max(1, Math.floor(remBefore)) : undefined;
    const s = orca(["terminal", "send", "--terminal", m.terminal, "--text", text, "--enter"], { timeoutMs: rpcTimeout, deadlineAt: capAt });
    if (!s.ok) { warn(`nudge send '${m.step.title}' failed: ${s.stderr || s.raw}`); return false; }
    const remSleep = remainingBudgetMs(m);
    if (remSleep > 0) {
      sleepMs(Math.min(3000, remSleep));
    }
    const remAfter = remainingBudgetMs(m);
    if (remAfter > 0) {
      orca(["terminal", "send", "--terminal", m.terminal, "--text", "", "--enter"], {
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
    if (m.nudge.left <= 0) {
      if (m.nudge.count > 0) { m.note = `artifact missing after ${m.nudge.count} nudge(s)`; m.outcome = "failed"; }
      else m.note = "artifact missing (nudge undeliverable)";
      return false;
    }
    if (!terminalOf(m)) { m.note = "artifact missing (no terminal to nudge)"; return false; }
    const tinfo = pick(res(orca(["terminal", "show", "--terminal", m.terminal]).json), ["terminal"]) || {};
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
        const tinfo = pick(res(orca(["terminal", "show", "--terminal", m.terminal]).json), ["terminal"]) || {};
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
