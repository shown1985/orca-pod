// P0-01: Review step (with onFailGoto: "coding" and NO fallback) hits terminal
// ECONNREFUSED, and worker-stop returns stop_unknown. Runner MUST settle as
// "still-running" (halting cleanly) and MUST NOT settle as "failed" / trigger onFailGoto!
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      c.state.extra.starts = (c.state.extra.starts || []);
      const task = c.state.tasks[c.flags.task] || {};
      const title = (task.spec.match(/^# (.+)$/m) || [])[1] || "";
      c.state.extra.starts.push({ title, agent: c.flags.agent });
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, title, status: "running", created: Date.now() };
      if (title === "Coding") {
        c.materialize(task, "succeeded");
        c.pushDone(c.flags.task, "succeeded", id);
      }
      c.ok({ dispatchId: id, state: "ready", turnStart: "observed" });
    },
    "orchestration worker-show": (c) => {
      const d = c.state.dispatches[c.flags.dispatch] || {};
      if (d.title === "Cross-Family Code Review") {
        return c.ok({
          terminal: {
            lastOutputAt: Date.now(),
            preview: "Connecting to upstream...\nError: connect ECONNREFUSED 127.0.0.1:9999",
          },
        });
      }
      c.ok({ terminal: { lastOutputAt: Date.now(), preview: "ok" } });
    },
    "orchestration worker-stop": (c) => {
      c.ok({ dispatchId: c.flags.dispatch, state: "stop_unknown", processAction: "stop_unknown" });
    },
  },
};
