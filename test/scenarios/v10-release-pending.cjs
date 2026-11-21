// P0-01: Primary worker-start returns state:"failed" with a dispatchId, and
// worker-release exits 0 with status:"release_pending" (active terminal still retained).
// Orca-Pod MUST treat this as ambiguous and REFUSE to launch the fallback candidate
// on the same worktree!
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      c.state.extra.starts = (c.state.extra.starts || []);
      c.state.extra.starts.push({ agent: c.flags.agent, model: c.flags.model || null });
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "failed", created: Date.now() };
      c.ok({ dispatchId: id, state: "failed", error: "bootstrap failed while terminal remained open" });
    },
    "orchestration worker-stop": (c) => {
      c.ok({ dispatchId: c.flags.dispatch, state: "stopped", processAction: "closed_agent_terminal" });
    },
    "orchestration worker-release": (c) => {
      c.ok({ dispatchId: c.flags.dispatch, status: "release_pending" });
    },
  },
};
