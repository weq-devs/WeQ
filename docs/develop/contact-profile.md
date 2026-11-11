# 统一联系人名片与资料页

## 配置与入口

`AppSettings.contactCard` 由 `@weq/service/contact-card` 定义默认值、可选字段及顺序归一化。只保存内容可见性、正文顺序和群内可选内容顺序，不保存操作能力开关。未知、重复及已移除字段不会重新进入设置；局部设置补丁保留其他已选内容。

配置通过 `bootstrap.getSettings/setContactCard` 读写，复用全局配置备份、设置更新通知、设置搜索和恢复默认。示例预览不查询真实账号资料。能量等级不属于展示字段，能量值保持独立。

`MemberProfileCard` 负责浮层定位与生命周期，`ContactProfileSurface` 负责内嵌资料页；身份、正文、群上下文及操作使用 `contactProfile` 下的共用组件。普通联系人浮层复用成员名片，不再并行维护一套正文。

## 数据与加载

- 本地输入立即渲染；补充资料使用包含账号配置和目标身份的共享查询键。只读挂载使用 `useQQWriteSession` 的被动模式，不额外创建周期性能力轮询；编辑和互动继续使用实时读写会话。
- 本地资料、云端名片名称、QQ 秀和装扮复用前端缓存及在途请求。资料读取支持可选的 `expectedAccountUin/expectedAccountConfigId`，保留旧调用兼容；服务端校验来源并拒绝切换后的迟到结果。名称投影不修改会话名称缓存。
- `peerStats.fields` 可选择 `level/likeCount`，省略时仍读取两项；服务层分别调用已有指标缓存，单项失败不清空另一项成功结果。只显示等级时不发送获赞读取。
- 标签目录、详细资料等根据启用内容挂载；同一接口被多个字段使用时复用查询结果。成功空目录与请求失败区分，零照片标签保留，照片续页只在进入相册后读取。
- `ProfileExtrasContent` 和 `ProfileDetailsContent` 支持页内承接，`ProfileExtraDialog` 复用相同内容与查询。原有签名、问答、照片互动不另建协议或写入通道。
- 私聊存在性优先使用完整目录和隐藏、历史及临时会话状态；必要时只读取会话边界。本群发言复用 `browseConversation` 的发送者过滤和游标分页。空间预览按点击延迟加载，复用空间读取和媒体网格，不预取评论或续页。

资料页章节采用已有共享目录容器，保留同一对象的章节、分页和滚动位置。导航目标携带群上下文和标签 ID，原有 `profile/personality/marks/portrait/history` 值继续有效。本人编辑及对外展示设置与名片偏好分开。

## 定向验证

服务测试覆盖字段默认、归一化、排序、持久化、备份恢复及等级与获赞的实际读取选择；渲染测试覆盖名片浮层、头像补全、来源隔离、备注及群资料编辑和既有互动能力。

浏览器回归入口为 `apps/desktop/test/browser/run-contact-card.mjs`。通过 `WEQ_PLAYWRIGHT_IMPORT`、`WEQ_BROWSER_EXECUTABLE` 复用已有浏览器；`WEQ_CONTACT_CARD_QA` 指定截图和查询记录目录。脚本使用合成资料，禁止外网请求，退出时关闭自身浏览器和 Vite 服务。`WEQ_CONTACT_CARD_BASELINE=1` 可加载重构前的名片组件作同夹具对照。

浏览器记录用于核对真实首帧、冷开与缓存复用、可选查询及响应式布局，不等同于真实 QQ 网络耗时或长期性能验收。
