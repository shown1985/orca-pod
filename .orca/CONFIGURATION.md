# Orca-Pod Configuration & CLI Reference

All pipeline behavior lives in `.orca/flow.config.json` (or any `--config <file>` such as `flow-hotfix.json`, `flow-feature.json`, `flow-epic.json`).

---

## 1. Top-Level Fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `artifactsDir` | string | `".orca/artifacts"` | Relative artifact directory inside the active worktree |
| `maxRetries` | int >= 0 | `2` | Global `onFailGoto` retry cap (overridable per step) |
| `autoRun` | boolean | `true` | `true`: unattended autonomy & ignore `gate`; `false`: allow `interactive` & `gate` |
| `defaults` | object | `{}` | Shared defaults for timeout, worktree, branch policy, health, nudge, mergeDanger |
| `skills` | object | `{}` | Named skill registry (`{ path }` or `{ description, prompt }`) |
| `mcp` | object | `{}` | Named MCP server registry (`{ command, args, env }` or `{ url, headers }`) |
| `pipeline` | array | required | Ordered list of step objects |

---

## 2. `defaults` Knobs

| Field | Default | Description |
| --- | --- | --- |
| `timeoutMs` | `900000` | Silence warning threshold per step (ms) |
| `hardTimeoutMs` | `4 * timeoutMs` | Absolute per-step runtime cap before stopping cleanly (`still-running`) |
| `worktree` | `null` | Pin an Orca worktree selector (`name:...` or `path:...`); `null` = auto-detect |
| `autoCreateWorktree` | `false` | Automatically create `flow-<slug>-<stamp>` when auto-detect fails |
| `model` | `"default"` | Default model (`"default"` lets each CLI use its own default model) |
| `targetBranch` | `"dev"` | Release target branch (must NOT be in `protectedBranches`) |
| `protectedBranches` | `["main","master"]` | Protected branches verified untouched by closeout & merge guard |
| `readinessRetries` | `3` | Max producer repair attempts when a declared input artifact is missing |
| `readinessMinBytes` | `200` | Minimum byte size for a valid artifact |
| `nudgeRetries` | `0` | Automated nudge attempts for missing artifacts (`0` = disabled) |
| `nudgeTimeoutMs` | `120000` | Idle/post-done wait before sending a nudge (ms) |
| `openStatus` | `false` | Auto-open `status.html` in default browser on run start (opt in via `openStatus: true` or `--open-status`; `--no-open-status` always disables) |
| `turnStartWindowMs` | `120000` | Window before warning on `turnStart=unobserved` |
| `turnStartEscalateMs` | `600000` | Window before cleanly stopping an unobserved dispatch |
| `ledgerHome` | OS data dir | Custom out-of-repo ledger root (must be outside any git repo) |
| `mergeDanger` | built-in | Threshold overrides (`maxFiles`, `maxLines`, `extraOneWayPatterns`) |
| `watchdog` | enabled | Activity-aware supervisor: `extendOnActivity`, `stallTimeoutMs`, `loopThreshold`, `maxRuntimeMs`, `fallbackOnGatewayError`, `fallbackOnLoop`, `fallbackOnStall`, `fallbackOnPromptBlocked` |
| `preflight` | enabled | Pre-dispatch endpoint check: `timeoutMs`, `autoDetectOpencodeEndpoints` (auto-probes localhost `opencode.json` providers like Magpie `127.0.0.1:3425`) |
| `fallback` / `agentFallbacks` / `reviewerFallbacks` | `null` | Per-agent fallback candidate(s) `{ agent, model, effort }` used on preflight failure or Watchdog anomaly (review gates enforce strict cross-family isolation against upstream authors and never inherit unrestricted global `defaults.fallback`) |
| `issueTracking` | `"auto"` | GitHub/Gitea Issue traceability: `mode` (`"auto" \| true \| false`), `provider` (`"auto" \| "gh" \| "tea"`), `epicIssue`, `closeOnPr`, `defaultBranch` |

---

## 3. Step Fields

| Field | Description |
| --- | --- |
| `id` / `title` / `enabled` | Unique identifier, display label, and toggle |
| `agent` / `model` / `effort` | Agent CLI ID (`agy`, `codex`, `claude`, `opencode2`, `zcode`, etc.), optional model & effort |
| `writes` / `reads` / `progress` | Output artifact filename, upstream step IDs, optional checklist filename (`TASKS.md`) |
| `parallelWith` | Run concurrently with an earlier contiguous step ID (flat groups only) |
| `isolatedWorktree` | `true`: provision an isolated git worktree & branch per parallel worker |
| `onFailGoto` / `maxRetries` | Target step ID to loop back to on definite `failed` outcome |
| `gate` / `interactive` | Manual-mode approval gate / interview protocol (when `autoRun: false`) |
| `skills` / `mcp` | Arrays of registry names materialized into the step's worktree and restored afterward |
| `verify` | Hard gate checks: `{ requireVerdict: "PASS", requireContractCommit: true, requireMergedTasks: true, mergeDangerCheck: true }` |
| `crossFamilyWith` | Array of upstream author step IDs whose actual executed model family must NOT match this review step (even after preflight/runtime fallback) |
| `fallback` / `fallbacks` / `preflight` | Per-step fallback worker chain (`{ agent, model, effort }`) and preflight endpoint check (`{ tcp, url, timeoutMs }`) |
| `watchdog` | Per-step Watchdog overrides (e.g. `stallTimeoutMs`, `loopThreshold`, `maxRuntimeMs`) |
| `spec` | Prompt template supporting `{out}`, `{reads}`, `{tasks}`, `{targetBranch}`, `{protectedBranches}`, `{worktreesManifest}`, `{mergeDangerReport}`, `{epicIssue}`, `{issueRefs}`, `{issueCloses}`, `{issueTraceability}` |

