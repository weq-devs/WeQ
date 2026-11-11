# 个人资料扩展读取

本功能复用普通 SSO 会话传输，无新增 native 方法、数据库表或登录流程。入口为 protocol 的 profile/extras、账号级 ProfileExtrasService、account.profileExtras 只读路由和共享 ProfileExtras 组件。

## 接口

六个查询均携带 expectedAccountUin、expectedAccountConfigId、目标 uin；响应固定 targetUin。账号路由与服务分别在异步前后复核数据源和 QQ 进程，不要求目标仍为好友或群成员。

| 查询 | 参数 | 返回 |
| --- | --- | --- |
| energy | uin | score、level、trend、display，字段缺省为 null |
| educationHistory | uin | 完整教育经历 items，每条保留 17 个已确认字段，缺字段为 null，不分页、不按学校去重 |
| signatureHistory | uin、可选数字 cursor | 签名条目及下一时间上界 |
| personalityLabels | uin | 标签、首批照片、每标签 cookie、照片数 |
| personalityPhotos | uin、labelId、可选字符串 cursor | 照片页、完成标记 |
| anonymousQuestions | uin、filter、可选字符串 cursor | 问答页、结束标记；他人的 filter 强制为 answered |

分页结果统一为 items、nextCursor、hasMore、paginationError。二进制标签 cookie 转为规范 Base64，问答 cookie 是服务端 JSON 字符串，不能混用。相同目标、筛选和游标共享在途查询，在线工作复用联系人指标调度队列，但历史列表不写入指标快照。

## 协议依据

- 历史签名：OidbSvc.0xde8_1，普通旧 OIDB，serviceType=1。请求 tag 1 目标、2=2、4=0、5 时间上界、6=0、7=0、8=6、10=60。首次上界 0x7fffffff，续页为末条时间减 1。响应结束标记独立于条数；签名 bytes_nick 是 RichStatus TLV，包含正文、动作、数据、位置和非文本属性。
- 能量值：qqvalue.GetQQValue 是独立 protobuf 命令。响应内层 tag 8 为目标 UIN，必须与请求一致；不能拿资料卡 QQValueInfoItem 的 tag 8 扩展列表 schema 解码。缺字段和零值分开，不替换本地昵称或备注。
- 标签：OidbSvc.0x8f0 的请求为目标和 digest=1；OidbSvc.0x8f1 每次请求 20 张，携带目标、标签 ID 和该标签 cookie。照片字段原名 uint32_url，实际 wire=2 的字符串。complete=1 时可以没有照片或 cookie。
- 匿问我答：MQUpdateSvc_com_qq_ti.web.OidbSvc.0xec4_1，WebSSO 的 type=0 和 JSON data，分层核对外层 ret、JSON ErrorCode 和业务 ret。每次 10 个问题、10 条附带评论；只展示返回的互动数量，不提供独立评论分页。answered_quest_num 随页变化，不作为全局总已回答数。
- 教育经历：原生命令为 `OidbSvc.0xd2d`，外层 command=0xd2d、serviceType=1；请求 tag 1=目标 uint64 UIN、tag 2=category 0（显式编码）。响应 `EduHis@1 → SchoolInfo[]@1`；SchoolInfo 的 1=category，2/3=学校 ID/名称，4/5=院系 ID/名称，6=学历，7/8=入学/毕业年，9=校友推荐，10/11=创建来源/时间，12/13=更新来源/时间，14=隐藏标记，15/16=认证状态/类型，**100=记录 idx**。不与 H5 的 `0xd2d_2` 或旧学校文本字段 20021 混用。该响应没有目标 UIN 回显或分页标记，不编造目标校验字段或续页参数；目标由请求、账号会话及路由绑定。

教育读取对 OIDB 外层及已建模的嵌套 protobuf 启用可选严格解码，拒绝截断、非法 tag、错误 wire 与非法 UTF-8；其他旧调用保持原默认行为。业务成功时允许省略整个 EduHis，按官方逻辑视为空列表；业务错误不降级为空。保留所有同校、缺编号及隐藏条目，不用固定条数截断。界面查看他人时不展示 hidden=1 的条目；自己可见并标明未公开。学历 5–9 按官方 H5 显示大专、本科、研究生、博士、博士后，未知值保留编号。

按 feed ID／照片 ID／问题 ID 去重。重复游标、缺失下一页游标或重复整个页面停止续页，保留当前内容并允许重读末页；空页有新游标时仍可继续。uint64 标识与大计数以十进制字符串保留精度。

## 界面和媒体

本地资料不等待这些请求。能量值单独查询，教育经历、历史、标签和问答在详情打开后加载；隐藏页及离线状态不继续请求。五分钟查询缓存按账号、数据源、目标、筛选和游标隔离，不持久化新的历史库。教育详情显示多条学校、院系、学历、入学／毕业年份及已确认的认证状态，不覆盖原有学校／学历缓存；刷新失败保留已读内容。

标签照片复用 albumMediaUrl、现有相册媒体代理和 QzoneMediaPreview，缩略网格和大图均使用实际返回的 URL，不推造未验证的 CDN 尺寸地址。保留键盘切图、缩放、失败重试与顶层 Escape 行为。

## 验证状态

Android QQ 9.3.75 静态调用链与官方问答 H5 已核对。本机当前 Mac QQ 登录态上，新生产代码对当前账号与另一自有账号完成独立查询：能量值目标一致；自己返回签名、标签及非空照片续页和问答，他人返回正确的空历史／标签／问答结果。两张实际标签照片已取回，复用代理 URL 构建和预览组件完成浏览器绘制检查。

资料卡 SummaryCard 聚合业务 16／19 曾返回 151（error login sig），本实现不调用该路径，也不把它当作独立接口失败的回退。当前无签名默认配置已被上述 Mac 会话接受，不据此宣称其他平台 QQ 本体采用相同签名行为；Windows／Linux 和 Android 真机界面对照尚未验收。

测试使用合成 wire 与隔离 RPC，不把真实账号、签名正文、问答或照片纳入仓库。维护回执与原始证据保存在本机文档项目。

教育生产读取于 2026-11-11 在当前 Mac QQ 会话完成两轮自己账号的只读验证：均返回两条非空学校记录，各有 17 个字段；加入严格解码后再次通过。每轮含一次已有资料卡获赞正对照；未修改资料、未保存学校正文或编号到仓库。协议样本由独立 wire 构造，另覆盖 600 条同名学校记录、缺字段与零值、未知枚举、错误命令、业务失败和截断反例。跨平台和 Android 真机界面对照仍待验证。
