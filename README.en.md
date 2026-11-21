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
4. **v0.5.1 Production Resilience, Cross-Family Review Isolation & Full Traceability**
   - **Activity-Aware Watchdog (`.orca/watchdog.mjs`)**: Content-hashed worktree/artifact progress monitoring extends active workers (clamped strictly to `maxRuntimeMs`) while catching **output dead-loops**, **stalls**, **unattended workspace-trust blocks** (distinct from normal `user_approval` waits), and **fresh-delta gateway disconnects (`ECONNREFUSED`)** — stopping old dispatches via `worker-stop` with strict `dispatchId` isolation and secret/PII redaction.
   - **Pre-Flight + Cross-Family Review Guard + `agy` Worktree Trust (`.orca/preflight.mjs`)**: Probes local gateways matching the effective model, rematerializes Skills/MCP on fallback, **strictly blocks review steps from falling back into an upstream author's executed model family**, and injects session-scoped `--settings` (`trustedWorkspaces`) for `agy` without touching global settings.
   - **GitHub / Gitea Issue-to-PR Traceability (`.orca/issue-tracker.mjs`)**: Run/repo-scoped `ISSUES.json` with atomic per-issue persistence, strict `--no-issues` isolation, and explicit post-merge close guidance when targeting non-default branches like `dev`.
   - **Stack-Aware CI & PII-Safe Intranet Self-Hosted CD Generator (`.orca/ci-generator.mjs`)**: Detects Python, Node/Vue/Vite, Go, Rust, and `docker-compose.prod.yml` with strict exit codes, least-privilege permissions, Gitea PR comment support, zero container-log PII dumps, and preservation of existing `cd-selfhosted.yml` unless `--force` is passed.
5. **Full Observability & Extensibility**
   - Offline live status dashboard (`status.html` + JSONP artifact viewer, `--status-preview`; `openStatus: false` by default so runs never pop open a browser unless `--open-status` or `defaults.openStatus: true` is set), run history archiving/resume, Claude/Codex token usage reporting (`USAGE.md`), webhook notifications (`.orca/notify.json`), and per-step Skills/MCP materialization (`.orca/agent-config.mjs`).

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
