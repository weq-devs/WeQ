# 群相册卡片导航（2026-10-22）

已连接 Ark 点击、主工作区导航、指定相册与批次／评论详情。首个检查点 `aa1ae206` 只包含解析，不是界面交付；本阶段补齐读取、来源隔离和视图。真实只读 HTTP 与合成组件验证分别记录，不冒称已安装客户端的真实点击或打包发布验收。

## 已确认载荷

只读项目测试群的本地 Ark 记录，未扫描其它会话正文、未改写 QQ 原库、未发送 SSO 或上传请求。观察到以下入口：

| Ark | 明确目标槽位 | 结构 |
| --- | --- | --- |
| `com.tencent.activity.md` | `meta.activity.jumpUrl`、`buttonJumpUrl` | 对象，含 H5 `jumpUrl`／`pcJumpUrl` 和 `harmonyJumpUrl`；不是单个字符串 |
| `com.tencent.feed.lua` | `meta.feed.jumpUrl`、`legacyUrl`、`pcJumpUrl` | 原生群相册批次入口及旧 H5 包装 |
| `com.tencent.tuwen.lua` | `meta.news.jumpUrl` | 旧 H5 包装，内层 URL 另带 `f` 定位串 |

群公告不是相册目标；封面、标题、当前群或发布者不用于补造缺失身份。原始文案、群号、相册／批次／媒体 ID、图片 URL 和认证值不写入仓库，测试只保留同结构合成值。

## 路由与关系

- 原生相册入口为 `mqzone://arouse/groupalbum/albumdetail`，群号和相册 ID 可同时以大小写两组键出现。
- 原生批次入口为同域 `/groupalbum/feeddetail`，另含 batch ID 和可为空的 `llocid`；空值不当作具体媒体目标。
- H5 相册路径直接携带群号和相册 ID。H5 `inqq/detail/<encoded>/groupphoto` 中的 `<encoded>` 则是 **URL 编码的完整旧链接**，不能当群号。
- 旧链接为 `mobile.qzone.qq.com/photo/group/batch`；同一实际 feed 卡中逐值核对，`u`／`i`／`p` 分别等于原生入口的 group／album／batch，已观测版本为 `a=422,v=2,cmd=2`。
- `f` 是另一段不透明定位串。当前保留为 `legacyFocus`，没有把它猜成评论 ID 或 lloc，也没有因为普通服务器重定向丢掉它就视作无意义。

