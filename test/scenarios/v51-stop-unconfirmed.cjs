// P0-01: Primary worker hits ECONNREFUSED, Watchdog attempts `worker-stop`,
// which fails with `stop_unknown` (exit 1). Runner MUST refuse to blindly
// dispatch the fallback worker onto the same worktree and pause cleanly.
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      const agent = c.flags.agent || "unknown";
      c.state.dispatches[id] = { id, task: c.flags.task, agent, status: "running", created: Date.now() };
      (c.state.extra.starts ||= []).push({ id, agent });
      c.ok({ dispatchId: id, state: "ready", turnStart: "observed" });
    },
    "orchestration worker-show": (c) => {
      c.ok({
        terminal: {
          lastOutputAt: Date.now(),
          preview: "Error: connect ECONNREFUSED 127.0.0.1:3425",
        },
      });
    },
    "orchestration worker-stop": (c) => {
      (c.state.extra.stopAttempts ||= []).push(c.flags.dispatch);
      c.fail("stop_unknown: agent process exit could not be proven", 1);
    },
    "orchestration check": (c) => {
      if (c.flags.ack !== undefined) return c.ok({});
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, 150);
      return c.ok({ messages: [] });
    },
  },
};
