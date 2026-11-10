# 聊天键盘操作与元信息可读性修正（2026-11-09）

本记录对应 2026-11-09 前端评审中**已复核并确认**的交互、一致性与可读性问题。评审报告在本机文档库
`docs/weq/local/audits/20261109/frontend-review-2026-11-09.md`（不随源码仓库提交）。

## 范围

沿用现有视觉身份与主题 token，未新增 UI 框架、未改时间显示策略（保留 5 分钟时间分隔规则），
未做 Provider / 状态结构重构。只处理以下确认项：

1. **消息键盘操作**：聊天区容器可聚焦；`↑` / `↓` 在消息行之间移动焦点，`Home` / `End` 跳到首尾，
   `Enter` / `Shift+F10` / 菜单键打开当前消息的操作菜单，`Esc` 回到聊天区。消息行本身 `tabIndex=-1`，
   不增加大量 Tab 站点；焦点移动到未挂载的虚拟列表行时先滚动、再等挂载后聚焦。
2. **消息菜单键盘**：菜单打开后聚焦第一个可用项，支持 `↑` / `↓` / `Home` / `End`，`Tab` / `Esc`
   关闭并把焦点还给打开菜单的消息行。复用原有右键菜单的定位、锚点跟踪和状态，不另写一份菜单。
3. **可见焦点**：主输入框（`.composer-editor`）和默认皮肤（非 QQ NT）的侧栏搜索框在键盘操作时显示
   2px 强调色焦点提示。用 `data-weq-input-modality` 记录最近一次输入方式，只在键盘（Tab）操作后
   点亮，鼠标点选 / 打开会话自动聚焦的外观与原来一致；QQ NT 预设原有的 `focus-within` 边框保持不变。
4. **表单与状态语义**：侧栏搜索框补 `aria-label`；移动端展开输入框补 `aria-label`；首次加载消息时
   给读屏一个 `role="status"` 的“正在加载消息”（视觉骨架仍是原来的 `aria-hidden`）。
5. **元信息可读性**（前后实测值，浅色白色画布 / 深色 `#222222` 画布）：
    - 群聊发送者昵称、消息时间分隔：QQ NT 浅色 4.35:1 → 5.27:1，深色 6.31:1 → 7.59:1；
      默认皮肤（classic）时间分隔由写死 `#a8a8a8` 改为 `--weq-fg-secondary`；
    - 会话列表 QQ NT 时间 / 预览色：选中行浅色 2.57 / 3.63:1 → 4.53 / 5.11:1，深色
      2.53 / 2.75:1 → 4.58 / 5.01:1；classic 皮肤时间 10px → 11px、预览 11.5px → 12px，
      与默认 QQ NT 预设尺寸一致；
    - 时间分隔条的白色底改为由 `--weq-bg-surface` 派生的半透明底，不再写死 `rgba(255,255,255,…)`。
6. **显示一致性**：新增 `lib/format.ts`，统一 `formatBytes`（B 取整、≥100 取整、其余 1 位小数、
   数字与单位一个空格）。闪传、设置缓存、群文件、修复记录、助手产物、文件灰条、在线文件等
   7 处重复实现改为共用；`groupFile.formatSize` 保留导出但委托给同一实现。
7. **性能**：`conversationTime` 的“今天 HH:mm”格式器提升为模块级常量，避免会话列表每行新建
   `Intl.DateTimeFormat`。与修复前实现对比（40,000 次调用）：5,957ms → 71.5ms。

## 改动文件

- `apps/desktop/src/renderer/src/im-template/template/chatPane.tsx`
- `apps/desktop/src/renderer/src/im-template/template/messageBubble.tsx`
- `apps/desktop/src/renderer/src/im-template/template/messageRow.tsx`
- `apps/desktop/src/renderer/src/im-template/template/messageContextMenu.tsx`
- `apps/desktop/src/renderer/src/im-template/template/messageTime.tsx`
- `apps/desktop/src/renderer/src/im-template/template/sidebarHeader.tsx`
- `apps/desktop/src/renderer/src/im-template/template/flashComposer.tsx`
- `apps/desktop/src/renderer/src/im-template/styles/chat.css`
- `apps/desktop/src/renderer/src/lib/{format,messageKeyboardNav,inputModality,conversationTime,groupFile}.ts`
- `apps/desktop/src/renderer/src/styles/{form-focus,qqnt-appearance,conversation-list-row}.css`
- `apps/desktop/src/renderer/src/components/{QqFlashTransfer,QqMedia,FlashTransferViewer,GrayTipFileRecvMessage,DbRepairPanel}.tsx`、
  `components/settings/GlobalSettingsSection.tsx`、`views/bootstrap/StatsPanel.tsx`、`views/agentlab/AssistantArtifactCard.tsx`
- 单测：`apps/desktop/test/{message_keyboard_nav,format_bytes}.test.ts`

## 验证

- `pnpm --filter @weq/desktop typecheck:web` 通过；`pnpm lint`（含 `--error-on-warnings`）通过。
- 定向单测：`message_keyboard_nav`、`format_bytes`、`conversation_timestamps` 共 14 项通过。
- 浏览器（headless Edge，真实 ChatPane、合成数据、断网）：
    - 键盘链路：容器聚焦 → `↓` 落到 `row-1001` → `↓/↑` 在相邻行移动 → `Enter` 打开菜单且焦点在首项 →
      `↓` 落到第二项 → `Esc` 关闭并把焦点还给消息行 → `End` 跳到 `row-1060`；无页面异常；
    - 深浅主题 × QQ NT / 经典 / 简约 / 复古四套皮肤：`run-qqnt-appearance.mjs` 122 组用例通过；
    - 焦点样式：键盘操作后主输入框出现 2px 强调色焦点环，鼠标点击与自动聚焦不显示；经典皮肤搜索框
      键盘聚焦出现 2px 光环，QQ NT 保留原有边框反馈。
- 截图对比（浅 / 深、1280 / 390、群聊与会话列表）确认：字号、颜色变化只影响元信息，不影响布局、
  气泡宽度与聊天画布；QQ NT 预设的整体视觉身份不变。

## 已知未处理（继续保持现状）

- 时间分隔仍为 5 分钟间隔，本次只修可读性，不改展示策略。
- 搜索输入触发的整树重渲染、`ChatPane` 巨型组件拆分、消息分组节奏与悬停快捷操作属于结构/产品改动，
  不在本次批次内。
- `run-timeline.mjs` 在“复制所选消息”断言处失败；把本轮改动的四个组件文件恢复到基线后仍在同一位置
  失败，确认与本次修改无关，未修改该断言。
