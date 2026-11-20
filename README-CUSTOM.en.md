# orca-pod Usage Guide & Custom Features Reference (English)

[中文](README-CUSTOM.md) | [English](README-CUSTOM.en.md) · [Back to README](README.en.md)

This guide documents all customizations added in `orca-pod` on top of `vankhangfet/orca-sdlc-kit`, including installation & safe merging, 3-Track workflow switching, personal model-pool & reasoning-effort routing, the frontend UI/UX Visual Gate, headless TokenHub CI PR reviews, and upstream syncing.

---

## 1. Inventory of New & Customized Files

The upstream core engine (`.orca/flow.mjs` and `.orca/agent-config.mjs`) is **completely untouched**. All customizations live in configs, prompts, specs, CI templates, and the scaffolder:

| File Path | Status | Purpose |
|---|---|---|
| `.orca/flow-hotfix.json` | New | **Track 0 Fast Path**: skips PO, Red→Green regression test first + `GPT-6.2 Sol` (High) fast diff audit + open PR |
| `.orca/flow-feature.json` | New | **Track 1 Standard Track**: ≤10-line micro plan + single-worktree coding/unit tests + conditional Visual Gate + `GPT-6.2 Sol` (High) review + open PR |
| `.orca/flow-epic.json` | New | **Track 2 Full Orchestration**: PO DAG decomposition + Contract Commit first + stateless parallel worktrees + serial integration + Visual Gate + `GPT-6.2 Sol` (Xhigh) final audit + **Orca Decision Gate** |
| `.orca/flow.config.json` | Updated | Default entry point mapped to **Track 1** (`flow-feature.json`) with track-switching instructions |
| `.orca/prompts/triage-po.md` | New | 3-Track triage and lightweight/full PO Backlog + DAG decomposition skill prompt |
| `.orca/prompts/frontend-worker.md` | New | Frontend implementation, anti-AI-slop rules, 4-state completeness & Playwright screenshot prep skill prompt |
| `.orca/prompts/senior-auditor.md` | New | Cross-family senior code/security audit & 2-round circuit-breaker verdict skill prompt |
| `AGENTS.md` | New | Repo-wide engineering guardrails, 3-Track triage, worktree isolation, and model-pool routing rules |
| `DESIGN.md` | New | Google Stitch-compatible YAML Design Tokens + Markdown skeleton, Open Design MCP workflow & Visual Gate checklist |
| `.worktreeinclude` | New | Local ignored files (`.env`, `.env.local`, etc.) synced into newly spawned git worktrees |
| `.github/workflows/ci-release.yml` | New | GitHub Actions CI + Tencent TokenHub API headless Chinese PR risk summary |
| `.gitea/workflows/ci-release.yml` | New | Gitea Actions CI + Tencent TokenHub API headless Chinese PR risk summary |
| `bin/init.mjs` & `package.json` | Updated | Expanded whitelist, renamed to `orca-pod`, preserves existing custom files and prints `diff -u` merge hints |

---

## 2. Installing into Target Repositories

### Install from GitHub (Recommended)

```bash
# Shorthand
npx github:shown1985/orca-pod

# Explicit SSH (for private repos)
npx git+ssh://git@github.com/shown1985/orca-pod.git
```

### Install from a Local Clone

```bash
npx /path/to/orca-pod
```

### Safe Non-Overwrite Behavior

- **Default (Safe Mode)**: Existing user files (`AGENTS.md`, `DESIGN.md`, `.worktreeinclude`, `orca.yaml`, `.orca/flow.config.json`, `ci-release.yml`) are **never overwritten**. The installer preserves your versions and prints exact `diff -u` commands for manual review/merging.
- **Force Overwrite**:
  ```bash
  npx github:shown1985/orca-pod --force
  ```

---

## 3. Using & Switching the 3-Track Workflow

### Quick Command Matrix

| Track | Tag | When to Use | Dry-Run Preview | Execute |
|---|---|---|---|---|
| **Track 0** | `#hotfix` | ≤3 files changed, zero API/DB/type contract changes | `node .orca/flow.mjs --config flow-hotfix.json --dry-run "#hotfix ..."` | `node .orca/flow.mjs --config flow-hotfix.json "#hotfix ..."` |
| **Track 1 (Default)** | `#feat` | Single clear feature or standard bug fix | `node .orca/flow.mjs --dry-run "#feat ..."` | `node .orca/flow.mjs "#feat ..."` |
| **Track 2** | `#epic` | 0→1 module, large epic, or cross-stack refactor | `node .orca/flow.mjs --config flow-epic.json --dry-run "#epic ..."` | `node .orca/flow.mjs --config flow-epic.json "#epic ..."` |

> To make Track 2 the default in a specific repo, copy it over: `cp .orca/flow-epic.json .orca/flow.config.json`.

### Key Architectural Rules Across Tracks

- **Track 0 (Red → Green Fast Path)**: Skips PO/Backlog entirely. Enforces writing a failing regression test first (Red) before applying the minimal surgical fix (Green), followed by `GPT-6.2 Sol` (High) diff audit and PR creation.
- **Track 1 (Standard Single-Worktree Track)**: Replaces full PO ceremonies with a ≤10-line micro plan. Codes and unit-tests in one worktree, runs Visual Gate when UI is touched, runs cross-family `GPT-6.2 Sol` (High) review, and opens a PR.
- **Track 2 (Contract-First + Parallel/Serial Split + Decision Gate)**:
  1. **Contract-First**: Architect commits frozen API Schemas, shared TypeScript types, DB migrations, and `DESIGN.md` in a dedicated **Contract Commit** before spawning parallel workers.
  2. **Stateless Parallel + Stateful Serial**: Concurrent `worker-backend` and `worker-frontend` steps run **only `lint`, `typecheck`, and `unit-test`** (preventing DB/port contention). DB migrations, full service boot, and integration tests run in a single serial node (`serial-integration`) after joining.
  3. **2-Round Circuit Breaker + Human Gate**: Review retries are hard-capped at **2 rounds (`maxRetries: 2`)**, halting for human intervention if exceeded. With `"autoRun": false` and `"gate": true` on `pr-ci-gate`, the pipeline opens a PR, triggers CI, and pauses at an **Orca Decision Gate** for explicit human approval — never auto-merging to `main`.

