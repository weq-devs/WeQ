# 群相册卡片导航（2026-10-22，接入中）

本阶段已取得实际 Ark 的脱敏结构并实现纯目标解析，**尚未连接 Ark 点击、群相册／批次详情与评论界面，不是已经可用的内部跳转**。完整需求继续保留未完成，不把打开某一本相册代替定位卡片对应批次、媒体或评论。

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

## 后续接入

1. Ark 活动卡不能继续用仅取字符串的 `s(p,'jumpUrl')`；统一从已确认槽位读取并向主工作区发出完整目标。
2. 主工作区按卡片群号打开独立群相册入口，不用当前会话覆盖；异步响应继续绑定账号、来源及请求 revision。
3. 相册根可复用 `GroupAlbumDialog.initialAlbumId`，批次不能选第一项代替：需按 batch 定位与读取详情，媒体仅在精确匹配时打开。
4. 已有 `GetGroupAlbumFeedDetail` 主要返回供评论透传的原始 cell，不是完整评论视图；需要按实际读协议接好详情／评论数据，再消费旧定位串。不凭一条成功发包或合成回包宣称真实定位已验收。

## 一手页面依据

官方桌面 [groupPhoto util](https://qzonestyle.gtimg.cn/qzone/photo/v7/js/module/groupPhoto/util/index.js?max_age=9999999&v=202610202309) 包含群相册详情读取入口；官方移动 [基础模块](https://qzonestyle.gtimg.cn/qzone/hybrid/app/photo/groupPhotoinqq/lib/base.js?_v=201712221107)、[详情模块](https://qzonestyle.gtimg.cn/qzone/hybrid/app/photo/groupPhotoinqq/detail/index2.js?_v=201712221107)、[动态模块](https://qzonestyle.gtimg.cn/qzone/hybrid/app/photo/groupPhotoinqq/recent/index2.js?_v=201712221107) 显示独立 qunid／albumid、batch 和评论上下文。只借用协议事实，不执行远端脚本或引入其运行时。

本轮定向测试覆盖三种 Ark 形状、原生／新旧 H5、嵌套 URL、空媒体、保留旧定位串、别名及入口冲突、错误版本、未知评论字段和不猜目标；这只证明目标解析，不能替代后续点击与真实群相册读回验收。
