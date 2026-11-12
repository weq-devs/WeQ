# 统一联系人名片与资料页

## 配置与入口

`AppSettings.contactCard` 由 `@weq/service/contact-card` 定义默认值、可选字段及顺序归一化。只保存内容可见性、正文顺序和群内可选内容顺序，不保存操作能力开关。未知、重复及已移除字段不会重新进入设置；局部设置补丁保留其他已选内容。

配置通过 `bootstrap.getSettings/setContactCard` 读写，复用全局配置备份、设置更新通知、设置搜索和恢复默认。设置页不查询真实账号资料；设置页的「预览」读取 `account.getSelfProfile` 用**同一个名片组件**渲染本人名片，读不到时给骨架，禁止任何虚构示例联系人。能量等级不属于展示字段，能量值保持独立。

`MemberProfileCard` 负责浮层定位与生命周期，`ContactProfileSurface` 负责内嵌资料页；身份、正文、群上下文及操作使用 `contactProfile` 下的共用组件。普通联系人浮层复用成员名片，不再并行维护一套正文。

### 行模型与容器（唯一实现）

- `components/contactProfile/ContactRow.tsx`：**唯一**的数据行组件（`ContactRow`）、分区小标题（`ContactSection`）、技术详情折叠（`ContactTechnicalDetails`）、局部失败（`ContactInlineError`）、空态（`ContactEmptyState`）。label 固定 96px、值 13px 左对齐可换行、空值整行不渲染；旧组件的 `.weq-profile-row` 通过 `profile-workspace.css` 的容器归一化跟随同一网格，不再各自排版。
- 名片壳与资料页壳共用身份区 `ContactIdentity`、操作区 `ContactActions`、页头 `ProfilePageHeader`（工具栏标题 + 右上关闭 + 身份/操作，文档流内、不覆盖章节标题；`actions` 可省略）。联系人资料页使用 `layout="split"` 和 `ContactIdentity.cardBody`：左侧沿用名片分行身份正文及显示设置，右侧承载操作，窄屏操作纵向排列；群资料页保留默认布局。
- `ProfileWorkspace` 负责目录与章节：宽屏 `weq-profile-directory` 竖目录，窄屏折叠为 `weq-profile-directory-tabs` 横向章节条（不用原生 select）；章节标题统一由它输出 17px h2，内嵌组件的 h1–h4 在宿主侧归一为 13px。
- 样式归属：目录、工作区、行模型、共用技术详情组件只在 `styles/profile-workspace.css`；`styles/contact-card.css` 只保留名片壳、身份区、操作区、群上下文与设置页专属部分。当前状态复用聊天顶栏的 `OnlineStatus`；QQ、QID、UID、签名使用分行身份正文，沿用名片开关，四页正文不重复。联系人资料页不再挂载技术详情组件。
- `ProfileInlineField` 共用群昵称、头衔、备注及分组的原行表单；`QQProfileField` 延迟挂载备注／分组／群名的在线状态读取，复用 `qqWrite` 与账号绑定。备注、群名和分组写入需读回确认才退出表单，失败保留草稿；分组使用下拉控件，群名称仅对群主／管理员提供，标题的资料导航行为不变。保存后刷新名片名称与群详情的独立查询缓存，不写入会话名称投影。

## 数据与加载

- 本地输入立即渲染；补充资料使用包含账号配置和目标身份的共享查询键。只读挂载使用 `useQQWriteSession` 的被动模式，不额外创建周期性能力轮询；编辑和互动继续使用实时读写会话。
- 本地资料、云端名片名称、QQ 秀和装扮复用前端缓存及在途请求。资料读取支持可选的 `expectedAccountUin/expectedAccountConfigId`，保留旧调用兼容；服务端校验来源并拒绝切换后的迟到结果。名称投影不修改会话名称缓存。
- `peerStats.fields` 可选择 `level/likeCount`，省略时仍读取两项；服务层分别调用已有指标缓存，单项失败不清空另一项成功结果。只显示等级时不发送获赞读取。
- 标签目录、详细资料等根据启用内容挂载；同一接口被多个字段使用时复用查询结果。成功空目录与请求失败区分，零照片标签保留，照片续页只在进入相册后读取。
- `ProfileExtrasContent` 和 `ProfileDetailsContent` 支持页内承接，`ProfileExtraDialog` 复用相同内容与查询。原有签名、问答、照片互动不另建协议或写入通道。
- 私聊存在性优先使用完整目录和隐藏、历史及临时会话状态；必要时只读取会话边界。本群发言复用 `browseConversation` 的发送者过滤和游标分页。空间预览按点击延迟加载，复用空间读取和媒体网格，不预取评论或续页。

