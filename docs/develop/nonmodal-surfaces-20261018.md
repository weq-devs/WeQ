# 窗口与浮层

## 当前归位

| 容器 | 用途 |
| --- | --- |
| 主内容整页 | 设置、个性装扮；不额外创建结果标签 |
| 内容页与结果标签 | 收藏、邮件、报告等；各自保留浏览现场 |
| 会话右侧 | 群文件、群相册、群公告、群精华、成员与会话资料；关闭后恢复原群资料栏 |
| `floating` | 聊天记录搜索、更多搜索结果、撤回/删除/缺口查看、本地消息编辑、漫游配置和闪传浏览；可拖动与缩放 |
| `anchored` | 全局任务和闪传任务；靠近入口展示，不遮罩聊天 |
| `modal` | 分析/导出配置、WeQ 助手、高风险确认、认证、支付和媒体灯箱等需要聚焦的流程 |
| `popover` | 日历、资料卡等就地轻量内容 |

具体调用以 `presentation` 为准；历史上的“任务必须居中/必须遮罩”方案不是当前契约。居中位置与是否模态是两个独立属性。

设置的 QQ 账号、逆向、数据库管理和资源目录管理直接复用正文内容；资源概览、清理选择/确认/结果与浏览在同一页内切换，不再叠加三个完整工具窗口。数据库导出、密钥扫描、撤回/容错记录等保留聚焦操作复用 `ToolSurface` 的 `modal`，不替换设置工作区；其他调用来源仍可使用原页面容器。背景通过按所有权恢复的 `inert` 隔离，关闭只处理顶层工具，草稿使用现有确认，换源重建私有现场。日志查看器保持页内；数据库修复与 QQNT 抓包使用独立系统窗口。完整验收仍见[设置重构方案](./settings-restructure-plan-20261025.md)。

## 生命周期与焦点

- `Modal` / `OverlayLayer` 默认仍为模态，调用方显式选择非模态展示；透明遮罩不能冒充非模态。
- `WorkspacePages` 和 `RetainedTabs` 保留内容树；隐藏页通过 `TabActivity` 隔离后代浮层、键盘和尺寸监听。普通导航保留的报告须显式关闭才移除。
- 非模态外壳不拦截背景输入、不锁全局焦点、不声明 `aria-modal`。Escape 只处理焦点所在的有效层，背景按键不误关浮窗。
- 堆叠顺序按祖先层级比较，子节点的极大 z-index 不能越过父窗口。快捷键只属于当前聚焦的内容或对话框。
- `WindowSurface` 负责应用内拖动、缩放、视口约束、前置与锚点跟随，不创建系统窗口；合成工作窗是独立的专用窗口。

## 源码与回归

- 容器：`components/Dialog.tsx`、`OverlayLayer.tsx`、`WindowSurface.tsx`、`WorkspacePages.tsx`、`WorkspaceTools.tsx`。
- 活动性与层级：`components/RetainedTabs.tsx`、`lib/overlayStack.ts`、`lib/surfaceEscape.ts`。
- 测试：`workspace_surfaces.test.ts`、`workspace_controls.test.ts`、`overlay_stack.test.ts`、`multi_selection_keyboard.test.ts`。

容器改动需检查背景可操作、隐藏页不抢键、关闭重开保留现场及窄屏边界。历史测试数量或截图不能代替当前版本验收。
