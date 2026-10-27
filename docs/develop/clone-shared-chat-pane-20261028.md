# 克隆会话复用普通聊天页面（2026-10-28）

## 页面边界

克隆私聊和群聊直接渲染 `im-template/template/chatPane.tsx`，不再维护独立输入框、消息时间线、滚动、多选、右键菜单或聊天页样式。

`CloneChatPanel` / `GroupChatPanel` 只保留原有克隆查询、会话 CRUD、生成与流式订阅，以及设置数据的适配。`cloneChatAdapter.ts` 把持久记录投影为普通 `Conversation` / `Message` / `User`；生成内容的表情和合成语音通过消息渲染器适配，不重建气泡和消息操作。

## 身份与能力

- `Conversation.generated` 保存原始 `{ kind, ownerId, sessionId }`；页面 ID 使用 `virtual:` 域，草稿首次保存后页面 ID 不变，存储身份切到真实会话。
- 消息使用持久消息 ID，不伪造 QQ 序号。尚未获得持久身份的生成片段标记 `generatedPending`，只显示，不纳入多选或导出。
- 共用输入框的系统表情和成员提及通过现有 token 解析器转换为克隆文本接口；未支持的媒体元素不会降级成一条看似成功的发送。
- 导出按 `clone-messages` 与结构化容器身份交接。分析、漫游等原生目标解析同时检查来源元数据，不能仅依赖 ID 前缀避免误发。
- 未适配能力保留普通页面入口、置灰并说明原因；不为这些入口编造成功回调，也不在此改造里新增 QQ 或模型能力。

## 搜索与设置

克隆记录搜索复用 `ChatRecordsModal`，通过 `localSource` 提供已加载的持久消息及定位回调，不把克隆 ID 传给原生消息检索、日历或导出接口。筛选导出仍交给原有生成内容导出流程。

普通会话、克隆体与克隆群聊共同使用 `ConversationSettingsFrame`：相同的原位窗口、分类导航和内容区。克隆体沿用原有配置表单及未保存保护，群聊设置保留成员管理、清空和删除。

## 浮层

`SessionSwitcher` 使用 `OverlayLayer` 的 Portal、锚点定位、层级分配和关闭机制。菜单不再留在聊天标题栏的层叠上下文内，避免被消息气泡、头像挂件或滚动区域覆盖。共用输入区的提及菜单也修正了小屏裁切。

## 验证入口

- `clone_conversation_ui.test.ts`：共用页面、能力置灰、文本适配、持久身份和来源隔离。
- `generated_search_ui.test.ts` / `generated_selection_toolbar.test.ts`：定位、只读旧记录、多选缓存及精确导出。
- `persona_settings.test.ts` / `conversation_settings_ui.test.ts` / `session_switcher_layer.test.ts`：共享设置外壳、原有配置动作和菜单 Portal。
- `test/browser/run-clone-conversation.mjs`：合成数据下的深浅主题、主题色、窄屏、实际命中层级、设置导航、输入及发送适配；阻断外网，不连接真实 QQ 或模型。

此文描述源码边界与验证入口，不代表已打包、安装或发布。
