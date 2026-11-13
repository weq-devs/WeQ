# 统一联系人名片与资料页

## 配置与入口

`AppSettings.contactCard` 由 `@weq/service/contact-card` 定义默认值、可选字段及顺序归一化。只保存内容可见性、正文顺序和群内可选内容顺序，不保存操作能力开关。未知、重复及已移除字段不会重新进入设置；局部设置补丁保留其他已选内容。

配置通过 `bootstrap.getSettings/setContactCard` 读写，复用全局配置备份、设置更新通知、设置搜索和恢复默认。设置页不查询真实账号资料；设置页的「预览」读取 `account.getSelfProfile` 用**同一个名片组件**渲染本人名片，读不到时给骨架，禁止任何虚构示例联系人。能量等级不属于展示字段，能量值保持独立。

`MemberProfileCard` 负责浮层定位与生命周期，`ContactProfileSurface` 负责内嵌资料页；身份、正文、群上下文及操作使用 `contactProfile` 下的共用组件。普通联系人浮层复用成员名片，不再并行维护一套正文。

### 行模型与容器（唯一实现）

- `components/contactProfile/ContactRow.tsx`：**唯一**的数据行组件（`ContactRow`）、分区小标题（`ContactSection`）、技术详情折叠（`ContactTechnicalDetails`）、局部失败（`ContactInlineError`）、空态（`ContactEmptyState`）。label 固定 96px、值 13px 左对齐可换行、空值整行不渲染；旧组件的 `.weq-profile-row` 通过 `profile-workspace.css` 的容器归一化跟随同一网格，不再各自排版。
- 名片壳与资料页壳共用身份区 `ContactIdentity`、操作区 `ContactActions`、页头 `ProfilePageHeader`（工具栏标题 + 右上关闭 + 身份/操作，文档流内、不覆盖章节标题；`actions` 可省略）。联系人资料页使用 `layout="split"` 和 `ContactIdentity.cardBody`：左侧沿用名片分行身份正文及显示设置，右侧每行一个操作；命名容器 `contact-profile` 宽度不足时整组操作移到身份区下方，横向自动换行并填满每行，不依赖浏览器窗口宽度。群资料页保留默认布局。
- `ProfileWorkspace` 负责目录与章节：宽屏 `weq-profile-directory` 竖目录，窄屏为 `weq-profile-directory-tabs` 横向章节条。联系人传入 `showTitle=false`，不在正文重复标签标题；互动标识和画像用 `ContactSection.prominent` 输出同级标题及分割线，其余分区沿用普通小标题。
- 样式归属：目录、工作区、行模型、共用技术详情组件只在 `styles/profile-workspace.css`；`styles/contact-card.css` 只保留名片壳、身份区、操作区、群上下文与设置页专属部分。当前状态复用聊天顶栏的 `OnlineStatus`；QQ、QID、UID、签名使用分行身份正文，沿用名片开关，四页正文不重复。联系人资料页不再挂载技术详情组件。
- `ProfileInlineField` 共用群昵称、头衔、备注及分组的原行表单；`QQProfileField` 延迟挂载备注／分组／群名的在线状态读取，复用 `qqWrite` 与账号绑定。备注、群名和分组写入需读回确认才退出表单，失败保留草稿；分组使用下拉控件，群名称仅对群主／管理员提供，标题的资料导航行为不变。保存后刷新名片名称与群详情的独立查询缓存，不写入会话名称投影。

## 数据与加载

