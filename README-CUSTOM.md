# orca-pod 使用文档与新增特性手册（中文）

[中文](README-CUSTOM.md) | [English](README-CUSTOM.en.md) · [返回主 README](README.md)

本手册详细说明 `orca-pod` 相比上游 `vankhangfet/orca-sdlc-kit` 的所有新增内容、安装与安全合并方式、三轨流水线切换、个人模型池路由规范、前端 UI/UX 闭环、无头 CI 审 PR 配置，以及上游同步流程。

---

## 一、 新增与改造文件全景

核心引擎 `.orca/flow.mjs` 与 `.orca/agent-config.mjs` 保持上游原版零修改，所有定制内容如下：

| 文件路径 | 类型 | 用途说明 |
|---|---|---|
| `.orca/flow-hotfix.json` | 新增 | **Track 0 极速通道**：跳过 PO，Red→Green 测试先行 + `GPT-6.2 Sol` (High) 极速 Diff 审计 + 提 PR |
| `.orca/flow-feature.json` | 新增 | **Track 1 标准通道**：≤10 行微型 Plan + 单 Worktree 编码单测 + 按需 Visual Gate + `GPT-6.2 Sol` (High) 审查 + 提 PR |
| `.orca/flow-epic.json` | 新增 | **Track 2 完整编排通道**：PO DAG 拆解 + 契约 Commit 先行 + 无状态并发 Worktree + 串行集成 + Visual Gate + `GPT-6.2 Sol` (Xhigh) 终审 + **Orca Decision Gate** |
| `.orca/flow.config.json` | 改造 | 默认入口，默认指向 **Track 1**（`flow-feature.json`）并在顶部注释三轨切换命令 |
| `.orca/prompts/triage-po.md` | 新增 | 三轨分诊与轻量/完整 PO Backlog + DAG 拆解 Prompt（Skill） |
| `.orca/prompts/frontend-worker.md` | 新增 | 前端实现、反 AI 塑料感红线、四态完整性与 Playwright 截图准备 Prompt（Skill） |
| `.orca/prompts/senior-auditor.md` | 新增 | 跨家族写审分离资深审计与 2 轮熔断裁决 Prompt（Skill） |
| `AGENTS.md` | 新增 | 仓库级工程红线、三轨分诊、Worktree 隔离纪律与个人模型池总规范 |
| `DESIGN.md` | 新增 | 兼容 Google Stitch 导出的 YAML Design Tokens + Markdown 骨架、Open Design MCP 工作流与 Visual Gate 清单 |
| `.worktreeinclude` | 新增 | 派生新 Worktree 时自动同步 `.env`、`.env.local` 等本地忽略文件 |
| `.github/workflows/ci-release.yml` | 新增 | GitHub Actions CI + 腾讯 TokenHub API 无头中文 PR 风险摘要模板 |
| `.gitea/workflows/ci-release.yml` | 新增 | Gitea Actions CI + 腾讯 TokenHub API 无头中文 PR 风险摘要模板 |
| `bin/init.mjs` & `package.json` | 改造 | 同步扩展安装白名单、包名改为 `orca-pod`、保留已有文件并输出 `diff -u` 安全合并提示 |

---

## 二、 安装到任意业务仓库

### 1. 从 GitHub 一键安装（推荐）

```bash
# 简写方式
npx github:shown1985/orca-pod

# 或显式 SSH 方式（适合私有库）
npx git+ssh://git@github.com/shown1985/orca-pod.git
```

### 2. 本机离线安装

```bash
npx /path/to/orca-pod
```

### 3. 安全不覆盖与合并提示

- **默认安全模式**：目标仓库已存在的 `AGENTS.md`、`DESIGN.md`、`.worktreeinclude`、`orca.yaml`、`.orca/flow.config.json`、`ci-release.yml` **不会被覆盖**，脚本会保留你的本地修改并自动打印 `diff -u` 比对命令方便人工合并。
- **强制覆盖模式**（仅在确认整体刷新脚手架模板时使用）：
  ```bash
  npx github:shown1985/orca-pod --force
  ```

---

## 三、 三轨工作流（3-Track Workflow）使用与切换

