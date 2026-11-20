# AGENTS.md — 工程编排与多 Agent 协作规范

本文件定义了本仓库在 Orca ADE / 多 Agent 协同开发中的强制工程纪律、三轨分诊规则、模型路由策略与质量门禁。所有参与本仓库开发的 AI Agent（Gemini CLI、OpenCode、Codex CLI、Claude Code 等）在动手前必须完整阅读并严格遵守。

---

## 1. 三轨工作流分诊规则（3-Track Workflow）

开始任何任务前，先根据改动范围与标签（`#hotfix` / `#feat` / `#epic`）分诊到对应轨道，严禁“小改动走重流水线”或“大重构跳过契约”：

| 轨道 | 触发标签 | 适用场景 | 对应配置 | 关键流程 |
|---|---|---|---|---|
| **Track 0（极速通道）** | `#hotfix` | 线上紧急修复 / 微调（改动 ≤3 文件、无 API/DB/类型契约变更） | `.orca/flow-hotfix.json` | 跳过 PO/Backlog → **Red → Green 测试先行** → 极速 Diff 审计 → 单测绿灯 → 提 PR 触发 CI |
| **Track 1（标准通道，默认）** | `#feat` | 单个明确 Feature / 常规 Bug 修复 | `.orca/flow-feature.json`（默认 `flow.config.json`） | ≤10 行微型 Plan → 单 Worktree 编码+单测 →（涉 UI 走 Visual Gate）→ 跨家族审查 → 提 PR |
| **Track 2（完整编排通道）** | `#epic` | Epic / 0→1 新模块 / 跨端重构 / 多契约变更 | `.orca/flow-epic.json` | PO 拆解 Backlog & DAG → **契约 Commit 先行** → 无状态并发 Worktree → 有状态串行集成测试 → Visual Gate → 终审 → 提 PR + **Orca Decision Gate** 人工确认合并 |

---

## 2. 核心工程红线（不可违背）

1. **严禁直推或自动合并到 `main` / `master`**：
   - 所有开发必须在独立 Git Worktree 和特性分支（如 `hotfix/<slug>`、`feat/<slug>`、`epic/<slug>`）中进行。
   - 任何自动化流水线终点只能停在“推送分支 + 创建/更新 PR + 触发 CI”，**绝不自动 Merge 到 `main`**；Track 2 必须通过 **Orca Decision Gate** 等待人工确认合并与发布。
2. **Hotfix 测试先行（Red → Green）**：
   - Track 0 修复 Bug 前，必须先编写一条可复现该问题的失败回归测试（Red），再以最小改动让测试转绿（Green），禁止“先猜着改代码、不补回归测试”。
3. **Track 2 契约 Commit 先行**：
   - 派生并发 Worker 之前，架构师必须先提交包含 **API Schema（OpenAPI / RPC）/ TypeScript 共享类型 / 数据库迁移脚本 / `DESIGN.md`** 的独立 **契约 Commit**。
   - 并发 Worker 严格基于已冻结的契约并行开发，禁止在并发分支中私自修改共享契约。
4. **无状态并发 + 有状态串行**：
   - 并发 Worktree 内**仅允许运行无状态校验**：`lint`、`typecheck`、`unit-test`（严禁在并发 Worktree 中抢占同一数据库实例或固定端口）。
   - 完整服务启动、数据库 Migration 执行、端到端集成测试，统一在合并至本地集成分支后的**单一串行节点**执行。
5. **2 轮熔断上限（Max Retry = 2）**：
   - 跨模型 Code Review / Security Audit / Visual Gate 打回修复的上限锁死为 **2 轮（`maxRetries: 2`）**。
   - 连续 2 轮未通过时立即熔断挂起，保留现场与审计报告，交由人工介入，严禁无限死循环烧额度。
6. **跨家族写审分离（Cross-Family Review）**：
   - 编写代码的主力模型与负责代码/安全审查的 Reviewer 必须属于不同模型家族（例如 OpenCode/DeepSeek 或 Kimi/GLM 编写，Codex/GPT-6.2 Sol 审查），避免同源盲区。

---

## 3. 参考模型池与推理强度（Reasoning Effort）路由建议

