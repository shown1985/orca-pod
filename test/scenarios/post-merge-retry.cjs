const fs = require("node:fs");
const { join } = require("node:path");

module.exports = {
  init(state) { state.extra.intRuns = 0; state.extra.beRuns = 0; },
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      const wtDir = (c.state.extra.worktreePaths || {})[c.flags.worktree] || process.env.ORCA_FAKE_WT || ".";
      c.state.dispatches[id] = { id, task: c.flags.task, worktree: c.flags.worktree || null, wtDir, status: "dispatching", created: Date.now() };
      const task = c.state.tasks[c.flags.task] || {};
      const title = (task.spec.match(/^# (.+)$/m) || [])[1];
      if (title === "Contract Review") {
        // Test bold **Contract-Commit:** format too!
        const dir = join(wtDir, ".orca", "artifacts");
        fs.mkdirSync(dir, { recursive: true });
        const sha = process.env.ORCA_VERIFY_HEAD_SHA || "a".repeat(40);
        fs.writeFileSync(join(dir, "CONTRACT_REVIEW.md"),
          `# Contract Review\n\nDispatch-ID: ${id}\n**Contract-Commit:** \`${sha}\`\n\n` +
          "All contracts audited cleanly.\n".repeat(8) + "\nVERDICT: PASS\n"
        );
        c.pushDone(c.flags.task, "succeeded");
        return c.ok({ dispatchId: id, state: "ready" });
      }
      if (title === "Worker Backend") {
        c.state.extra.beRuns = (c.state.extra.beRuns || 0) + 1;
      }
      if (title === "Serial Integration") {
        c.state.extra.intRuns = (c.state.extra.intRuns || 0) + 1;
        const dir = join(wtDir, ".orca", "artifacts");
        fs.mkdirSync(dir, { recursive: true });
        const verdict = c.state.extra.intRuns === 1 ? "FAIL" : "PASS";
        fs.writeFileSync(join(dir, "INTEGRATION_REPORT.md"),
          `# Integration attempt ${c.state.extra.intRuns}\n\nDispatch-ID: ${id}\n\n` +
          "Integration logs.\n".repeat(12) + `\nVERDICT: ${verdict}\n`
        );
        c.pushDone(c.flags.task, c.state.extra.intRuns === 1 ? "failed" : "succeeded");
        return c.ok({ dispatchId: id, state: "ready" });
      }
      c.materialize(task, "succeeded", wtDir);
      c.pushDone(c.flags.task, "succeeded");
      return c.ok({ dispatchId: id, state: "ready" });
    },
  },
};