---

## 4. Pre-Development Scan & Strategy Setup

Before starting work on a fresh repository:

```bash
# 1. Scan installed agent CLIs and Orca subscription readiness
node .orca/flow.mjs --scan
node .orca/flow.mjs --scan --json

# 2. Confirm default track, cross-family agent routing, and target branches
node .orca/flow.mjs --setup

# Or auto-apply the recommended strategy non-interactively
node .orca/flow.mjs --setup --yes
```

This updates `.orca/flow-{hotfix,feature,epic}.json`, `.orca/flow.config.json`, and writes `.orca/STRATEGY.md`.

---

## 5. Governance & Operations CLI

```bash
# Inspect merge danger classification for current branch vs dev
node .orca/merge-danger.mjs --repo . --base dev

# Reconcile 4-level closeout after a human merges a One-Way Door PR
node .orca/ledger.mjs closeout --run <runKey> --repo . --target-branch dev

# List unresolved pending-human-merge runs
node .orca/ledger.mjs pending

# Check or release a --dedup-key lock
node .orca/ledger.mjs check-lock --dedup-key <key> --repo .
```

---

## 5.5 Watchdog, Cross-Family Fallback, `agy` Trust, Issue Sync & CI/CD Generator (v0.5.1)

- **Watchdog & Runtime Boundaries**: Each step distinguishes startup proof (`turnStartWindowMs: 120s`, `turnStartEscalateMs: 600s`), idle warning (`timeoutMs: 900s`), step runtime cap (`hardTimeoutMs: 4 * timeoutMs`), and optional absolute ceiling (`watchdog.maxRuntimeMs`). Active workers making content-hashed git/file, artifact, or non-looping terminal progress automatically extend `hardTimeoutMs` (strictly clamped to `maxRuntimeMs` when `maxRuntimeMs > 0`). Output dead-loops, true stalls, unattended workspace-trust prompts (`agent_prompt_blocked` — distinct from normal `user_approval` human waits), and fresh terminal-tail gateway disconnects (`ECONNREFUSED`) are sanitized, deduplicated, recorded in the ledger, and trigger controlled `worker-stop` + dispatch-fenced fallback.
- **Pre-flight, Cross-Family Fallback Guard + `agy` Isolated Worktree Compatibility**: Before dispatching, `preflight.mjs` probes configured TCP/HTTP endpoints and OpenCode local gateways (`opencode.json` / `opencode.jsonc` matching the effective model) and seamlessly downgrades to healthy fallbacks while materializing Skills/MCP for the active agent. Review gates (`contract-review`, `task-review-merge`, `senior-audit`, `diff-audit`, `code-review`, `crossFamilyWith`) reject any candidate whose model family matches an upstream author's actual executed family — blocking rather than self-reviewing. When launching `agy` / `antigravity`, `orca-cli.mjs` injects session-scoped `--settings` (`trustedWorkspaces`) without mutating global `~/.gemini/antigravity-cli/settings.json`.
- **GitHub/Gitea Issue + PR Traceability**: `ISSUES.json` is scoped by forge/repo/objective (`--no-issues` disables loading & prompt injection completely). When `targetBranch` (e.g. `dev`) differs from `defaultBranch` (e.g. `main`), PR steps receive explicit post-merge `gh issue close` guidance since GitHub only auto-closes `Closes #N` on the default branch.
  ```bash
  node .orca/issue-tracker.mjs status
  node .orca/flow.mjs --epic-issue 42 "#feat Continue Epic"
  node .orca/flow.mjs --no-issues "#hotfix Quick local fix"
  ```
- **Stack-Aware CI & PII-Safe Intranet Self-Hosted Runner CD**: Prioritizes `docker-compose.prod.yml` / `compose.prod.yml`, omits raw container logs in CI to protect intranet PII, and **preserves existing `.github/workflows/cd-selfhosted.yml` by default** unless `--force` is explicitly passed:
  ```bash
  node .orca/ci-generator.mjs --detect
  node .orca/ci-generator.mjs --write --self-hosted-cd --health-url http://127.0.0.1:8000/health
  node .orca/ci-generator.mjs --write --self-hosted-cd --force
  node .orca/flow.mjs --generate-ci --self-hosted-cd [--force]
  ```

---

## 6. Notifications (`.orca/notify.json`)

Optional per-step and run-end webhook notifications (`slack`, `telegram`, `teams`, `whatsapp`, `generic`). Shipped disabled by default; delivery errors warn once and never disrupt pipeline execution.
