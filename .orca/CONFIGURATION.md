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
| `openStatus` | `true` | Auto-open `status.html` in default browser on run start |
| `turnStartWindowMs` | `120000` | Window before warning on `turnStart=unobserved` |
| `turnStartEscalateMs` | `600000` | Window before cleanly stopping an unobserved dispatch |
| `ledgerHome` | OS data dir | Custom out-of-repo ledger root (must be outside any git repo) |
| `mergeDanger` | built-in | Threshold overrides (`maxFiles`, `maxLines`, `extraOneWayPatterns`) |

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
| `spec` | Prompt template supporting `{out}`, `{reads}`, `{tasks}`, `{targetBranch}`, `{protectedBranches}`, `{worktreesManifest}`, `{mergeDangerReport}` |

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

## 6. Notifications (`.orca/notify.json`)

Optional per-step and run-end webhook notifications (`slack`, `telegram`, `teams`, `whatsapp`, `generic`). Shipped disabled by default; delivery errors warn once and never disrupt pipeline execution.
