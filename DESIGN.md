---
# DESIGN.md — Google Stitch 兼容 Design Tokens（YAML Frontmatter）
# 0→1 阶段由 Google Stitch 导出覆盖此区块；日常迭代通过 Open Design MCP (nexu-io/open-design) 增量维护。
design_system:
  name: "Project Design System"
  version: "0.1.0"
  source: "stitch-export / open-design-mcp"
  theme_mode: "light-first" # light-first | dark-first | adaptive

tokens:
  colors:
    bg_canvas: "#FAFAFA"
    bg_surface: "#FFFFFF"
    bg_subtle: "#F4F4F5"
    border_subtle: "#E4E4E7"      # 1px 微弱边界
    border_strong: "#D4D4D8"
    text_primary: "#18181B"
    text_secondary: "#52525B"
    text_muted: "#71717A"
    accent_primary: "#18181B"     # 克制主色（按项目品牌替换为单主色）
    accent_hover: "#27272A"
    status_success: "#16A34A"
    status_warning: "#D97706"
    status_error: "#DC2626"

  typography:
    font_sans: "Inter, -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif"
    font_mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
    scale:
      page_title: { size: "24px", line_height: "32px", weight: 600, tracking: "-0.02em" }
      section_title: { size: "16px", line_height: "24px", weight: 600, tracking: "-0.01em" }
      body: { size: "14px", line_height: "22px", weight: 400 }
      caption: { size: "12px", line_height: "18px", weight: 500 }

  spacing:
    unit: "4px"
    page_padding_desktop: "32px"
    page_padding_mobile: "16px"
    section_gap: "24px"
    card_padding: "16px"

  radius:
    sm: "6px"
    md: "8px"
    lg: "12px"

  breakpoints:
    mobile: "390px"
    tablet: "768px"
    desktop: "1440px"
---

# DESIGN.md — 前端 UI/UX 设计与视觉验收规范

## 1. 设计工具链与日常工作流

- **0→1 起稿阶段（Epic / 全新页面）**：使用 **Google Stitch** 生成初版视觉稿与 Design Tokens，直接导出更新本文件顶部的 YAML Tokens 与下方页面结构说明，并随 **契约 Commit** 冻结入库。
- **日常增量迭代（Feature / Hotfix）**：切回 **Open Design MCP (`nexu-io/open-design`) + 本地 `DESIGN.md`**，在现有 Token 与组件体系内增量修改，避免反复推翻重来。

---

## 2. 反 AI 塑料模板红线（Anti-AI-Slop Rules）

所有前端 Agent 在实现界面时必须严格遵守以下美学与布局底线：

1. **克制留白**：内容密度适中，页面与区块间保持明确呼吸感（优先使用 `spacing` Token），拒绝信息堆砌与无休止的边框嵌套。
2. **清晰字重与层级对比**：通过字号、字重（`600` vs `400`）与中性灰阶（`text_primary` / `text_secondary` / `text_muted`）建立视觉层级，而不是靠五颜六色的徽章和图标堆砌。
3. **微弱 1px 边界**：优先使用 `1px solid border_subtle` 分隔表面与层级，克制投影（Shadow 仅用于浮层 Popover / Modal / Dropdown）。
4. **严禁滥用紫蓝渐变与无意义装饰卡片**：禁止默认使用大面积紫/蓝/粉霓虹渐变背景、发光外框、空洞的 Hero 装饰卡、无业务含义的 KPI 假指标卡。
5. **组件复用优先**：改动前先检索仓库已有的 Design System / UI 原语（Button、Input、Table、Dialog、EmptyState 等），严禁为同一交互重复造轮子或写一次性内联样式。

---

## 3. 四态完整性要求（Four-State Completeness）

每个异步数据视图、列表、详情页与表单必须完整覆盖以下四种状态，缺一不可：

- **Default（正常态）**：真实数据结构下的主路径展示，支持长文本截断与合理换行。
- **Loading Skeleton（加载骨架态）**：与正常态布局几何一致的骨架屏，禁止全屏白屏或粗糙的居中文字 `"Loading..."`。
- **Empty（空态）**：明确说明当前无数据的原因，并提供单一、清晰的下一步操作入口（CTA）。
- **Error（错误态）**：展示人类可读的错误提示与可重试操作（Retry），禁止吞掉异常或裸露原始堆栈。

---

## 4. Visual Gate 视觉验收清单（必经关卡）

所有涉及 UI/UX 的 Track 1 / Track 2 改动，在进入资深 Code Review 前必须通过 **Visual Gate**：

1. **双端真实截图**：使用 Playwright 启动本地开发/预览服务，分别在以下两个视口下截取关键路径截图并保存到 `.orca/artifacts/screenshots/`：
   - 桌面端：`1440 × 900`（`1440px` 宽度）
   - 移动端：`390 × 844`（`390px` 宽度）
2. **多模态模型验收**：将截图与本 `DESIGN.md` 交由 **`Gemini 4 Neon` (Medium)** 逐项比对：
   - 颜色、字号、间距、圆角是否符合 YAML Tokens？
   - 是否存在横向溢出、元素重叠、文字截断异常或移动端布局塌陷？
   - 是否触犯反 AI 塑料感红线（紫蓝渐变、无意义装饰卡片、过度阴影）？
   - 四态（Default / Loading Skeleton / Empty / Error）是否完整且无报错？
3. **熔断规则**：验收不通过则打回前端 Worker 修复（最多 **2 轮**，超限挂起人工介入）。
