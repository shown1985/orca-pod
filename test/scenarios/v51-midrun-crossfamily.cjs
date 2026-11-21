// P0-03 + P1-04 + sxcj #2:
// Step 1 (`coding`): starts on `opencode2` (`deepseek`), hits ECONNREFUSED mid-run,
// stops `opencode2` cleanly, downgrades to `agy` with `claude-sonnet-5-5` (`anthropic`),
// verifies `.agents/skills` was materialized in the worktree for `agy`, and succeeds!
// Step 2 (`code-review`): primary `codex` (`openai`) fails `worker-start`, and its configured
// fallback is `claude` with `claude-opus-5-5` (`anthropic`). Because `coding` ACTUALLY
// executed on `anthropic` (`claude-sonnet-5-5`), `code-review` MUST reject `claude-opus-5-5`
// and keep the review gate BLOCKED rather than allowing Anthropic to review Anthropic!
const fs = require("node:fs");
const path = require("node:path");

module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      const agent = c.flags.agent || "unknown";
      const model = c.flags.model || null;
      const wt = process.env.ORCA_FAKE_WT || ".";
      c.state.dispatches[id] = { id, task: c.flags.task, agent, model, status: "running", created: Date.now() };
      (c.state.extra.starts ||= []).push({ id, agent, model, task: c.flags.task });

      if (agent === "antigravity" || agent === "agy") {
        // Check that fallback rematerialization mounted .agents/skills/fe-check/SKILL.md for agy!
        const agySkillFile = path.join(wt, ".agents", "skills", "fe-check", "SKILL.md");
        c.state.extra.agySkillMountedDuringFallback = fs.existsSync(agySkillFile);
        const task = c.state.tasks[c.flags.task] || {};
        c.materialize(task, "succeeded");
        c.pushDone(c.flags.task, "succeeded", id);
        return c.ok({ dispatchId: id, state: "ready", turnStart: "observed" });
      }

      if (agent === "codex") {
        c.state.dispatches[id].status = "failed";
        return c.fail("connect ECONNREFUSED: codex gateway offline", 1);
      }

      c.ok({ dispatchId: id, state: "ready", turnStart: "observed" });
    },
    "orchestration worker-show": (c) => {
      const d = c.state.dispatches[c.flags.dispatch] || {};
      if (d.agent === "opencode2") {
        return c.ok({
          terminal: {
            lastOutputAt: Date.now(),
            preview: "opencode2 -> Error: connect ECONNREFUSED 127.0.0.1:3425",
          },
        });
      }
      c.ok({ terminal: { lastOutputAt: Date.now(), preview: "running..." } });
    },
    "orchestration check": (c) => {
      if (c.flags.ack !== undefined) return c.ok({});
      const done = c.state.pendingDone.shift();
      if (!done) {
        const sab = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(sab), 0, 0, 150);
        return c.ok({ messages: [] });
      }
      c.ok({
        deliveryId: "dlv-" + c.id(),
        messages: [{
          type: "worker_done",
          taskId: done.task,
          dispatchId: done.dispatchId,
          payload: JSON.stringify({ outcome: done.outcome, dispatchId: done.dispatchId }),
        }],
      });
    },
  },
};
