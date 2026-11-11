# 本人历史头像与资料编辑入口

## 读取链路

`account.profileExtras.avatarHistory` 为只读分页查询，输入当前账号的 `expectedAccountUin`、`expectedAccountConfigId` 和可选数值 `cursor`，拒绝额外的目标账号字段。

服务层绑定 `selfUin`，通过现有 ContactMetrics 调度与在途查询去重调用协议。协议沿用 Android QQ 历史头像 H5 的 `MQUpdateSvc_com_qq_ti.web.OidbSvc.0x5f1_6` WebSSO JSON 读取方式：请求只含 `uint32_timestamp` 与 `uint32_num`，不添加目标 UIN。首页 24 条，续页 30 条。

返回复用 `ProfilePage<HistoricalAvatar, number>`。资源 ID 用于去重；`uint32_upload_time` 映射为 `firstUsedAt`（最早使用时间），`uint32_update_time` 映射为 `lastUsedAt`（最后使用时间），原始秒值不改写。另保留图片规格标志与文件大小元数据，并按规格生成缩略图／大图地址。文件大小不用于校验 CDN 响应长度。

严格区分传输失败、业务失败、字段缺失与空列表。分页结束以服务端标记或零游标为准；非结束页游标不前进时保留本页并报告分页异常。列表不是设置事件流水，不构造使用次数。

## 界面与生命周期

历史头像弹窗打开后才启用查询，首批立即展示，后续通过单个延时任务串行续页。使用现有可见性与标签活动状态，在后台或关闭时停止发起新页。图片经现有头像缓存代理加载，预览复用 QzoneMediaPreview。

排序仅作用于已取回数据，不改变服务端游标。未知时间始终排末尾，同时间按资源 ID 稳定排序。预览固定打开时的列表与资源 ID，不因续页重排而跳图。完整数量仅在成功到达终点时显示。

顶栏与移动个人入口的名片使用只读资料展示，只有“查看资料”和历史列表等浏览入口。查看资料通过 ContactWorkspaceNavigationContext 打开本人联系人资料页；仅当前账号本人的嵌入式“资料”页挂载可编辑 SelfQQControls，其他人的资料页不挂载此编辑器。

SelfProfileField 控制单项编辑生命周期，复用原有 QQ 字段编辑器与保存后读回，不新增全页编辑模式。现有共享控件在字段容器之外保持原有行为。QQ 账号管理和登录设置不迁移。

## 验证

定向测试覆盖 WebSSO 六字段、分页终点、游标停滞、缺失时间、图片规格与地址、按两种时间的升降序、跨页资源去重、本人来源绑定、账号切换、只读名片导航、逐项保存／取消和草稿保留。

`apps/desktop/test/browser/run-self-profile.mjs` 使用合成资料与仓库位图验证桌面／移动布局、深浅主题、图片解码、排序、失败重试及多层预览的 Escape 行为。可通过 `WEQ_PLAYWRIGHT_IMPORT`、`WEQ_BROWSER_EXECUTABLE` 和 `WEQ_SELF_PROFILE_QA` 复用本地浏览器运行环境并保存截图；不读取或修改真实 QQ 资料。