- 本地输入立即渲染；补充资料使用包含账号配置和目标身份的共享查询键。只读挂载使用 `useQQWriteSession` 的被动模式，不额外创建周期性能力轮询；编辑和互动继续使用实时读写会话。
- 本地资料、云端名片名称、QQ 秀和装扮复用前端缓存及在途请求。资料读取支持可选的 `expectedAccountUin/expectedAccountConfigId`，保留旧调用兼容；服务端校验来源并拒绝切换后的迟到结果。名称投影不修改会话名称缓存。
- `peerStats.fields` 可选择 `level/likeCount`，省略时仍读取两项；服务层分别调用已有指标缓存，单项失败不清空另一项成功结果。只显示等级时不发送获赞读取。
- 标签目录、详细资料等根据启用内容挂载；同一接口被多个字段使用时复用查询结果。成功空目录与请求失败区分，零照片标签保留，照片续页只在进入相册后读取。
- `ProfileExtrasContent` 和 `ProfileDetailsContent` 支持页内承接，`ProfileExtraDialog` 复用相同内容与查询。原有签名、问答、照片互动不另建协议或写入通道。
- 私聊存在性优先使用完整目录和隐藏、历史及临时会话状态；必要时只读取会话边界。本群发言复用 `browseConversation` 的发送者过滤和游标分页。空间预览按点击延迟加载，复用空间读取和媒体网格，不预取评论或续页。

资料页章节采用共享目录容器，保留同一对象的章节、分页和滚动位置。`lib/contactWorkspace.ts` 定义四个内容页及旧导航映射：`details/signatures/history/edit` 归入 `profile`，`portrait` 归入 `marks`，`questions` 归入 `personality`。旧教育、签名、历史章节只定位个人资料，不恢复已移除的独立入口；学校、签名、项目历史在实际触发点旁打开详情。本人编辑及对外展示设置与名片偏好分开。

`ProfileDisclosure` 仅用于问答、本人编辑等仍需折叠的内容，收起保留现场并通过 `TabActivity` 暂停读取。互动画像随关系页直接挂载，不再折叠。`ProfileExtraDialog` 的教育和签名、共同群名单、项目历史使用显式锚点及 `presentation=popover`、`anchorPlacement=side`；QQ 秀展柜与本人头像历史同样支持锚点，保留原分页、互动与关闭行为。`ContactDressRow` 仅输出真实装扮素材，不复用带头像和 QQ 秀的个性主页舞台。

### 项目级历史（展示暂撤下）

当前 `contactHistoryVisibility` 中的固定常量 `CONTACT_HISTORY_DISPLAY_ENABLED=false` 统一关闭自建资料历史展示，不提供设置或隐藏菜单。`ContactFieldHistoryProvider` 只隔离旧上下文并透传正文，不挂载查询；字段可用性恒为假，字段按钮与汇总 `ContactHistory` 不挂载内容。QQ 原生的 `profileExtras.signatureHistory` 与 `profileExtras.avatarHistory` 保留原路径，不经过这个开关。已有存储、采集及迁移数据不变。

以下为保留但未挂到正式界面的实现说明；实现回归在测试中显式启用，正式关闭状态由 `contact_history_visibility.test.ts` 验证。

启用展示时，`ContactFieldHistoryProvider` 绑定账号、数据源、对象及可选成员 UID；`ContactRow` 和分区标题根据项目元数据在原位置挂历史按钮。弹窗内容默认不继承宿主的项目历史，打开其他联系人后由其资料 Provider 提供对应历史；`Modal` 与 `OverlayLayer` 复用纯上下文隔离组件。

