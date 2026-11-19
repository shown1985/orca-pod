# orca-pod — 定制版三轨编排脚手架说明

本仓库基于开源项目 [`vankhangfet/orca-sdlc-kit`](https://github.com/vankhangfet/orca-sdlc-kit) 定制构建。核心编排引擎 `.orca/flow.mjs` 与 `.orca/agent-config.mjs` 保持上游原版零魔改，所有定制均收口在三轨配置模板、Prompts、工程/设计规范文件、CI 模板与 `bin/init.mjs` 安装器中，确保日后可平滑同步上游更新。

---

## 一、 安装到任意业务仓库

### 1. 本地路径一键安装（推荐本机开发）

在目标业务仓库根目录执行：

```bash
npx /Users/shawn/agents-dev-kit/orca-pod
```

### 2. 从 GitHub / 私有 Gitea 仓库一键安装

推送到你的仓库后，可在任意机器执行：

```bash
# GitHub（公开或已配置 SSH 密钥的私有库）
npx github:shown1985/orca-pod
# 或显式 SSH 方式
npx git+ssh://git@github.com/shown1985/orca-pod.git

# Gitea 私有库
npx git+ssh://git@<你的-gitea-域名>/shown1985/orca-pod.git
```

### 3. 安全不覆盖与强制更新机制

- **默认安全模式**：已存在的自定义文件（如 `AGENTS.md`、`DESIGN.md`、`.worktreeinclude`、`.orca/flow.config.json`、`ci-release.yml`）**不会被覆盖**，安装脚本会保留你的本地版本并输出 `diff -u` 合并提示命令。
- **强制覆盖模式**（仅在确认需要用脚手架模板整体覆盖时使用）：
  ```bash
  npx /Users/shawn/agents-dev-kit/orca-pod --force
  ```

---

## 二、 三轨工作流（3-Track Workflow）切换方式

安装完成后，默认 `.orca/flow.config.json` 指向 **Track 1（标准通道 `flow-feature.json`）**。通过 `--config` 参数即可按任务规模秒切轨道：

| 轨道 | 触发场景 | 干跑预览命令（`--dry-run`） | 正式执行命令 |
|---|---|---|---|
| **Track 0（极速通道）** | `#hotfix` / 微调（≤3 文件、无契约变更、Red→Green 测试先行） | `node .orca/flow.mjs --config flow-hotfix.json --dry-run "#hotfix ..."` | `node .orca/flow.mjs --config flow-hotfix.json "#hotfix ..."` |
| **Track 1（标准通道，默认）** | `#feat` / 单个明确 Feature 或常规 Bug | `node .orca/flow.mjs --dry-run "#feat ..."` | `node .orca/flow.mjs "#feat ..."` |
| **Track 2（完整编排通道）** | `#epic` / 0→1 新模块 / 跨端重构（契约 Commit + 无状态并发 + 串行集成 + Orca Decision Gate） | `node .orca/flow.mjs --config flow-epic.json --dry-run "#epic ..."` | `node .orca/flow.mjs --config flow-epic.json "#epic ..."` |

> 如希望某业务仓库默认轨道为 Track 2，直接执行 `cp .orca/flow-epic.json .orca/flow.config.json` 即可。

### 个人模型池与推理强度避坑速查

- **0→1 架构与契约**：`Gemini 4 Carbon` (**High**) — 禁止开 Low。
- **协调 / PO / Visual Gate**：`Gemini 4 Neon` (**Medium**) — 禁止对 Carbon/Neon 开 Low。
- **主力并发 Worker (70%)**：`DeepSeek-V4.1-Flash-1017` (**High**，疑难 Bug 可切 Max)。
- **复杂终端排错 / 深度重构 (30%)**：`Kimi K3.1 Pro` / `Kimi K2.7 Code` 或 `GLM-5.3`（**手动降为 Low / High，严禁放任 GLM-5.3 走默认 Max 卡死并发队列**）。
- **单测 / Lint / 文档 / PR 摘要**：`DeepSeek-V4.1-Flash-1017` 或 `Hy4 flash` / `Gemini 4 Hydrogen` (**Low / Medium**)。
- **跨家族资深 Reviewer**：`GPT-6.2 Sol`（常规 **High**，Track 2 核心安全与并发终审 **Xhigh**；**绝对不要开 Max**）。
- **无头 CI 自动审 PR**：使用 **腾讯 TokenHub API**（在 GitHub/Gitea Secrets 中配置 `TOKENHUB_API_KEY`，可选 `TOKENHUB_BASE_URL` 与变量 `TOKENHUB_REVIEW_MODEL`，默认 `DeepSeek-V4.1-Flash-1017`），严禁在远端 CI Runner 中使用个人订阅账号。

---

## 三、 同步上游 `vankhangfet/orca-sdlc-kit` 更新

原仓库已重命名为 `upstream` remote。由于未修改 `.orca/flow.mjs` 与 `.orca/agent-config.mjs`，日后同步上游引擎更新只需：

```bash
# 1. 拉取上游最新提交
git fetch upstream

# 2. 查看上游变更（确认无破坏性 Schema 变更）
git log HEAD..upstream/main --oneline

# 3. 合并上游更新到当前主分支
git merge upstream/main

# 4. 如 flow.config.json 出现冲突，保留我方三轨定制版本即可：
#    git checkout --ours .orca/flow.config.json
#    git add .orca/flow.config.json && git commit
```
