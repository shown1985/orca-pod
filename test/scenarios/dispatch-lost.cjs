// Simulates a worker whose dispatch terminates with status:"lost" without worker_done.
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "lost", created: Date.now() };
      c.ok({ dispatchId: id, state: "ready" });
    },
    "orchestration dispatch-show": (c) => {
      c.ok({ dispatch: { status: "lost", last_heartbeat_at: null } });
    },
    "orchestration worker-show": (c) => {
      c.ok({ terminal: { lastOutputAt: 0, preview: null } });
    },
    "orchestration check": (c) => {
      if (c.flags.ack !== undefined) return c.ok({});
      c.ok({ messages: [] });
    },
  },
};
