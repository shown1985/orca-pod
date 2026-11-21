const fs = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      const wtDir = process.env.ORCA_FAKE_WT || ".";
      c.state.dispatches[id] = { id, task: c.flags.task, worktree: c.flags.worktree || null, wtDir, status: "dispatching", created: Date.now() };
      const artDir = join(wtDir, ".orca", "artifacts");
      fs.mkdirSync(artDir, { recursive: true });
      const body = process.env.ORCA_FAKE_RELEASE_BODY || "# Release\nDoor: two-way\nMerge-Status: MERGED\n" + "ok ".repeat(100) + "\nVERDICT: PASS\n";
      fs.writeFileSync(join(artDir, "RELEASE.md"), body);
      if (process.env.ORCA_FAKE_FORCE_MERGE_DEV === "1") {
        // Simulate a rogue worker merging HEAD into dev despite one-way door
        const head = spawnSync("git", ["-C", wtDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
        spawnSync("git", ["-C", wtDir, "branch", "-f", "dev", head], { encoding: "utf8" });
      }
      if (process.env.ORCA_FAKE_TOUCH_MAIN === "1") {
        // Simulate a rogue mutation of protected branch `main`
        const head = spawnSync("git", ["-C", wtDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
        spawnSync("git", ["-C", wtDir, "branch", "-f", "main", head], { encoding: "utf8" });
      }
      c.pushDone(c.flags.task, "succeeded");
      c.ok({ dispatchId: id, state: "ready", turnStart: "observed" });
    },
  },
};