### Handy Runtime Overrides

```bash
# Resume from a specific step
node .orca/flow.mjs --from code-review "#feat ..."

# One-off agent override without editing JSON
node .orca/flow.mjs --agent coding=opencode "#feat ..."

# Enable optional Grill Me requirements interview in Track 2
node .orca/flow.mjs --config flow-epic.json --grill-me "#epic ..."
```

---

## 4. Reference Model Pool & Reasoning Effort Preset

> **No Model Lock-In**: Every step in the 3-track JSON configs defaults to `"model": "default"` (inheriting your local CLI's configured default). **You can freely swap in any commercial or open-source model** (DeepSeek, Qwen, Kimi, GLM, Claude, GPT, Gemini, or local Ollama/vLLM). The table below is a battle-tested reference preset — set `"model"` in JSON or pass `--agent <step>=<cli>` whenever you want to pin a specific model.

| Role / Stage | Reference Model (Swappable) | Suggested Effort | Access Channel | Guardrails |
|---|---|---|---|---|
| **0→1 Architecture & Contracts** | `Gemini 4 Carbon` | **High** | Google AI Ultra / Antigravity / Gemini CLI | **Never use Low** |
| **Coordinator / PO / Visual Gate** | `Gemini 4 Neon` | **Medium** | Gemini CLI / Antigravity | **Never use Low on Carbon/Neon** |
| **Primary Parallel Worker (70%)** | `DeepSeek-V4.1-Flash-1017` | **High** | OpenCode Go | May switch to **Max** for tough bugs |
| **Complex Terminal Debugging / Deep Refactor (30%)** | `Kimi K3.1 Pro` / `Kimi K2.7 Code` or `GLM-5.3` | **Low or High** (explicit) | OpenCode Go | **Never let GLM-5.3 run on default Max** (stalls concurrent queues) |
| **Unit Tests / Lint / Docs / PR Summaries** | `DeepSeek-V4.1-Flash-1017` / `Hy4 flash` / `Gemini 4 Hydrogen` | **Low / Medium** | OpenCode / Gemini CLI | Lightweight low-cost tasks |
| **Senior Cross-Family Reviewer** | `GPT-6.2 Sol` | Standard **High** / Security & Concurrency **Xhigh** | GPT Plus / Codex CLI | **NEVER use Max** (measured degradation & quota waste) |
| **Headless CI PR Review Fallback** | `DeepSeek-V4.1-Flash-1017` / `Hy4 flash` | **Low / Medium** | **Tencent TokenHub API** | **Never use personal subscription accounts in remote CI runners** |

---

## 5. Frontend UI/UX Closed Loop & Visual Gate

1. **0→1 Drafting**: Draft initial UI in **Google Stitch**, export Design Tokens into the YAML frontmatter of `DESIGN.md`, and freeze it in the Contract Commit.
2. **Daily Iteration**: Switch to **Open Design MCP (`nexu-io/open-design`) + local `DESIGN.md`**, prioritizing existing component reuse.
3. **Anti-AI-Slop Rules**: Restrained whitespace, clear typographic weight contrast, subtle `1px` borders; ban purple/blue neon gradients and decorative filler cards.
4. **Four-State Completeness**: Every async view must implement `Default`, `Loading Skeleton`, `Empty`, and `Error`.
5. **Visual Gate**: Capture Playwright screenshots at `1440px` desktop and `390px` mobile into `.orca/artifacts/screenshots/` for `Gemini 4 Neon` (Medium) to audit against `DESIGN.md`.

---

## 6. Headless CI/CD & Tencent TokenHub API Setup

The scaffold ships `.github/workflows/ci-release.yml` and `.gitea/workflows/ci-release.yml`. To enable automated Chinese PR risk summaries:

1. Configure repository **Secrets**:
   - `TOKENHUB_API_KEY` *(required)*: Tencent TokenHub API key.
   - `TOKENHUB_BASE_URL` *(optional)*: defaults to `https://api.tokenhub.tencent.com/v1`.
   - `GITEA_TOKEN` *(Gitea only, if default token lacks comment permissions)*: token to post PR comments.
2. Optionally configure repository **Variables**:
   - `TOKENHUB_REVIEW_MODEL`: defaults to `DeepSeek-V4.1-Flash-1017` (can also use `Hy4 flash`).
3. If `TOKENHUB_API_KEY` is unset, the workflow gracefully skips the AI summary step while still running lint/typecheck/tests.

---

## 7. Syncing Upstream `vankhangfet/orca-sdlc-kit` Updates

The original repo is preserved as the `upstream` remote:

```bash
# 1. Fetch upstream commits
git fetch upstream

# 2. Review incoming changes
git log HEAD..upstream/main --oneline

# 3. Merge upstream into main
git merge upstream/main

# 4. If flow.config.json or README.md conflict, keep your customized versions:
#    git checkout --ours .orca/flow.config.json README.md
#    git add .orca/flow.config.json README.md && git commit
```
