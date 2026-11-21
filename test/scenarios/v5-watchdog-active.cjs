// V1a: Worker keeps making real preview + file progress past the initial hardTimeoutMs
// (e.g. 2500ms) and finishes cleanly on poll #5. Watchdog MUST extend the deadline
// instead of killing an actively coding worker.
const fs = require("node:fs");
const path = require("node:path");

module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "running", created: Date.now(), polls: 0 };
      c.ok({ dispatchId: id, state: "ready", turnStart: "observed" });
    },
    "orchestration check": (c) => {
      if (c.flags.ack !== undefined) return c.ok({});
      c.state.extra.checks = (c.state.extra.checks || 0) + 1;
      const n = c.state.extra.checks;
      // Sleep slightly so wall-clock crosses initial hardTimeoutMs (2500ms) by poll #4
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, 800);
      const disp = Object.values(c.state.dispatches)[0];
      if (disp && n >= 5) {
        const task = c.state.tasks[disp.task] || {};
        c.materialize(task, "succeeded");
        return c.ok({
          deliveryId: "dlv-" + c.id(),
          messages: [{ type: "worker_done", taskId: disp.task, payload: JSON.stringify({ outcome: "succeeded" }) }],
        });
      }
      return c.ok({ messages: [] });
    },
    "orchestration worker-show": (c) => {
      c.state.extra.shows = (c.state.extra.shows || 0) + 1;
      const n = c.state.extra.shows;
      const wt = process.env.ORCA_FAKE_WT || ".";
      try {
        fs.writeFileSync(path.join(wt, ".orca", "artifacts", "progress-tick.txt"), `tick ${n} at ${Date.now()}\n`);
      } catch {}
      c.ok({
        terminal: {
          lastOutputAt: Date.now(),
          preview: `Implementing module step #${n}: edited src/service_${n}.py and running pytest (${n}/5 passed)...`,
        },
      });
    },
  },
};
