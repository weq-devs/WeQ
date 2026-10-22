# 开发者入口

面向想参与 WeQ 开发的贡献者。

## 快速开始

```bash
pnpm i
pnpm native:fetch   # 取 nt_helper 原生产物（不入库，新克隆里没有）
pnpm dev
```

仅使用根 `package.json` 的 `packageManager` 所锁定的 pnpm；环境与门禁按[贡献指南](../../CONTRIBUTING.md)。以下按主题查阅，不必先读全部专题。

## 章节

### 内容与工具

- [界面与工具设计约定](./ux-discussion-20261017.md)：内容优先、选择草稿、任务身份和平台边界。
- [内容能力与缺口](./content-capability-census-20261018.md)：区分已接入父级与尚未覆盖的子内容。
- [选择、搜索与导出契约](./search-export-hardening-20261018.md)：精确范围、确认冻结、保存策略与请求隔离。
- [保存位置逻辑简化](./export-save-simplification-20261020.md)：单文件另存、结果保留及全局偏好／菜单改造的阶段边界。
- [联系人精确导出](./contacts-exact-export-20261018.md)：好友/群多选交接、精确 UID、完整目录与任务快照。
- [生成内容精确导出](./generated-content-export-20261018.md)：克隆与助手的持久身份、独立快照、原始结构及账号边界。
- [空间精确导出](./qzone-exact-export-20261018.md)：离散 tid、正文/互动/媒体范围、统一入口及历史隔离。
- [全局搜索新增来源](./content-search-sources-20261018.md)：来源覆盖、账号缓存、频道全库与稳定条目跳转。
- [全局搜索优化](./global-search-optimization-20261018.md)：默认个人范围、相关度排序与尚未实施的性能优化方向。
- [分析与报告](./analysis-report-20261018.md)：统计口径、历史身份、结果生命周期和恢复限制。
- [窗口与浮层](./nonmodal-surfaces-20261018.md)：页面、侧栏、浮窗、锚定窗格与模态层的职责。
- [页面现场保留](./tab-state-retention-20261015.md)：活动性、隐藏页监听与内存状态边界。
- [原生 QQ 邮箱](./qqmail-native-20261017.md)：账号级认证、邮件协议、附件、正文隔离与提醒生命周期。
- [会话分析时间轴 + 我的主场轮盘](./conversation-timeline-home-wheel-20261018.md) — 默认最近一年、拖动重算、全历史绿墙与群聊卡片轮盘的翻页守卫
- [引用、提及与 +1](./message-mentions-repeat-20261017.md)：唯一身份剪贴板、当前账号名称解析与相同消息重发
- [多选修饰键与键盘契约](./multi-selection-keyboard-20261017.md)：选择组、范围锚点、键盘隔离与业务限制。
- [合成工作区与归档](./compose-workspace-20261017.md)：编辑记录、素材快照、独立媒体与账号绑定。
- [SSO 历史路径统一](./unified-sso-history-20261017.md) — 单窗读取、物理请求计数、旧任务及缓存兼容
- [批量漫游补缺](./batch-roaming-backfill-20261016.md)：候选覆盖、持久预约与恢复。
- [漫游时间线](./roaming-timeline-and-seq-20261016.md)：缓存混排与本地消息身份。

### QQ 空间

- [读取边界](./qzone-reader-enhancements-20261015.md)、[Web 接口参考](./qzone-web-api-reference-20261015.md)、[未接入项](./qzone-todo.md)
- [媒体网格](./qzone-media-grid-20261015.md)、[预览](./qzone-media-preview-20261015.md)、[Live Photo 分类证据](./qzone-live-photo-investigation-20261015.md)
- [分页限流](./qzone-pagination-rate-limit.md)、[统计口径](./qzone-statistics-20261015.md)、[分享卡片](./qzone-share-cards-20261015.md)、[回复接收者](./qzone-reply-presentation-20261015.md)

### 基础能力与贡献

