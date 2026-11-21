// V3: 2-step flow (po-backlog -> pr-release-dev).
// po-backlog writes a realistic BACKLOG_DAG.md with 2 sub-tasks (T1, T2);
// fake-orca records the task spec of pr-release-dev so assertions verify Closes #N / Refs #N!
const fs = require("node:fs");
const path = require("node:path");

module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      const task = c.state.tasks[c.flags.task] || {};
      const wt = process.env.ORCA_FAKE_WT || ".";
      const artDir = path.join(wt, ".orca", "artifacts");
      fs.mkdirSync(artDir, { recursive: true });
      if ((task.spec || "").includes("# PO Backlog")) {
        fs.writeFileSync(
          path.join(artDir, "BACKLOG_DAG.md"),
          [
            "# BACKLOG DAG",
            "",
            "### T1: Implement MySQL connection pool and migration scripts",
            "Owner: backend",
            "",
            "### T2: Build Vue dashboard filters and CI verification panel",
            "Owner: frontend",
            "",
            "Additional planning details clearing minimum artifact byte thresholds for readiness verification.",
            "Additional planning details clearing minimum artifact byte thresholds for readiness verification.",
          ].join("\n")
        );
      } else {
        fs.writeFileSync(
          path.join(artDir, "EPIC_RELEASE_GATE.md"),
          "# Release Gate\n\nVERDICT: PASS\n\nPR created with linked issues and verified successfully across all checks and readiness thresholds.\n".repeat(3)
        );
      }
      c.pushDone(c.flags.task, "succeeded");
      c.ok({ dispatchId: id, state: "ready", turnStart: "observed" });
    },
  },
};
