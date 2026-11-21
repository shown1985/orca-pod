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
4. **Full Observability & Extensibility**
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