### 1. 触发规则与命令速查

| 轨道 | 标签 | 适用场景 | 干跑预览命令 | 正式执行命令 |
|---|---|---|---|---|
| **Track 0** | `#hotfix` | 改动 ≤3 文件、无 API/DB/类型契约变更的紧急修复或微调 | `node .orca/flow.mjs --config flow-hotfix.json --dry-run "#hotfix ..."` | `node .orca/flow.mjs --config flow-hotfix.json "#hotfix ..."` |
| **Track 1（默认）** | `#feat` | 单个明确 Feature 或常规 Bug | `node .orca/flow.mjs --dry-run "#feat ..."` | `node .orca/flow.mjs "#feat ..."` |
| **Track 2** | `#epic` | 0→1 新模块、大型 Epic 或跨端重构 | `node .orca/flow.mjs --config flow-epic.json --dry-run "#epic ..."` | `node .orca/flow.mjs --config flow-epic.json "#epic ..."` |

> 如希望某业务仓库把默认轨道改为 Track 2，直接覆盖默认入口即可：`cp .orca/flow-epic.json .orca/flow.config.json`。

### 2. 三轨核心机制说明

- **Track 0（Red → Green 极速通道）**：完全跳过 PO 与 Backlog；强制先写失败回归测试复现 Bug（Red），再以最小改动让单测转绿（Green），经 `GPT-6.2 Sol` (High) 极速 Diff 审计后提 PR 触发 CI。
- **Track 1（标准单 Worktree 通道）**：轻量跳过完整 PO，仅输出 ≤10 行微型 Plan；在单个 Worktree 内完成编码与单测，如涉及 UI 改动自动经过 Visual Gate，随后由 `GPT-6.2 Sol` (High) 跨家族审查并提 PR。
- **Track 2（契约先行 + 并发/串行分离 + Decision Gate）**：
  1. **契约先行**：由架构师先提交包含 API Schema / TypeScript 共享类型 / 数据库迁移 / `DESIGN.md` 的 **契约 Commit**，再启动并发 Worker。
  2. **无状态并发 + 有状态串行**：`worker-backend` 与 `worker-frontend` 并发执行时**只跑 `lint` / `typecheck` / `unit-test`**（避免端口与数据库争抢）；合并集成分支后的 DB Migration、完整服务启动与集成测试统一在单一串行节点 `serial-integration` 完成。
  3. **2 轮熔断 + 人工门禁**：跨模型审查打回上限锁死为 **2 轮（`maxRetries: 2`）**，超限挂起交由人工处理；配置 `"autoRun": false` 且终点 `pr-ci-gate` 开启 `"gate": true`，提 PR 跑通 CI 后通过 **Orca Decision Gate** 等待人工确认合并与发布，绝不自动 Merge 到 `main`。

### 3. 常用断点与单次覆盖参数

```bash
# 从某个步骤断点续跑（例如修复审核意见后继续）
node .orca/flow.mjs --from code-review "#feat ..."

# 临时替换某一步的 Agent（不改配置文件）
node .orca/flow.mjs --agent coding=opencode "#feat ..."

# Track 2 开启需求访谈（Grill Me）
node .orca/flow.mjs --config flow-epic.json --grill-me "#epic ..."
```

---

## 四、 参考模型池与推理强度（Reasoning Effort）建议

> **默认不锁死模型**：三轨 JSON 配置中所有步骤默认均为 `"model": "default"`（沿用各 CLI 自身默认配置），**你可以自由替换为任意开源或闭源模型**（如 DeepSeek、Qwen、Kimi、GLM、Claude、GPT、Gemini 或本地 Ollama/vLLM 端点）。下表仅作为参考推荐组合与避坑指南，如需指定具体模型，修改对应步骤的 `"model"` 字段或运行时追加 `--agent <step>=<cli>` 即可。