> **默认不锁死模型**：本脚手架所有三轨配置文件均默认使用 `"model": "default"`（自动沿用你本机各 CLI 工具的默认模型），**你可以自由替换为任意闭源或开源模型**（如 Claude、GPT、Gemini、DeepSeek、Qwen、Kimi、GLM 或本地 Ollama/vLLM 模型）。下表仅作为经过实践验证的**参考推荐组合**与避坑备忘：

| 角色 / 场景 | 参考模型 | 建议推理强度 (Effort) | 常见通道 | 避坑与选型原则 |
|---|---|---|---|---|
| **0→1 架构与契约设计** | `Gemini 4 Carbon`（或同类旗舰推理模型） | **High** | Gemini CLI / Antigravity | 若使用 Carbon/Neon，**禁止开 Low** |
| **日常协调者 / PO 拆解 / 视觉验收** | `Gemini 4 Neon`（或同类多模态模型） | **Medium** | Gemini CLI / Antigravity | 若使用 Carbon/Neon，**禁止开 Low** |
| **主力并发开发 Worker（70%）** | `DeepSeek-V4.1-Flash-1017`（或高吞吐开源/闭源编码模型） | **High** | OpenCode Go / 本地 API | 疑难 Bug 可临时切 **Max** |
| **复杂终端排错 / 长会话深度重构（30%）** | `Kimi K3.1 Pro` / `Kimi K2.7 Code` 或 `GLM-5.3` | **Low 或 High**（手动指定） | OpenCode Go | Kimi 终端排错强；若用 GLM-5.3，**严禁放任默认 Max 卡死并发队列** |
| **单测 / Lint / 文档 / PR 摘要** | `DeepSeek-V4.1-Flash-1017` / `Hy4 flash` / `Gemini 4 Hydrogen` | **Low / Medium** | OpenCode / Gemini CLI | 轻量低成本任务，优先高性价比或开源小模型 |
| **资深 Reviewer（写审分离）** | `GPT-6.2 Sol`（或与编码模型不同家族的强模型） | 常规 **High** / 安全并发终审 **Xhigh** | Codex CLI / 其他跨家族 CLI | 若用 GPT-6.2 Sol，**绝对不要开 Max**（避免实测负优化与额度浪费） |
| **无头 CI/CD 自动审 PR 兜底** | `DeepSeek-V4.1-Flash-1017` / `Hy4 flash`（任意 OpenAI 兼容 API） | **Low / Medium** | 腾讯 TokenHub API 等无头端点 | **严禁在远端 CI Runner 中使用个人订阅账号** |

---

## 4. 前端 UI/UX 闭环纪律

任何涉及前端页面、组件或样式的改动，必须同步遵循根目录的 [`DESIGN.md`](./DESIGN.md)：

1. **设计流**：0→1 新建项目/大模块使用 **Google Stitch** 起稿并导出 `DESIGN.md`；日常增量迭代切回 **Open Design MCP (`nexu-io/open-design`) + 本地 `DESIGN.md`**。
2. **反 AI 塑料感红线**：保持克制留白、清晰字重与层级对比、微弱 `1px` 边界；禁止滥用紫蓝霓虹渐变与无意义装饰卡片。
3. **四态完整性**：每个数据视图与交互模块必须实现 `Default` / `Loading Skeleton` / `Empty` / `Error` 四态，且优先复用现有组件库。
4. **必经 Visual Gate**：前端提交审查前，需通过 Playwright 截取 **1440px 桌面端 + 390px 移动端** 截图，交由 `Gemini 4 Neon` (Medium) 对照 `DESIGN.md` 验收通过。

---

## 5. Worktree 环境与提交规范

- `.worktreeinclude` 定义了派生新 Worktree 时需自动同步的本地忽略文件（如 `.env`、`.env.local`）。
- 遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`feat:`、`fix:`、`refactor:`、`test:`、`chore:`、`docs:`；Track 2 的契约提交使用 `chore(contract): ...` 或 `feat(contract): ...`。
- `.orca/artifacts/` 为流水线运行期产物，已纳入 `.gitignore`，严禁提交到业务分支。