- `history.fieldSummary` 只在打开资料时读取本地历史，worker 每批最多处理 100 条该对象的记录，返回变化项目和是否仍在构建；构建中短间隔继续，完成后仅活动资料页每 30 秒校准一次。离开后停止。无关的大名单和照片正文不解压，不扫描整个账号。
- `projectContactHistoryFields` 为已知资料返回逐项目投影：未返回字段与明确清空分开，生日／地区的部分返回保留既有子字段，集合按稳定身份归一；同来源的不同接口与查询分页共用字段流，不把本地和云端初值差异当作真实历史。群成员投影锁定群和 UID，成员换页不产生丢失或误判。
- `history.sqlite` 的 `field_progress`、`field_versions`、`field_changed` 为可重建派生索引，保留 A→B→A，合并 UID／QQ 号后重新建立受影响的索引；不删除或改写原始 `versions/content`。变化标记单独保存，完成后的校准不再扫描整个项目版本表。索引格式独立管理，不改变产品版本号。
- `history.fieldVersions` 按项目分页，在分页前按时间合并跨来源连续相同的值，合并首次／最近观察时间，保留 A→B→A；不对所有历史值做全局去重。服务端继续校验账号及数据源，前端缓存键包含完整身份，切群重建对应历史上下文。
- 逐字段展示由 `contactFieldPresentation` 明确区分趋势、变更、条目比较和图片；生日／年龄、时间戳、状态码和身份编号不因底层是数字就画趋势。数值图表使用现有 D3，按实际观察时间绘制阶梯线，遇到未知值断开，旁列准确值及增减；只展示已加载范围，不额外读取全量历史。
- 集合条目按业务身份比较，连续业务内容相同的旧快照只在展示层合并时间，保留原始资料；分页用「不再出现」而非断言删除。精选照片索引仍只存身份，打开该字段时按每批至多四个请求读取相同历史版本、补齐该版本已有图片引用，不查询当前相册或重写索引；补齐失败仍显示旧引用。后续分页失败保留已加载记录并原位重试。
- 头像不以 URL 字符串判定变化：`avatar_content` 按原始观察版本保存已取得图片字节的 SHA-256，`avatar_pending` 记录尚无图片可核实的引用。运行时注入已有媒体缓存的只读获取器，不为资料采集批量下载头像；缺图或读取失败不会产生换头像标记。打开资料时按批补算可用缓存，补算成功后重建对应对象的字段索引；不联网反查旧头像，不假定旧 URL 现在返回的图片就是历史图片。原始 URL 始终留在原始观察中。

UID 仅在开启该字段时进入身份区。`styles/contact-workspace.css` 承担联系人资料页专属样式，不修改群资料页的布局。

`ContactGroupWorkspace` 通过绑定账号和数据源的 `listUserGroups` 分页读取本地成员记录，合并来源群，不遍历所有群成员；群名优先使用当前群资料、来源群和已有会话目录，缺失时显示群号。切群重新构造 `profileContext`，不改联系人及当前会话；成员行与本群发言、聊天分析共用该上下文。选择记忆按账号、数据源和 UID 隔离，内存有界；来源群优先于记忆。`listUserGroups` 保留旧调用，同时使用已有 `scopedGroupRead` 拒绝跨账号、跨数据源及迟到响应。

## 定向验证

服务测试覆盖字段默认、归一化、排序、持久化、备份恢复及等级与获赞的实际读取选择；渲染测试覆盖名片浮层、头像补全、来源隔离、备注及群资料编辑和既有互动能力。

浏览器回归入口为 `apps/desktop/test/browser/run-contact-card.mjs`。通过 `WEQ_PLAYWRIGHT_IMPORT`、`WEQ_BROWSER_EXECUTABLE` 复用已有浏览器；`WEQ_CONTACT_CARD_QA` 指定截图和查询记录目录。脚本使用合成资料，禁止外网请求，退出时关闭自身浏览器和 Vite 服务。`WEQ_CONTACT_CARD_BASELINE=1` 可加载重构前的名片组件作同夹具对照。

浏览器记录用于核对真实首帧、冷开与缓存复用、可选查询及响应式布局，不等同于真实 QQ 网络耗时或长期性能验收。

四页资料工作区回归入口为 `apps/desktop/test/browser/run-contact-workspace.mjs`，沿用相同浏览器环境变量，以 `WEQ_CONTACT_WORKSPACE_QA` 指定截图和检查记录目录；覆盖教育／共同群／项目历史旁侧弹窗、QQ 秀顺序与对齐、紧凑标识、常驻画像、切群及所选群发言、四种宽度与深浅主题。模型与页内测试为 `contact_workspace_model.test.ts`、`contact_workspace_sections.test.ts`、`contact_field_history_ui.test.ts`；项目历史 worker 回归在 service 的 `contact_field_history.test.ts`，原始留存回归在 `contact_history.test.ts`。

原行编辑定向测试为 `profile_inline_field.test.ts` 与 `group_member_inline_edit.test.ts`；浏览器入口 `apps/desktop/test/browser/run-profile-inline.mjs` 使用同一运行时环境变量，以 `WEQ_PROFILE_INLINE_QA` 指定截图目录，覆盖备注保存／清空／取消、分组、群名称、失败草稿及深浅主题窄屏布局，所有写入均为合成桩。
