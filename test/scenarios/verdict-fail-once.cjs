const fs = require("node:fs");
const { join } = require("node:path");

module.exports = {
  init(state) { state.extra.reviewRuns = 0; },
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      const task = c.state.tasks[c.flags.task] || {};
      const title = (task.spec.match(/^# (.+)$/m) || [])[1];
      if (title === "Contract Review") {
        c.state.extra.reviewRuns = (c.state.extra.reviewRuns || 0) + 1;
        const dir = join(process.env.ORCA_FAKE_WT || ".", ".orca", "artifacts");
        fs.mkdirSync(dir, { recursive: true });
        const sha = process.env.ORCA_VERIFY_HEAD_SHA || "a".repeat(40);
        const verdict = c.state.extra.reviewRuns === 1 ? "FAIL" : "PASS";
        fs.writeFileSync(join(dir, "CONTRACT_REVIEW.md"),
          `# Contract Review (attempt ${c.state.extra.reviewRuns})\n\n` +
          `Dispatch-ID: ${id}\n` +
          `Contract-Commit: ${sha}\n\n` +
          "Detailed review findings clearing minimum byte threshold easily.\n".repeat(4) +
          `\nVERDICT: ${verdict}\n`
        );
        // Deliberately report outcome="succeeded" even on FAIL to prove flow.mjs
        // overrides outcome via gate-verify.mjs!
        c.pushDone(c.flags.task, "succeeded");
        return c.ok({ dispatchId: id, state: "ready" });
      }
      c.materialize(task, "succeeded");
      c.pushDone(c.flags.task, "succeeded");
      return c.ok({ dispatchId: id, state: "ready" });
    },
  },
};