以合成值、无 Cookie 请求旧入口，服务器 302 到 `/groupphoto/album?inqq=1&groupId=…&aid=…&p=…`，验证相同的身份关系；有／无 `f` 都被重定向丢弃，因此这个重定向**不能证明评论定位已实现**。该入口见 [QQ 官方旧批次路由](https://mobile.qzone.qq.com/photo/group/batch)。

## 纯解析契约

`lib/groupAlbumNavigation.ts` 独立输出相册或 feed 目标：

- 严格区分个人空间相册与群相册，不接受伪造域名、凭据、非默认端口、未知协议或未知详情。
- 大小写别名、重复参数、路径与参数、卡片内多个入口必须一致；明确冲突／无效入口不被另一个候选掩盖。
- 只从已观测的跳转槽位取值，不扫描标题、缩略图或任意嵌套字符串；多份一致目标合并时保留更具体的批次／媒体／旧定位串。
- URL 与嵌套解码有界，所有身份继续以字符串保存；未知评论参数不降级为相册根页。

## 已接流程

- `QqArk` 在渲染分流前保留明确目标，活动卡的跳转对象不再被字符串提取丢掉。已知载荷无效／冲突与“不属于此格式”独立区分；冲突不再回退打开其中一个链接。普通分享卡的既有语义跳转槽位如携带已识别群相册 URL，也可内部导航；非群相册链接保留原导航，不扫描任意元字段。
- `GroupAlbumCardNavigationProvider` 位于主工作区内，固定点击时的账号和 configId。按卡片群号取得名称或使用群号，不用外层会话补目标。来源变化立即隐藏并销毁旧详情，重复打开以新的 revision 取消旧视图。
- 相册根复用 `GroupAlbumDialog.initialAlbumId`；只有列表已实际返回后才判断不存在。离线不误报缺失，失败重试仍找原目标，不自动选其它相册。列表及媒体 RPC 可带来源绑定，分页前后均复核，旧数据不进新来源的搜索索引。
- 批次用 `GroupAlbumFeedDialog` 显示指定动态，而非首张照片或相册根页。明确 mediaId 只匹配该项；存在但地址缺失与完全不存在分别报告。大批次本地先展示 60 项、按需展开，连续预览仍保留全部已读结果；视频本体缺失时只预览／保存封面，不显示伪播放入口。
- 评论按实际 ID 合并分页与已返回回复，独立主评论不丢失或重复。读取／刷新错误保留旧页，可重试同一游标；重复分页位置不合并。总数缺失或与聚合快照不一致时不伪造零，回复尚未全返回会保留数量提示。读取隐藏／离线时暂停，恢复活动后重新读取。
- 媒体预览／保存复用现有 `QzoneMediaPreview`、`MediaSourceSave`；表情复用从空间视图提取的 `QzoneEmoji`，GIF／PNG 都失败仍保留文字占位。导航本身没有新增自动写请求。

## 详情读取与身份

`web/group_album_feed.ts` 使用官方移动页的 GET `cmd=qunGetDetail`，通过 `mqqinfo.cell_operation.qq_url` 携带受控旧链接。保留 f 交服务端处理，不在客户端拆它猜身份。调用带同源 XHR 的 Accept／X-Requested-With 及官方 ajax 自动补入的 uin；Cookie 与 g_tk 仍走已有 WebCredentialProvider。

响应必须有明确 `ret=0`。按官方 cell 槽位读取作者、媒体、评论、回复及分页，先验证群号与相册。普通视图的文本 subid 可给出批次；旧定位视图实测需优先核验操作 cell `18.busi_param.21` 的父批次，不能将视图 subid 强当批次，也不能直接跳过批次核验。父批次明确返回但冲突时拒绝响应。

`getGroupAlbumFeed` RPC 要求账号和 configId，Web 取票前后及响应返回时检查来源；认证补取票也先检查，不为旧请求重复读取。传输是有界 GET，不在底层自行重放；页面重试仍携带同一绑定。相册／批次身份错误、缺失详情、分页不前进、媒体类型未知等明确失败，不当作空评论或空相册。

## 一手页面依据

官方桌面 [groupPhoto util](https://qzonestyle.gtimg.cn/qzone/photo/v7/js/module/groupPhoto/util/index.js?max_age=9999999&v=202610202309) 包含群相册详情读取入口；官方移动 [基础模块](https://qzonestyle.gtimg.cn/qzone/hybrid/app/photo/groupPhotoinqq/lib/base.js?_v=201712221107)、[详情模块](https://qzonestyle.gtimg.cn/qzone/hybrid/app/photo/groupPhotoinqq/detail/index2.js?_v=201712221107)、[动态模块](https://qzonestyle.gtimg.cn/qzone/hybrid/app/photo/groupPhotoinqq/recent/index2.js?_v=201712221107) 显示独立 qunid／albumid、batch 和评论上下文。只借用协议事实，不执行远端脚本或引入其运行时。

## 验证范围

定向回归覆盖目标解析、活动／动态／旧定位卡的实际组件点击、普通分享槽位、冲突不回退、非群链接锚点不受影响、来源变化与迟到响应、精确相册／媒体、评论分页去重与循环、离线恢复、错误重试、不可预览占位和视频仅封面。服务侧测试使用合成 cell 黄金数据及模拟 HTTP，不碰真实 QQ 数据库或联网。

另以独立进程、正常缓存 Web 凭据对测试群的普通批次和带 f 的旧卡分别做最小只读 GET，均验证匹配的群／相册／父批次，返回 1 项媒体与 1 条评论；只保存计数、字段关系与状态，不保存私人正文、标识、图片或认证响应。最初缺少浏览器请求字段及将视图 subid 当批次的两次失败已分别定位、补回归并修正，不当作通过证据。

Playwright 的工作区、卡片、详情与预览均用真实组件＋合成 RPC，媒体经真实资源 URL 桥接返回合成 PNG；检查桌面及窄屏、深浅／自定义主题色、长名称、像素尺寸、精确预览、分页和来源切换。不是对用户已安装应用点击私人媒体的真机验收，未部署或重启用户客户端。
