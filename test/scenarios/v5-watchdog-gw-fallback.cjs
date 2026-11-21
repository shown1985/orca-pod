// V1c: Primary opencode2 boots then hits ECONNREFUSED 127.0.0.1:3425 in terminal preview.
// Watchdog detects gateway_disconnect, explicitly runs worker-stop on the broken dispatch,
// updates task status, and downgrades to fallback `agy` (normalized to `antigravity` on worker-start)
// with `--retry-of`. Also injects a late/stale `worker_done` (outcome=failed) from the superseded
// primary dispatch BEFORE the replacement's `worker_done` (outcome=succeeded) to prove strict
// active-dispatchId isolation!
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      const agent = c.flags.agent || "unknown";
      c.state.dispatches[id] = {
        id,
        task: c.flags.task,
        agent,
        model: c.flags.model || null,
        effort: c.flags.effort || null,
        retryOf: c.flags["retry-of"] || null,
        status: "running",
        created: Date.now(),
      };
      (c.state.extra.starts ||= []).push({
        id,
        agent,
        model: c.flags.model || null,
        effort: c.flags.effort || null,
        retryOf: c.flags["retry-of"] || null,
      });
      if (agent === "antigravity" || agent === "agy") {
        const firstStart = c.state.extra.starts[0];
        // 1) Inject a late/stale worker_done from the OLD stopped primary dispatch (outcome=failed)!
        if (firstStart && firstStart.id !== id) {
          c.pushDone(c.flags.task, "failed", firstStart.id);
        }
        // 2) Queue the replacement worker's legitimate worker_done (outcome=succeeded)
        const task = c.state.tasks[c.flags.task] || {};
        c.materialize(task, "succeeded");
        c.pushDone(c.flags.task, "succeeded", id);
      }
      c.ok({ dispatchId: id, state: "ready", turnStart: "observed" });
    },
    "orchestration worker-show": (c) => {
      const d = c.state.dispatches[c.flags.dispatch] || {};
      if (d.agent === "opencode2") {
        return c.ok({
          terminal: {
            lastOutputAt: Date.now(),
            preview: "opencode2 -> provider magpie (Bearer sk-secret1234567890abcdef)\nError: connect ECONNREFUSED 127.0.0.1:3425\nTypeError: fetch failed",
          },
        });
      }
      c.ok({ terminal: { lastOutputAt: Date.now(), preview: "antigravity working cleanly..." } });
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
        messages: [{
          type: "worker_done",
          taskId: done.task,
          ...(done.dispatchId ? { dispatchId: done.dispatchId } : {}),
          payload: JSON.stringify({ outcome: done.outcome, dispatchId: done.dispatchId }),
        }],
      });
    },
  },
};
