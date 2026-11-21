// Simulates a CLI that returned state:"ready" from worker-start but NEVER started a turn:
// no worker_done, no heartbeat, frozen welcome screen preview.
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      c.ok({ dispatchId: id, state: "ready" });
    },
    "orchestration dispatch-show": (c) => {
      const d = Object.values(c.state.dispatches).filter((x) => x.task === c.flags.task).pop();
      c.ok({ dispatch: { id: d ? d.id : null, status: "dispatching", last_heartbeat_at: null } });
    },
    "orchestration worker-show": (c) => {
      c.ok({ terminal: { lastOutputAt: 0, preview: "Welcome to CLI (idle)" } });
    },
    "orchestration check": (c) => {
      if (c.flags.ack !== undefined) return c.ok({});
      setTimeout(() => c.ok({ messages: [] }), 140);
    },
  },
};