- [QQ 数据库布局：按文件设置保留页](./db-layout-split-20261018.md) — per-Pager pending byte、锁字节与布局自动识别
- [nt_helper.node 接口文档](./nt-helper-interface.md) — 原生模块能力总览，**写代码前先看，别重复造轮子**
- [原生二进制与装扮资源的分发](./native-artifacts.md) — `pnpm native:fetch`、发布链路、历史清洗记录
- [测试约定](./testing.md) — `@weq/testkit`
- [macOS QQ 进程探测](./macos-startup-probe-20261015.md)：异步归属判断与子进程生命周期。
- [Linux 窗口后端与 XWayland](./linux-ozone-xwayland-20261019.md)：为什么 `ozone-platform` 必须走 Electron 启动参数，不能 `appendSwitch`。
- [图文 Ark 卡片发送](./ark-send.md) — OIDB 0xdc2_34 的下发结果解析，以及 PC/Linux 端的已知实现缺口
- [推荐联系人 / 推荐群卡片](./contact-ark.md) — 0x12b6_0 / 0x8b7_5 取卡 + PbSendMsg 直接发送（两步合一）
- [AI 声聊](./ai-voice.md) — 声线目录（OIDB 0x929d_0：分组 / 中文名 / 样音）与语音合成（0x929b_0），样音不入库
- [群报名 / 群收集表](./group-signup.md) — OIDB 0x921b_0 的字段布局、图片直链处理与已知缺口
- [发消息](./send-message.md) — `MessageSvc.PbSendMsg` + 富媒体上传（NTV2/highway）+ 文件（群/私聊，老 OIDB + highway）、元素类型表、MCP 工具与已知缺口
- [本地文字识别模型](./ocr-models.md)：模型选型背景；当前识别与筛图配置见[设置](../guide/settings.md#模型与识别)。
- [图片识别缓存原设计](./ocr-cache-plan-20261016.md)：历史方案，缓存已接入；当前实现查 `packages/service/src/common/ocr_cache.ts` 及 `account/ocr_image.ts`，不按旧“待实施”措辞重复开发。
- [词云 / 常用语的中文分词](./jieba-word-segmentation-20261017.md) — 接入 QQ 自带结巴词典与随包词典兜底，按词性过滤实词
- [主动操作类协议能力](./protocol-actions-20261019.md) — 群管理 / 群文件 / 群相册 / 群待办 / 收藏表情 / 请求处理 / 在线状态的命令、分层与签名判定
- [主动操作界面接入](./qq-actions-ui-20261019.md) — 原始候选与新增协议的入口、账号隔离、结果边界、通用加群及针对性验证。
- [QQ 交互修复记录](./qq-actions-fixes-20261020.md) — 免打扰未知态、画像雷达与在线状态 EOF 的字段证据和验证边界。
- [群文件管理器](./group-file-manager-20261021.md) — 统一列表、来源绑定、拖拽、冲突检查与批次结果的实现边界。
- [页面自动更新](./qq-actions-auto-refresh-20261021.md) — 前台恢复、隐藏停轮询、读取重试与草稿保护。
- [群成员编辑入口](./qq-member-edit-permissions-20261021.md) — 角色与目标身份、直接编辑及窗口边界。
- [失败发送占位移除](./failed-outgoing-20261021.md) — 本机清理、确认状态保护、迟到回调与序号定位。
- [消息正确性与邮件导出修补](./qq-message-correctness-20261021.md)：合成时间、逐条间隔、图文重编辑、设备未读、连续消息与图片资源生命周期。
- [QQ 交互当前版本收尾](./qq-actions-followups-20261022.md)：表情包、资料卡、独立修复窗、频道多选、自发缓存与混合消息操作的实现和验证边界。
- [模型温度参数回退](./temperature-fallback-20261022.md)：明确拒绝识别、JSON／SSE 重试边界、取消与物理用量记账。
- [备份与恢复](./settings-backup-20261022.md)：版本化格式、真实配置校验、冷启动事务、设置入口与按设备交接界面偏好。
- [贡献指南](../../CONTRIBUTING.md)

---

[← 返回文档中心](../README.md)
