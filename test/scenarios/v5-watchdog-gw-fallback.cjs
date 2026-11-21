// V1c: Primary opencode2 boots then hits ECONNREFUSED 127.0.0.1:3425 in terminal preview.
// Watchdog detects gateway_disconnect, releases primary, and auto-downgrades to fallback agy which succeeds!
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      const agent = c.flags.agent || "unknown";
      c.state.dispatches[id] = { id, task: c.flags.task, agent, model: c.flags.model || null, effort: c.flags.effort || null, status: "running", created: Date.now() };
      (c.state.extra.starts ||= []).push({ id, agent, model: c.flags.model || null, effort: c.flags.effort || null });
      if (agent === "agy") {
        const task = c.state.tasks[c.flags.task] || {};
        c.materialize(task, "succeeded");
        c.pushDone(c.flags.task, "succeeded");
      }
      c.ok({ dispatchId: id, state: "ready", turnStart: "observed" });
    },
    "orchestration worker-show": (c) => {
      const d = c.state.dispatches[c.flags.dispatch] || {};
      if (d.agent === "opencode2") {
        return c.ok({
          terminal: {
            lastOutputAt: Date.now(),
            preview: "opencode2 -> provider magpie\nError: connect ECONNREFUSED 127.0.0.1:3425\nTypeError: fetch failed",
          },
        });
      }
      c.ok({ terminal: { lastOutputAt: Date.now(), preview: "agy working cleanly..." } });
    },
    "orchestration check": (c) => {
      if (c.flags.ack !== undefined) return c.ok({});
      const done = c.state.pendingDone.shift();
      if (!done) {
        const sab = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(sab), 0, 0, 200);
        return c.ok({ messages: [] });
      }
      c.ok({
        deliveryId: "dlv-" + c.id(),
        messages: [{ type: "worker_done", taskId: done.task, payload: JSON.stringify({ outcome: done.outcome }) }],
      });
    },
  },
};
