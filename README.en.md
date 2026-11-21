# orca-pod

English | [简体中文](./README.md)

A lightweight, governance-hardened multi-agent SDLC orchestrator for **Orca ADE** (zero external dependencies, Node.js >= 18).

> Attribution: Originally evolved from [vankhangfet/orca-sdlc-kit](https://github.com/vankhangfet/orca-sdlc-kit) (MIT), now independently refactored into a clean modular engine without promo binaries or a web drag-and-drop editor — centered on terminal-first pre-dev strategy alignment and strict engineering governance.

---

## Key Capabilities

1. **Local Agent & Subscription Scanner + Pre-Dev Strategy Wizard**
   - Scans locally installed agent CLIs (`agy`, `codex`, `claude`, `opencode2`, `opencode`, `zcode`, `gemini`, `kimi`, `cursor`) and live Orca subscription quota status via `orca account list --json` (privacy-safe: never exposes emails, cookies, tokens, or API keys).
   - Recommends a **cross-family** role assignment (coder and reviewer from different model families), walks you through confirming track & branch rules before writing code, updates `.orca/flow*.json`, and records `.orca/STRATEGY.md`.
2. **3-Track SDLC Pipelines**
   - **Track 0 (`flow-hotfix.json`)**: <=3 files fast patch -> diff audit -> PR.
   - **Track 1 (`flow-feature.json`, default)**: micro-plan (<=10 lines) -> coding & tests -> UI Visual Gate -> cross-family review -> PR & merge to `dev`.
   - **Track 2 (`flow-epic.json`)**: triage/PO -> contract architecture & SHA-locked contract review -> isolated parallel worktrees -> serial integration -> visual gate -> senior audit -> release to `dev`.
3. **5-Module Governance Kernel**
   - **Isolated Worktrees** (`.orca/worktree-isolation.mjs`)
   - **Hard Verdict & Contract-Commit Gates** (`.orca/gate-verify.mjs`)
   - **One-Way Door Merge Danger Guard** (`.orca/merge-danger.mjs`)
   - **`turnStart` Health State Machine** (`.orca/health.mjs`)
   - **Out-of-Repo Durable Run Ledger & Anti-Collision Lock** (`.orca/ledger.mjs`)
4. **v0.5 Production Resilience & Full Traceability**
   - **Activity-Aware Watchdog (`.orca/watchdog.mjs`)**: Replaces fixed 600s hard kills. Monitors terminal output, worktree git/file diffs, and artifact growth — extending active workers while catching **output dead-loops**, **stalls**, **prompt/trust blocks (`agent_prompt_blocked`)**, and **gateway disconnects (`ECONNREFUSED`)** with clear diagnostics and automatic fallback.
   - **Primary/Fallback Pre-Flight + `agy` Isolated Worktree Trust (`.orca/preflight.mjs`)**: Probes local gateways (including auto-discovered localhost `opencode.json` endpoints like Magpie `127.0.0.1:3425`) prior to dispatch, downgrades seamlessly to configured fallbacks (recording to ledger), and injects session-scoped `--settings '{"trustedWorkspaces":["<worktreeDir>"]}'` for `agy` without mutating global settings.
   - **GitHub / Gitea Issue-to-PR Traceability (`.orca/issue-tracker.mjs`)**: Auto-enabled when `gh`/`tea` + remote exist; creates/links Epic & sub-task Issues from planning outputs, records them in `ISSUES.json` + ledger, and injects `Closes #N` / `Refs #N` into PR steps.
   - **Stack-Aware CI & Intranet Self-Hosted CD Generator (`.orca/ci-generator.mjs`)**: Detects Python, Node/Vue/Vite, Go, Rust, and Docker Compose (including hybrid multi-dir repos) to emit executable CI plus optional outbound-HTTPS Self-Hosted Runner CD with automated post-deploy health checks.
5. **Full Observability & Extensibility**
   - Offline live status dashboard (`status.html` + JSONP artifact viewer, `--status-preview`), run history archiving/resume, Claude/Codex token usage reporting (`USAGE.md`), webhook notifications (`.orca/notify.json`), and per-step Skills/MCP materialization (`.orca/agent-config.mjs`).

---

## Quick Start

```bash
# Install into a project (TTY automatically scans local agents & launches strategy confirmation)
npx github:shown1985/orca-pod

# Scan local agents & subscription readiness (read-only; --json for AI assistants)
npx github:shown1985/orca-pod --scan
node .orca/flow.mjs --scan --json

# Re-run pre-dev strategy confirmation (or --yes to auto-apply recommended routing)
node .orca/flow.mjs --setup
node .orca/flow.mjs --setup --yes

# Upgrade engine modules only (preserves configs, AGENTS.md, DESIGN.md, STRATEGY.md)
npx github:shown1985/orca-pod --upgrade-engine

# Dry-run & execute pipelines
node .orca/flow.mjs --dry-run "#feat Add CSV export"
node .orca/flow.mjs --config flow-hotfix.json "#hotfix Fix date parser"
node .orca/flow.mjs --config flow-epic.json "#epic Build reporting hub"
```

See [.orca/CONFIGURATION.md](./.orca/CONFIGURATION.md) for the complete schema & CLI reference.

## License

MIT License — see [LICENSE](./LICENSE).
