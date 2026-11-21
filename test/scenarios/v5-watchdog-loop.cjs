// V1b: Worker emits an output dead-loop (identical repeating error lines with zero file/git progress).
// Watchdog must detect output_loop and fail fast with clear diagnosis.
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "running", created: Date.now() };
      c.ok({ dispatchId: id, state: "ready", turnStart: "observed" });
    },
    "orchestration check": (c) => {
      if (c.flags.ack !== undefined) return c.ok({});
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, 200);
      return c.ok({ messages: [] });
    },
    "orchestration worker-show": (c) => {
      c.state.extra.shows = (c.state.extra.shows || 0) + 1;
      const n = c.state.extra.shows;
      const repeated = Array.from({ length: 6 }, () => "ERROR: tool call failed with invalid JSON arguments, retrying identical call...").join("\n");
      c.ok({
        terminal: {
          lastOutputAt: Date.now(),
          preview: `Attempt tick ${n}s\n${repeated}`,
        },
      });
    },
  },
};
