# orca-pod

[English](./README.en.md) | 简体中文

面向 **Orca ADE** 的轻量化、强治理多 Agent 工程编排套件（零外部依赖，纯 Node.js >= 18）。

> 致谢：本项目早期基于 [vankhangfet/orca-sdlc-kit](https://github.com/vankhangfet/orca-sdlc-kit)（MIT）演进而来，现已独立重构为模块化轻量架构，并移除了宣传媒体与网页拖拽编辑器，专注终端优先的开发前策略确认与强工程治理。

---

## 核心特性

1. **初始化扫描 + 开发前对话确认策略（取代网页编辑器）**
   - 自动扫描本机已安装的 Agent CLI（`agy`、`codex`、`claude`、`opencode2`、`opencode`、`zcode`、`gemini`、`kimi`、`cursor`）以及 Orca 托管账号/订阅配额状态（仅读取就绪度与配额百分比，绝不输出密钥/邮箱/Token）。
   - 根据本机真实可用模型家族，自动推荐**跨家族代码审查**（Coding 与 Review 使用不同模型家族）与角色分配，并在空项目开发前与用户对话确认，生成 `.orca/STRATEGY.md` 并同步写入三轨配置。
2. **三轨开发流水线（3-Track Workflow）**
   - **Track 0 (`flow-hotfix.json`)**：≤3 个文件的紧急修补 -> 差异审计 -> PR。
   - **Track 1 (`flow-feature.json` / 默认 `flow.config.json`)**：微型计划（≤10 行）-> 单 Worktree 编码与单测 -> UI 视觉门禁 -> 跨家族代码审查 -> PR 合并至 `dev`。
   - **Track 2 (`flow-epic.json`)**：需求访谈/PO 拆解 -> 契约架构与审查（Contract-Commit SHA 锁定）-> 前后端隔离 Worktree 并行开发 -> 串行集成 -> 视觉门禁 -> 高级审计 -> 发布至 `dev`。
3. **五重工程治理内核**
   - **每步隔离 Worktree**（`.orca/worktree-isolation.mjs`）：并行 worker 拥有独立目录、独立分支与隔离的 Agent Skills/MCP 配置。
   - **硬门禁校验**（`.orca/gate-verify.mjs`）：机器校验 `VERDICT: PASS`、40 位 `Contract-Commit` SHA 与任务合并状态，拒绝失败后放行。
   - **单向门合并风控**（`.orca/merge-danger.mjs`）：自动识别高危变更（Schema 迁移、鉴权/密钥、CI/部署等），阻止越权自动合并，挂起 `PENDING_HUMAN_MERGE`。
   - **`turnStart` 健康状态机**（`.orca/health.mjs`）：区分“仅就绪未开跑”、“静默运行”、“弹窗卡住”与“dispatch 丢失”，杜绝盲目重试导致双发。
   - **仓库外持久化账本与防撞锁**（`.orca/ledger.mjs`）：支持 4 级验收闭环（`implemented` / `integrated` / `merged` / `synced`）、保护分支 SHA 校验及 `--dedup-key` 并发防撞。
4. **v0.5 生产级稳定性与全链路闭环**
   - **活性守护监控（Watchdog，`.orca/watchdog.mjs`）**：取代固定 600s 墙钟硬杀。持续监测终端输出、Worktree 文件/Git 变更与产物增长，健康推进中的长耗时 Worker 自动顺延截止时间；同时精准识别**输出死循环**、**无进展假死（stalled/hang）**、**信任/交互弹窗阻塞（`agent_prompt_blocked`）**与**网关断连（`ECONNREFUSED`）**，输出诊断并自动降级或上报。
   - **主备模型预检降级 + `agy` 隔离 Worktree 信任适配（`.orca/preflight.mjs` + `.orca/lib/orca-cli.mjs`）**：派发前自动探测本地网关（如 `opencode.json` 中的 Magpie `127.0.0.1:3425`）与配置端点，异常时无缝降级至备选 Worker（如 `agy claude-sonnet-5-5 medium`）并写入账本；启动 `agy` 时自动注入会话级 `--settings '{"trustedWorkspaces":["<worktreeDir>"]}'`，绕过新 Worktree 信任弹窗且零污染全局配置。
   - **GitHub / Gitea Issue → PR 全链路可追踪（`.orca/issue-tracker.mjs`）**：检测到 `gh`/`tea` 可用时默认开启，规划阶段自动创建/关联 Epic & 子任务 Issues 并写入 `.orca/artifacts/ISSUES.json` 与账本；PR 阶段自动注入 `Closes #N` / `Refs #N`。
   - **真实技术栈 CI & 内网 Self-Hosted CD 模板生成（`.orca/ci-generator.mjs`）**：自动探测 Python / Node / Vue / Vite / Go / Rust / Docker Compose（含前后端混合仓库），生成可直接执行的 CI；可选生成面向家庭/私服内网的 Self-Hosted Runner CD（出站 HTTPS 拉取任务，无需公网 SSH，部署后自动健康检查）。
5. **完整可观测与扩展能力**
   - 离线免服务实时看板（`status.html` + JSONP artifact 实时预览、`--status-preview`）、Run 历史归档与交互恢复、Claude/Codex Token 统计（`USAGE.md`）、Webhook 通知（`.orca/notify.json`）、按步骤动态挂载 Skills/MCP（`.orca/agent-config.mjs`）。

---

## 快速开始

### 1. 在新项目初始化（含本地 Agent 扫描与策略确认）

```bash
# 本地路径安装（交互式终端会自动扫描本机 Agent 并引导确认开发策略）
npx /path/to/orca-pod

# 或直接从 GitHub 安装
npx github:shown1985/orca-pod

# 仅扫描本机 Agent 与订阅配额（不修改文件；支持 --json 给 AI 助手调用）
npx /path/to/orca-pod --scan
npx /path/to/orca-pod --scan --json

# 已有项目一键重新确认策略，或自动采纳推荐配置
node .orca/flow.mjs --setup
node .orca/flow.mjs --setup --yes

# 仅升级引擎内核，保留项目自定义配置与 AGENTS.md / DESIGN.md / STRATEGY.md
npx /path/to/orca-pod --upgrade-engine
```

### 2. 运行三轨流水线

```bash
# 先 dry-run 检查计划、worktree、门禁与路由
node .orca/flow.mjs --dry-run "#feat 新增用户导出功能"

# Track 0 — Hotfix
node .orca/flow.mjs --config flow-hotfix.json "#hotfix 修复日期解析越界"

# Track 1 — Feature（默认）
node .orca/flow.mjs "#feat 新增导出与筛选"

# Track 2 — Epic / 0->1 并行开发
node .orca/flow.mjs --config flow-epic.json "#epic 构建报表中心"
```

### 3. 常用参数

| 参数 | 说明 |
| --- | --- |
| `--scan [--json] [--no-orca]` | 扫描本机 Agent CLI 与 Orca 订阅状态并输出推荐策略 |
| `--setup [--yes]` | 启动开发前策略确认向导，更新三轨配置并生成 `.orca/STRATEGY.md` |
| `--config <file>` | 指定轨道配置（如 `flow-hotfix.json`、`flow-epic.json`） |
| `--dry-run` | 仅打印执行计划与历史记录，不启动 Agent |
| `--from <stepId>` / `--only <a,b>` | 从指定步骤恢复，或只运行子集步骤 |
| `--agent <step>=<agent>` | 单次覆盖某步骤使用的 Agent |
| `--worktree <sel>` / `--create-worktree` | 指定或自动创建 Orca worktree |
| `--allow-one-way-merge` | 经人工审批后放行单向门变更的自动合并 |
| `--dedup-key <key>` | 启用跨进程防重复触发运行锁 |
| `--ledger-home <dir>` | 指定仓库外账本目录（严禁位于 git 仓库内） |
| `--status-preview` | 渲染样例状态看板（不启动 Agent） |
| `--new` | 跳过历史恢复选择，直接开始新 Run |

---

## 仓库模块化结构

```text
.orca/
├── flow.mjs                  # 轻量 CLI 入口与主控循环
├── agent-scanner.mjs         # 本地 Agent CLI + Orca 订阅扫描与跨家族推荐
├── strategy-wizard.mjs       # 开发前对话式策略确认与配置写入
├── agent-config.mjs          # 按步骤动态挂载/恢复 Skills 与 MCP
├── worktree-isolation.mjs    # 并行步骤隔离 Worktree 生命周期
├── gate-verify.mjs           # VERDICT / Contract-Commit / 合并硬门禁
├── merge-danger.mjs          # 单向门高危变更分类与越权合并阻断
├── health.mjs                # turnStart 证明与 5 状态健康状态机
├── ledger.mjs                # 仓库外账本、4 级验收闭环与防撞锁
├── lib/
│   ├── orca-cli.mjs          # Orca CLI 封装、worktree 解析、终端冷/热启动
│   ├── runner.mjs            # 串/并行调度、readiness 门禁、重试与人工 gate
│   ├── status.mjs            # 实时状态页、JSONP 快照与 Run 归档
│   ├── status-template.html  # 离线状态页模板
│   ├── usage.mjs             # Claude / Codex Token 消耗统计
│   ├── notify.mjs            # Webhook 通知（Slack/Telegram/Teams/WhatsApp/Generic）
│   └── nudge.mjs             # 可选产物缺失提醒状态机（默认关闭）
├── flow.config.json          # 默认轨道配置（默认同 Track 1）
├── flow-hotfix.json          # Track 0 配置
├── flow-feature.json         # Track 1 配置
├── flow-epic.json            # Track 2 配置
└── prompts/                  # 角色提示词（triage-po / frontend-worker / senior-auditor）
```

详细配置项请参阅 [.orca/CONFIGURATION.md](./.orca/CONFIGURATION.md)。

## 开源许可

MIT License — 详见 [LICENSE](./LICENSE)。