资料页章节采用已有共享目录容器，保留同一对象的章节、分页和滚动位置。`lib/contactWorkspace.ts` 定义四个内容页及旧导航映射：`details/signatures/history/edit` 归入 `profile`，`portrait` 归入 `marks`，`questions` 归入 `personality`。旧签名章节只定位个人资料，不恢复已移除的独立签名历史入口；历史通过身份区签名正文打开。其他旧直达入口展开所属内容。本人编辑及对外展示设置与名片偏好分开。

`ProfileDisclosure` 首次展开后才挂载内容，收起保留现场并通过 `TabActivity` 暂停读取。资料历史按四页归属筛选服务端返回的类别，再按类别分页查询，不使用过滤当前页结果的方式；没有适用类别时不发无类别的全量历史查询。UID 仅在开启该字段时进入身份区。`styles/contact-workspace.css` 承担联系人资料页专属样式，不修改群资料页的布局。

`ContactGroupWorkspace` 通过绑定账号和数据源的 `listUserGroups` 分页读取本地成员记录，合并来源群，不遍历所有群成员；群名优先使用当前群资料、来源群和已有会话目录，缺失时显示群号。切群重新构造 `profileContext`，不改联系人及当前会话；成员行与本群发言、聊天分析共用该上下文。选择记忆按账号、数据源和 UID 隔离，内存有界；来源群优先于记忆。`listUserGroups` 保留旧调用，同时使用已有 `scopedGroupRead` 拒绝跨账号、跨数据源及迟到响应。

## 定向验证

服务测试覆盖字段默认、归一化、排序、持久化、备份恢复及等级与获赞的实际读取选择；渲染测试覆盖名片浮层、头像补全、来源隔离、备注及群资料编辑和既有互动能力。

浏览器回归入口为 `apps/desktop/test/browser/run-contact-card.mjs`。通过 `WEQ_PLAYWRIGHT_IMPORT`、`WEQ_BROWSER_EXECUTABLE` 复用已有浏览器；`WEQ_CONTACT_CARD_QA` 指定截图和查询记录目录。脚本使用合成资料，禁止外网请求，退出时关闭自身浏览器和 Vite 服务。`WEQ_CONTACT_CARD_BASELINE=1` 可加载重构前的名片组件作同夹具对照。

浏览器记录用于核对真实首帧、冷开与缓存复用、可选查询及响应式布局，不等同于真实 QQ 网络耗时或长期性能验收。

四页资料工作区回归入口为 `apps/desktop/test/browser/run-contact-workspace.mjs`，沿用相同浏览器环境变量，以 `WEQ_CONTACT_WORKSPACE_QA` 指定截图和检查记录目录；覆盖四页导航、历史按需与分类读取、切群及所选群发言、三种宽度与深浅主题。模型与页内展开测试为 `contact_workspace_model.test.ts`、`contact_workspace_sections.test.ts`，账号绑定路由测试在 `group_profile_router.test.ts`。

原行编辑定向测试为 `profile_inline_field.test.ts` 与 `group_member_inline_edit.test.ts`；浏览器入口 `apps/desktop/test/browser/run-profile-inline.mjs` 使用同一运行时环境变量，以 `WEQ_PROFILE_INLINE_QA` 指定截图目录，覆盖备注保存／清空／取消、分组、群名称、失败草稿及深浅主题窄屏布局，所有写入均为合成桩。
