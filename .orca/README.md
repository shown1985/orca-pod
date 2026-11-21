# `.orca/` — Orca-Pod Orchestrator Workspace

Quick reference for files inside `.orca/`:

| File / Directory | Purpose |
| --- | --- |
| `flow.mjs` | Main CLI orchestrator entry point (`node .orca/flow.mjs ...`) |
| `agent-scanner.mjs` | Scans local agent CLIs & Orca subscription readiness (`--scan`) |
| `strategy-wizard.mjs` | Interactive pre-dev strategy confirmation (`--setup`) |
| `flow.config.json` | Default pipeline configuration (Track 1 Feature by default) |
| `flow-hotfix.json` | Track 0 — Hotfix pipeline |
| `flow-feature.json` | Track 1 — Feature pipeline |
| `flow-epic.json` | Track 2 — Epic / 0->1 parallel isolated-worktree pipeline |
| `STRATEGY.md` | Project development strategy confirmed via `--setup` |
| `notify.json` | Optional webhook notification configuration (disabled by default) |
| `prompts/` | Reusable step prompts (`triage-po.md`, `frontend-worker.md`, `senior-auditor.md`) |
| `lib/` | Internal runtime modules (`orca-cli`, `runner`, `status`, `usage`, `notify`, `nudge`) |
| `agent-config.mjs` / `gate-verify.mjs` / `worktree-isolation.mjs` / `merge-danger.mjs` / `health.mjs` / `ledger.mjs` | Governance & isolation engine modules |

See [CONFIGURATION.md](./CONFIGURATION.md) for full details.