| 角色 / 阶段 | 参考模型（可自由替换） | 建议推理强度 | 常见通道 | 避坑与选型原则 |
|---|---|---|---|---|
| **0→1 架构与契约设计** | `Gemini 4 Carbon` | **High** | Google AI Ultra / Antigravity / Gemini CLI | **禁止开 Low** |
| **日常协调 / PO 拆解 / 视觉验收** | `Gemini 4 Neon` | **Medium** | Gemini CLI / Antigravity | **禁止对 Carbon / Neon 开 Low** |
| **主力并发开发 Worker（70%）** | `DeepSeek-V4.1-Flash-1017` | **High** | OpenCode Go | 疑难 Bug 可临时切 **Max** |
| **复杂终端排错 / 长会话深度重构（30%）** | `Kimi K3.1 Pro` / `Kimi K2.7 Code` 或 `GLM-5.3` | **Low 或 High**（手动指定） | OpenCode Go | **严禁放任 GLM-5.3 走默认 Max 卡死并发队列** |
| **单测 / Lint / 文档 / PR 摘要** | `DeepSeek-V4.1-Flash-1017` / `Hy4 flash` / `Gemini 4 Hydrogen` | **Low / Medium** | OpenCode / Gemini CLI | 轻量低成本任务 |
| **资深 Reviewer（跨家族写审分离）** | `GPT-6.2 Sol` | 常规 **High** / 核心安全与并发终审 **Xhigh** | GPT Plus / Codex CLI | **绝对不要开 Max**（避免实测负优化与额度浪费） |
| **无头 CI/CD 自动审 PR 兜底** | `DeepSeek-V4.1-Flash-1017` / `Hy4 flash` | **Low / Medium** | **腾讯 TokenHub API** | **严禁在远端 CI Runner 中使用个人订阅账号** |

---

## 五、 前端 UI/UX 闭环与 Visual Gate

1. **0→1 起稿**：使用 **Google Stitch** 生成初版界面并导出 Design Tokens 覆盖根目录 `DESIGN.md` 顶部的 YAML Frontmatter，随契约 Commit 冻结。
2. **日常增量迭代**：切回 **Open Design MCP (`nexu-io/open-design`) + 本地 `DESIGN.md`**，组件复用优先。
3. **反 AI 塑料感红线**：克制留白、清晰字重对比、微弱 `1px` 边界；禁止滥用紫蓝霓虹渐变与无意义装饰卡片。
4. **四态完整性**：每个数据视图必须覆盖 `Default` / `Loading Skeleton` / `Empty` / `Error`。
5. **Visual Gate**：前端改动需通过 Playwright 在 `1440px` 桌面端与 `390px` 移动端截图至 `.orca/artifacts/screenshots/`，由 `Gemini 4 Neon` (Medium) 对照 `DESIGN.md` 验收通过后方可进入 Code Review。

---

## 六、 无头 CI/CD 与腾讯 TokenHub API 配置

安装后业务仓库会自带 `.github/workflows/ci-release.yml` 与 `.gitea/workflows/ci-release.yml`。按如下方式启用无头 PR 中文风险摘要：

1. 在 GitHub 或 Gitea 仓库的 **Settings → Secrets** 中新增：
   - `TOKENHUB_API_KEY`（必填）：腾讯 TokenHub API Key。
   - `TOKENHUB_BASE_URL`（可选）：默认为 `https://api.tokenhub.tencent.com/v1`。
   - `GITEA_TOKEN`（仅 Gitea 需要时配置）：用于向 PR 评论区回写中文风险摘要。
2. 在 **Settings → Variables** 中可选配置：
   - `TOKENHUB_REVIEW_MODEL`：默认 `DeepSeek-V4.1-Flash-1017`，也可切换为 `Hy4 flash`。
3. 未配置 `TOKENHUB_API_KEY` 时，CI 会自动跳过摘要步骤并正常执行 lint / typecheck / test，不会阻断流水线。

---

## 七、 同步上游 `vankhangfet/orca-sdlc-kit` 更新

本仓库已保留原仓库为 `upstream` remote，同步步骤如下：

```bash
# 1. 拉取上游最新提交
git fetch upstream

# 2. 查看上游变更
git log HEAD..upstream/main --oneline

# 3. 合并上游更新
git merge upstream/main

# 4. 如 flow.config.json 或 README.md 出现冲突，保留我方定制版本即可：
#    git checkout --ours .orca/flow.config.json README.md
#    git add .orca/flow.config.json README.md && git commit
```
