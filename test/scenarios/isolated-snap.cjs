const fs = require("node:fs");
const { join } = require("node:path");

module.exports = {
  init(state) { state.extra.snaps = {}; },
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      const wtDir = (c.state.extra.worktreePaths || {})[c.flags.worktree] || process.env.ORCA_FAKE_WT || ".";
      c.state.dispatches[id] = { id, task: c.flags.task, worktree: c.flags.worktree || null, wtDir, status: "dispatching", created: Date.now() };
      const task = c.state.tasks[c.flags.task] || {};
      const title = (task.spec.match(/^# (.+)$/m) || [])[1] || "unknown";
      const agentsMd = join(wtDir, "AGENTS.md");
      const syncedReview = join(wtDir, ".orca", "artifacts", "CONTRACT_REVIEW.md");
      c.state.extra.snaps[title] = {
        worktreeFlag: c.flags.worktree || null,
        wtDir,
        hasAgentsMd: fs.existsSync(agentsMd),
        agentsText: fs.existsSync(agentsMd) ? fs.readFileSync(agentsMd, "utf8") : "",
        hasSyncedContractReview: fs.existsSync(syncedReview),
      };
      c.materialize(task, "succeeded", wtDir);
      c.pushDone(c.flags.task, "succeeded");
      return c.ok({ dispatchId: id, state: "ready" });
    },
  },
};
