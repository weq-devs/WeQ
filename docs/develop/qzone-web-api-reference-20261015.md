# QQ 空间 Web 接口用法汇总

整理日期：2026-10-15（北京时间）。用途：WeQ 查看、导出能力的研究索引，不是腾讯公开承诺稳定的 API 文档。

## 1. 范围与结论

本文汇总本轮实际查到的腾讯公开前端请求模块、WeQ 源码，以及 QZoneExport、QzonePhoto、onebot-qzone、qq_zone_api、QZoneKit 的接口定义、调用参数和研究笔记。

按用途及请求变体编排了 **53 条读取配方、24 条写入配方、9 条旧版/移动端备选、15 条仅登记的接口线索和 2 条地图辅助接口**。这是 103 条研究索引，不是 103 个相互独立且已经验证可用的服务端接口。同一个 URL 的不同对象、参数和用途会分列；同一能力也可能存在不同域名或版本。

- “已接入”仅表示调查时 WeQ 有对应源码调用，不替代当前版本、真实账号、完整性或 GUI 验收。
- “开发中”指主线程正在修改的空间统计和浏览量代码，本文件不认定它们已经完成、提交、构建或上线。
- “未接入”指未在调查范围内找到 WeQ 对应的空间 Web 调用；不代表 QQ 本地数据库或其他模块没有相近能力。
- “源码调用”表示找到了具体构造请求的代码；“仅登记”表示只有接口名或路由线索，参数不足，不能据此生成可执行请求。
- 本轮只读源码和文档，**没有调用真实 QQ 账号、没有读取聊天库、没有探测私人空间或执行写入接口**。
- 不声称穷尽 QQ 空间所有内部接口。网页登录、二维码、腾讯登录平台、遥测广告、静态资源和第三方 SDK 的全部接口不属于本业务清单；已发现的媒体备用上传和地图辅助路径仍列在附录。
- 接口清单不等于开发授权。WeQ 仍可只选只读能力；删除、编辑、点赞、发布等列出来是为了识别边界，不建议默认加入查看/导出工具。

### 1.1 来源版本

| 代号 | 来源及固定版本 | 本轮使用的主要文件 |
| --- | --- | --- |
| E | [ShunCai/QZoneExport](https://github.com/ShunCai/QZoneExport/tree/7e0218fab29316ca28b99a7c63deb0627002d271)，`7e0218fab29316ca28b99a7c63deb0627002d271` | [urls.ts](https://github.com/ShunCai/QZoneExport/blob/7e0218fab29316ca28b99a7c63deb0627002d271/core/qzone-api/urls.ts)、[clients.ts](https://github.com/ShunCai/QZoneExport/blob/7e0218fab29316ca28b99a7c63deb0627002d271/core/qzone-api/clients.ts)、[request.ts](https://github.com/ShunCai/QZoneExport/blob/7e0218fab29316ca28b99a7c63deb0627002d271/core/qzone-api/request.ts)、[context.ts](https://github.com/ShunCai/QZoneExport/blob/7e0218fab29316ca28b99a7c63deb0627002d271/core/qzone-api/context.ts) |
| P | [11273/QzonePhoto](https://github.com/11273/QzonePhoto/tree/d74b7ffb3026074c44dbb193915f8fc63af5c891)，`d74b7ffb3026074c44dbb193915f8fc63af5c891` | [photo.js](https://github.com/11273/QzonePhoto/blob/d74b7ffb3026074c44dbb193915f8fc63af5c891/src/main/api/qzone/photo.js)、[user.js](https://github.com/11273/QzonePhoto/blob/d74b7ffb3026074c44dbb193915f8fc63af5c891/src/main/api/qzone/user.js) |
| O | [Gu-Heping/onebot-qzone](https://github.com/Gu-Heping/onebot-qzone/tree/2d016d2b60130923e060f8bc469d271d397879e0)，`2d016d2b60130923e060f8bc469d271d397879e0` | [client.ts](https://github.com/Gu-Heping/onebot-qzone/blob/2d016d2b60130923e060f8bc469d271d397879e0/src/qzone/client.ts)、[emotion-api.md](https://github.com/Gu-Heping/onebot-qzone/blob/2d016d2b60130923e060f8bc469d271d397879e0/doc/emotion-api.md)、[photo-api.md](https://github.com/Gu-Heping/onebot-qzone/blob/2d016d2b60130923e060f8bc469d271d397879e0/doc/photo-api.md)、[user-api.md](https://github.com/Gu-Heping/onebot-qzone/blob/2d016d2b60130923e060f8bc469d271d397879e0/doc/user-api.md)、[探测记录](https://github.com/Gu-Heping/onebot-qzone/blob/2d016d2b60130923e060f8bc469d271d397879e0/doc/api-probe-results.md) |
| H | [HuanXinToolkit/qq_zone_api](https://github.com/HuanXinToolkit/qq_zone_api/tree/32e008355eef634530089bd9fcc2efd914093e66)，`32e008355eef634530089bd9fcc2efd914093e66` | [api_zone.py](https://github.com/HuanXinToolkit/qq_zone_api/blob/32e008355eef634530089bd9fcc2efd914093e66/qzone_api/api/api_zone.py)、[api_feed.py](https://github.com/HuanXinToolkit/qq_zone_api/blob/32e008355eef634530089bd9fcc2efd914093e66/qzone_api/api/api_feed.py)、[api_parms.py](https://github.com/HuanXinToolkit/qq_zone_api/blob/32e008355eef634530089bd9fcc2efd914093e66/qzone_api/api/api_parms.py)、[api_base.py](https://github.com/HuanXinToolkit/qq_zone_api/blob/32e008355eef634530089bd9fcc2efd914093e66/qzone_api/api/api_base.py) |
| K | [ainiaidaochediwangji/QZoneKit](https://github.com/ainiaidaochediwangji/QZoneKit/tree/e3a3d7baeac5a3a8c401deee4604665ad0409ebc)，`e3a3d7baeac5a3a8c401deee4604665ad0409ebc` | [API_NOTES.md](https://github.com/ainiaidaochediwangji/QZoneKit/blob/e3a3d7baeac5a3a8c401deee4604665ad0409ebc/API_NOTES.md)、[visitors.py](https://github.com/ainiaidaochediwangji/QZoneKit/blob/e3a3d7baeac5a3a8c401deee4604665ad0409ebc/qzone/visitors.py) |
| T | 腾讯公开静态脚本，无 Git 版本；本轮下载成功并记录下方正文哈希 | [MoodRequest 3.0](https://qzs.qq.com/qzone/app/requests/moodRequest/moodRequest_3.0.js)、[RetweetListViewModel 3.0](https://qzs.qq.com/qzone/app/controls/retweetList/retweetListViewModel/retweetListViewModel_3.0.js)、[Mood 模型 3.0](https://qzs.qq.com/qzone/app/models/mood/mood_3.0.js) |
| W | 本机 WeQ，调查初次读取时 Git HEAD 为 `24ebe80df17102b2bbc5548f1f62dc2c516ae6f4`，当时另有主线程未提交修改；是观察快照，不是持续状态监控 | `packages/service/src/account/web/`、`apps/desktop/src/main/ipc/routers/qzone.ts`、`apps/desktop/src/renderer/src/views/QzoneView.tsx` |

腾讯脚本的 SHA-256（对本轮取得的文本进行 UTF-8 编码后计算，不是压缩 HTTP 传输字节）：

```text
MoodRequest 3.0             fa6f6caafbff3a16a74099a5483741bb04ef3eeefceab336847e9852287cb7ee
RetweetListViewModel 3.0    c6f86f6a89701ea3773fca1818e3ba405f374ab5fa4cb241c923a68b119d0168
Mood 模型 3.0              9ca897ee00e59ad65137b7c1c1f2832c6c5538bb76440ce7e03975b02dbe2016
```

## 2. 通用用法

### 2.1 URL 记法

表中的 `U(domain, path)` 表示：

```text
https://user.qzone.qq.com/proxy/domain/<domain><path>
```

`H5(domain, path)` 表示：

```text
https://h5.qzone.qq.com/proxy/domain/<domain><path>
```

`RC(domain, path)` 表示 `https://rc.qzone.qq.com/proxy/domain/<domain><path>`。完整 `https://...` 为直接地址，不套代理。

网关、目标域、路径、请求方式是同一条配方的一部分。例如 `taotao.qq.com` 与 `taotao.qzone.qq.com`、`cgi-bin` 与 `fcgi-bin` 不能任意互换。表中缩写只方便阅读，不暗示各组合等价。

### 2.2 身份、凭据与对象

| 符号/字段 | 含义与使用注意 |
| --- | --- |
| `L` | 当前登录 QQ 的 UIN，不是目标空间主人 |
| `T` | 被读取的空间主人 UIN；可能等于 `L` |
| `tid` | 某条说说的稳定句柄；动态 feed key、时间戳、转发源 tid 不一定与它相同 |
| `topicId` | 接口专用复合键；说说常见 `T_tid`，有的链路要求 `T_tid__1`；相册/照片另有格式 |
| `albumId` / `picKey` | 相册 ID / 照片定位键；`lloc`、`sloc`、图片 URL 不能相互猜代 |
| `uin` / `hostUin` / `hostuin` | 字段语义随接口变化，大小写也有区别；按每条配方填，不能统一替换 |
| `Cookie` | 来自当前登录身份的有效域内 cookie jar；`uin/p_uin` 不得改成目标 `T` |
| `g_tk` | 通常由相应域的 `p_skey` 计算，WeQ 沿用 `pskey || skey`；不是 `qzonetoken` |
| `qzonetoken` | 网页上下文中的另一种票据；E 多数请求携带，W 的若干已接入请求不需要；不可用 `g_tk` 猜造 |
| `Referer` | 通常为 `https://user.qzone.qq.com/T`，动态中心/发布等有专门来源页 |
| `appid` | 常见说说 `311`、相册 `4`、日志 `2`、分享 `202`；不是任意接口都接受这些值 |

`g_tk` 的概念算法：初值 `5381`，对票据每个字符执行 `hash = hash * 33 + charCode`，最终取 `hash & 0x7fffffff`。实现应复用 W 的 `computeBkn`，不要为本文另建凭据缓存。

不在文档、源码、URL 示例、日志或截图中保存真实 cookie、clientKey、`p_skey`、二维码登录结果、一次性跳转链或带个人签名的媒体 URL。身份状态应沿用 WeQ 现有会话服务。

### 2.3 响应与分页

- 响应可能是 JSON、JSONP、JS 对象字面量、HTML 或 `frameElement.callback(...)`。只解析数据，不能 `eval`、执行 `<script>` 或把远端响应直接注入页面。
- HTTP 200 不表示业务成功。需按接口检查 `code`、`ret`、`result.code` 或 `error.type`，并检查对应列表/对象确实存在。
- `null`、缺字段、权限拒绝、超时和明确数值 `0` 必须分开。不能把请求失败包装成“没有内容”。
- `pos/num`、`start/count`、`pageStart/pageNum`、`begin_uin` 和服务端 `externparam` 是不同分页协议。不能把所有接口都做成“页号加一”。
- 动态 continuation 应优先原样使用服务端给出的 `externparam`；同时镜像其中的 `basetime/pagenum` 等上层参数，不能随意重新计算游标。
- 每页去重并检测游标停滞、重复页、总数变化；有界请求、取消、超时、风控退避，不通过盲目大页大小或反复换路由轰炸补全。
- 任何读取都可能被服务器记录访问痕迹。GET 也可能带状态副作用；特别检查 `clear`、通知清除、访问上报参数。

## 3. 读取接口

默认 GET；POST 读取在方法栏明确标出。表中参数是核心调用要点，不是保证跨账号都成功的最小参数集。公用 `g_tk`、cookie、Referer 适用第 2 节；附加编码/格式字段和完整默认值参照固定版本源码。

### 3.1 说说、详情、媒体与互动

| ID | 用途、方法与路径 | 关键用法 | 返回与限制 | 来源 / WeQ |
| --- | --- | --- | --- | --- |
| R01 | 说说列表：`U(taotao.qq.com, /cgi-bin/emotion_cgi_msglist_v6)` | `uin=T, ftype=0, sort=0, pos=0, num=20, code_version=1, format=json`；E 还传 `replynum, need_private_comment, qzonetoken` | `msglist, total, usrinfo`；正文/媒体可能截断，内嵌评论不等于全量；`msglist=null` 要另核身份，不能一律为空空间 | E/P/H/W；已接入 |
| R02 | 完整说说：`U(taotao.qq.com, /cgi-bin/emotion_cgi_msgdetail_v6)` | E `messageFullContent`：`tid, uin=T, hostuin=L, t1_source=1, not_trunc_con=1, code_version=1, format=jsonp` | 目标是完整正文/详情；需要核原响应的完整性标记，不能把列表回退结果当全文 | E；未接入 |
| R03 | 旧详情变体：`U(taotao.qzone.qq.com, /cgi-bin/emotion_cgi_getdetailv6)`，GET/POST | O 以 `uin=T, tid, hostuin=L, format=json` 请求，部分变体加 `qzonetoken, qzreferrer` | O 有失败冷却及列表/动态回退；与 R02 是不同路径，不能据函数名当同一已验证服务 | O；未接入 |
| R04 | 说说附图补全：`U(taotao.qq.com, /cgi-bin/emotion_cgi_get_pics_v6)` | `uin=T, tid, t1_source=1, g_tk, qzonetoken`，E `messageImageInfos` | 用于追加图片定位信息；需对照已知 `pictotal`、顺序、重复和本体/预览差别 | E；未接入 |
| R05 | 语音地址解析：`U(snsapp.qzone.qq.com, /cgi-bin/sound/GetVoice)` | E 将原始 `voice.url` 的查询参数解析后传入；不从 tid 猜参数 | 真实参数依赖原始语音引用；文档未取得可承诺的统一返回 schema；播放/原件可得性未验证 | E；未接入，W 只保留部分语音原字段 |
| R06 | 转发名单：`U(taotao.qq.com, /cgi-bin/emotion_cgi_get_fullrelay_v6)` | `uin=T, tid, t1_source=1, pos, count, show=1, code_version=1` | `post[].owner, t2_tid, content, createTime, total, total4show`；原文 `rtlist` 不是转发者名单，两个总数分别保留 | T/W；已接入 |
| R07 | 结构化说说评论/回复：`H5(taotao.qzone.qq.com, /cgi-bin/emotion_cgi_getcmtreply_v6)`；P/E 用 U 网关 | W `uin=L, hostUin=T, topicId=T_tid, start, num=50, order=0, need_private_comment=1, format=jsonp` | 根评论和回复字段分别核验；根评数、回复数、界面总评论数口径不同；`need_private_comment=1` 不授予额外权限 | E/P/W；已接入 |
| R08 | 动态内评论 HTML：`U(taotao.qzone.qq.com, /cgi-bin/emotion_cgi_ic_getcomments)`，POST 读取 | P `topicId` 取动态 HTML 的 `data-topicid`（可含 `__1`），`hostUin=T, uin=L, feedsType=8, start, num, sort, source=ic, format=fs, paramstr=1, isfakereq=1` | `ret, needVerify, result.feeds` 等，返回评论 HTML；不能把 HTML 的 `data-feedstype=100` 直接填成 `feedsType`，也不能靠 POST 推断为写评论 | P；未直接接入 |
| R09 | 点赞/评论/浏览等计数：`U(r.qzone.qq.com, /cgi-bin/user/qz_opcnt2)` | W 单条说说使用两份 mood URL 以 `<.>` 连接的 `unikey`，带 `face=0, fupdate=1`；普通动态应沿用自己的 `curkey` | `data[].current.newdata` 中 `LIKE, CS, CP, PRD, ZS` 为各类计数线索；`likedata.cnt/list` 为名单证据；字段缺失不补零，需核对象 key | E/O/W；计数及名单已接入，浏览量开发中 |
| R10 | 可分页点赞名单：`U(users.qzone.qq.com, /cgi-bin/likes/get_like_list_app)` | `uin=L, unikey, begin_uin=0, query_count<=60, if_first_page=1`；后续以实际末尾 UIN/服务端信息继续 | P 解析 `data.like_uin_info, total_number, has_more` 等；不能以单页名单长度冒称总数 | E/P；未接入此名单路径，W 现用 R09 |

### 3.2 动态流、回顾与通知计数

| ID | 用途、方法与路径 | 关键用法 | 返回与限制 | 来源 / WeQ |
| --- | --- | --- | --- | --- |
| R11 | 好友动态：`H5(ic2.qzone.qq.com, /cgi-bin/feeds/feeds3_html_more)`；P/H 使用 U | `uin=L, scope=0, view=1, filter=all, flag=1, applist=all, pagenum, count, begintime, externparam` | `data.data[]`、`data.main.externparam/hasMoreFeeds`；混合 HTML 和结构化字段；不是任意好友的全部历史 | P/H/O/W；已接入 |
| R12 | 特别关心动态：同 R11，P 的 `scope=7` 分支 | 只替换来源明确的 `scope`，沿用好友流游标协议 | 不等于特别关心名单接口，也不保证返回全部历史 | P；未接入专门视图 |
| R13 | 用户主页首屏混合流：`U(ic2.qzone.qq.com, /cgi-bin/feeds/feeds_html_module)` | P `i_uin=T, i_login_uin=L, mode=4, version=8, previewV8=1, showcount, refer=2` 等 | HTML 中的数据载荷，P 有专门抽取函数；不能执行页面 JS；目标权限照常生效 | P；未作为完整主页流接入 |
| R14 | 用户主页续页/互动观察：`U(ic2.qzone.qq.com, /cgi-bin/feeds/feeds_html_act_all)` | W `uin=T, hostuin=T, scope=1, start, count, refresh=0, outputhtmlfeed=1, refer=2` 等 | 需读 `host_data/about_data/friend_data/firstpage_data`，不是只读 `data.data`；HTML 只证明已观察互动 | P/O/W；已用于补互动，未做完整主页浏览 |
| R15 | QQ 面板照片/动态流：`U(ic2.qzone.qq.com, /cgi-bin/feeds/feeds2_html_picfeed_qqtab)` | P `uin=L, hostUin=T, fuin`（未给时取 T），`appid=4, begintime, inCharset/outCharset=utf-8` | 与 R11 不是同一动态分页协议，不应把不同流的 key、游标或总数合并猜测 | P；未接入 |
| R16 | 好友照片动态：`U(ic2.qzone.qq.com, /cgi-bin/feeds/feeds2_html_picfeed)` | `uin=L, start, count, begintime, view=1, filter=4, applist=4, json_esc=1` | 照片动态入口，不等于好友相册全量列表 | P；未接入 |
| R17 | 与我相关：`U(ic2.qzone.qq.com, /cgi-bin/feeds/feeds2_html_pav_all)` | `uin=L, scope=1, offset, count, begin_time, end_time, getappnotification=1, getnotifi=1, outputhtmlfeed=1` | 动态/互动 HTML，P 使用 `main.offset/hasMoreFeeds`；不是恢复所有已删除说说的接口 | P；未接入 |
| R18 | 那年今日：`U(ic2.qzone.qq.com, /cgi-bin/feeds/feeds2_html_today_lastyear)` | `login_uin=L, year, mode=1, count, refer=qzone, useutf8=1` | 回顾候选内容；可能混在多个 data 分组；空结果与完整日历覆盖不是同一概念 | P；未接入 |
| R19 | 动态未读计数/部分项目保活：`U(ic2.qzone.qq.com, /cgi-bin/feeds/cgi_get_feeds_count.cgi)` | `uin=L, rd, g_tk` | P 保留 `data` 中 `myFeeds/friendFeeds/specialCareFeeds/aboutHostFeeds/replyHostFeeds` 对应 `_new_cnt`；E 把它用于保活，不证明定期调用必然延长会话 | E/P；未接入此空间入口 |

### 3.3 相册、照片与视频

| ID | 用途、方法与路径 | 关键用法 | 返回与限制 | 来源 / WeQ |
| --- | --- | --- | --- | --- |
| R20 | 相册列表：`U(photo.qzone.qq.com, /fcgi-bin/fcg_list_album_v3)` | `hostUin=T, uin=L, appid=4, needUserInfo=1, idcNum, format=jsonp`；W 使用 `pageNumModeSort=40`，E/P 另有 `pageStart/pageNum/mode` 分支 | `albumListModeSort` 或旧数组；`albumsInUser` 也可能只是数值。不要把前 40 个相册当全部；E 的 3000 页大小不应直接照搬 | E/P/H/W；列表已接入，深翻页策略需另核 |
| R21 | 相册内媒体：`H5(photo.qzone.qq.com, /fcgi-bin/cgi_list_photo)` | `hostUin=T, uin=L, topicId=albumId, pageStart, pageNum, mode=0, appid=4, json_esc=1` | `photoList, totalInAlbum`，含 `lloc/sloc, pre/url, is_video, uploadtime`；访问受限相册需正常权限，不能猜答案 | E/P/H/W；已接入 |
| R22 | 照片详情/视频地址：`U(photo.qzone.qq.com, /fcgi-bin/cgi_floatview_photo_list_v2)` | `hostUin=T, uin=L, topicId, picKey, cmtNum, likeNum, number, prevNum/postNum` | `data.photos`，视频的 `video_info.download_url/url3` 等；W 已用于视频换链，但未表示所有扩展字段都展示 | E/P/W；部分接入 |
| R23 | 相册评论：`U(app.photo.qzone.qq.com, /cgi-bin/app/cgi_pcomment_xml_v2)` | E `uin=L, hostUin=T, topicId=albumId, start, num, order=1, cmtType=1, plat/source=qzone` | 相册层评论；不能与某张照片的评论串在一起；返回封套/完整字段待实测 | E；未接入 |
| R24 | 照片评论：同 R23 的照片参数分支 | E `topicId=albumId_picKey, albumId, start, num, order=1, ref=photo, need_private_comment=1` | 照片层评论；键要取实际相册、照片定位关系，不能从显示文件名拼造 | E；未接入 |
| R25 | 相册详情/权限与问答字段：`U(photo.qzone.qq.com, /cgi-bin/common/cgi_get_albuminfo_v2)` | P `albumId, hostUin=T, appid=4, source/plat=qzone`，其实现 `uin` 也取目标；应与登录凭据身份分开 | P 描述 `question, answer, priv, name` 等；答案仅主人可获取是来源声明，本轮未验；不是绕过访问控制入口 | P；未接入 |
| R26 | 相册存储路由：`U(route.store.qq.com, /GetRoute)` | `UIN=T, type=json, version=2, json_esc=1` | 路由信息供 `idcNum` 等使用；不是媒体下载地址或授权 | E；未接入 |
| R27 | 独立视频列表：`U(taotao.qq.com, /cgi-bin/video_get_data)` | `uin=L, hostUin=T, appid=4, getMethod=2, start, count, need_old, getUserInfo`；E/P 默认值不同 | 视频条目列表；`need_old` 等可改变范围，不能把说说内视频与视频模块数强行相等 | E/P；未接入独立列表 |

### 3.4 访客与空间总数

| ID | 用途、方法与路径 | 关键用法 | 返回与限制 | 来源 / WeQ |
| --- | --- | --- | --- | --- |
| R28 | 空间访问总人次：`U(g.qzone.qq.com, /cgi-bin/friendshow/cgi_get_visitor_simple)` | W 在途实现 `uin=T, mask=1` | `data.modvisitcount[].totalcount/todaycount`；累计人次不等于去重人数、最近访客条数或说说浏览量 | W；开发中 |
| R29 | 相册访客与近期趋势：同 R28 的相册分支 | P/E `uin=T, mask=2, mod=2, contentid=albumId, fupdate=1` | P 注释列出 `modvisitcount, items, calvisitcount`；数组长度/日期位置/统计时区需要核验，不能直接标成完整 30 天历史 | E/P/H；未接入此分支 |
| R30 | 说说/日志/相册/分享单项最近访客：`U(g.qzone.qq.com, /cgi-bin/friendshow/cgi_get_visitor_single)`；K 使用 H5 网关 | E `uin=T, appid, param, beginNum, num, needFriend=1`；说说 `appid=311,param=tid`，日志/日记 `2`，分享 `202`，相册另有 `4,param=2;albumId`；K 的说说请求还带 `blogid/ref` | `totalNum` 与最近条目不是同一规模；K 曾测到只给最近 6 条且翻页无效，此为特定环境观察，不是通用硬上限；主人权限适用 | E/K；未接入 |
| R31 | 空间访问记录：`U(g.qzone.qq.com, /cgi-bin/friendshow/cgi_get_visitor_more)` | E 主人分支 `uin=T, mask=7, page, fupdate=1`；源码还加 `clear=1, sd` | **不是可无脑归类的纯读取**：`clear` 可能清提醒状态；接入只读工具前应核是否可省略及实际影响 | E；未接入 |
| R32 | 另一访客路径：`U(g.qzone.qq.com, /cgi-bin/cgi_right_get_visitor_more)` | O `uin=T, mask=7, format=json` | 与 R31 不同路径；O 只透传结果，不构成完整分页/计数语义验证 | O；未接入 |
| R33 | 说说/照片等概况总数：`U(r.qzone.qq.com, /cgi-bin/main_page_cgi)` | W 在途实现 `uin=T, param=16` | `data.module_16.data.SS/XC`；逐模块核状态；不能用已加载条目数补造总量 | W；开发中 |
| R34 | 访客状态模块：同 R33，P 的另一参数分支 | `uin=L, param=3_L_0` | P 的 `getVisitorStatus` 原样返回，用于访客状态线索；本轮未取得完整 schema，不把它当 R28 的别名 | P；未接入 |

### 3.5 日志、私密日记、留言板、收藏与分享

| ID | 用途、方法与路径 | 关键用法 | 返回与限制 | 来源 / WeQ |
| --- | --- | --- | --- | --- |
| R35 | 日志列表：`U(b.qzone.qq.com, /cgi-bin/blognew/get_abs)`；H 使用 RC | `hostUin=T, uin=L, pos, num, blogType=0, reqInfo, statYear, cateName/cateHex, absType` | `data.list`、总数、分类、月份统计等视变体而定；E 默认当前年份可能限范围，P 传空年份；摘要不等于全文 | E/P/H；未接入独立列表 |
| R36 | 日志正文：`U(b.qzone.qq.com, /cgi-bin/blognew/blog_output_data)` | E `uin=T, blogid, mode=2, numperpage=50, page=1, styledm/imgdm/bdm`，`inCharset/outCharset=gb2312` | 正文载体可能是 HTML；必须按响应字节编码解码并清理主动内容，不能 UTF-8 强解或执行页面脚本 | E；未接入 |
| R37 | 批量日志阅读数：`U(b.qzone.qq.com, /cgi-bin/blognew/get_count)` | `type=1, uinList=T, idList=blogIds` 以 `_` 连接，另带编码/格式字段 | 批量计数要按响应 ID 关系绑定，不能只按数组位置猜配 | E；未接入 |
| R38 | 日志评论：`U(b.qzone.qq.com, /cgi-bin/blognew/get_comment_list)` | `uin=L, topicId=T_blogid, start, num, format=jsonp` | 与日志正文独立分页；不保证回复树完整，需要分别记录观察范围 | E；未接入 |
| R39 | 私密日记标题列表：`U(b.qzone.qq.com, /cgi-bin/privateblog/privateblog_get_titlelist)` | E `uin=L, vuin=L, pos, numperpage, pwd2sig, fupdate=1` | 只按本人正常授权访问；`pwd2sig`/二次验证不能绕过，失败不当空列表 | E；未接入 |
| R40 | 私密日记正文：`U(b.qzone.qq.com, /cgi-bin/privateblog/privateblog_output_data)` | `uin=L, blogid, pwd2sig, private=1`，带正文环境字段 | 敏感正文和票据分离，不把票据写进导出；既有授权不自动涵盖日记采集 | E；未接入 |
| R41 | 日记评论/阅读数/最近访客 | E `diaryComments -> R38`、`diaryReadCount -> R37`、`diaryVisitors -> R30(appid=2)` | **复用接口配方，不是额外的新端点**；仍服从日记本人权限及对象 ID | E；未接入 |
| R42 | 留言板：`U(m.qzone.qq.com, /cgi-bin/new/get_msgb)` | `hostUin=T, uin=L, start, num, format=jsonp`；P 还传 `hostword=0, essence=1, iNotice=0` | `data.commentList, total, auditNum/auditON, authorInfo`；本轮不承诺 `essence` 的筛选语义，需核是否影响全量 | E/P/H；未接入 |
| R43 | 空间收藏：`U(fav.qzone.qq.com, /cgi-bin/get_fav_list)` | `uin=L, type, start, num, need_nick=1, need_cnt` 等；P 类型筛选 `0全部/1日志/2照片/3说说/4分享/5文字/6网页` | `total_num, fav_list`；筛选参数与条目自身 `type` 不是同一枚举；与 QQ 客户端收藏分离 | E/P；未接入 |
| R44 | 分享列表：`https://user.qzone.qq.com/p/h5/pc/api/sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzsharegetmylistbytype` | E `uin=T, spaceuin=T, page, num, isfriend=0, ttype=0` | 该代理路径不使用 U/H5 模板；`page` 起点与实际返回范围需核，不从说说页号规则推断 | E；未接入 |
| R45 | 分享评论：`https://sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzshareget_comment` | `uin=L, hostUin=T, topicId=T_shareId, start, num, order=1, fupdate=2` | 分享评论与说说评论不同对象链；编码/JSONP、权限和总数另核 | E；未接入 |

### 3.6 用户、好友与关系

| ID | 用途、方法与路径 | 关键用法 | 返回与限制 | 来源 / WeQ |
| --- | --- | --- | --- | --- |
| R46 | 空间资料/访问权限线索：`U(base.qzone.qq.com, /cgi-bin/user/cgi_userinfo_get_all)` | `uin=T, vuin=L, fupdate=1`，E 加 `qzonetoken` | E 用业务错误判断访问受限；不能把缺资料字段当拒绝访问的唯一依据；其注释认为 `main_page_cgi` 不够稳定，这不是本轮实测结论 | E；未接入此路径 |
| R47 | 空间用户名片：`U(r.qzone.qq.com, /cgi-bin/user/cgi_personal_card)`；E 用 H5 | `uin=T, g_tk`，可带 `fupdate, rd` | 资料卡字段按实际可见返回；可能与本地 QQ 资料不同，不将“隐藏信息”宣传为可越权获取 | E/P/O；未接入此空间路径 |
| R48 | 批量昵称/头像资料：`https://r.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg` | W 按实际请求 `uins` 列表和 `g_tk`；具体键格式参照 `qzone_people.ts` | 常见按 UIN 为键的返回；公开昵称、好友备注不能混用，不按相似名称认人 | O/W；昵称读取已接入 |
| R49 | 空间好友清单：`U(r.qzone.qq.com, /cgi-bin/tfriend/friend_show_qqfriends.cgi)` | `uin=L, follow_flag=0, groupface_flag=0, fupdate=1` | 权限/字段语义以返回为准；与 WeQ 本地好友表是不同来源，不据此覆盖本地名单 | E；未接入此路径 |
| R50 | 移动端排序好友清单：`https://mobile.qzone.qq.com/friend/mfriend_list` | E `res_uin=L, res_type=normal, count_per_page=10, page_index=0, page_type=0, format=jsonp` | E 此封装只固定首页，不构成完整翻页实现；排序不等于亲密度的确定量化 | E；未接入 |
| R51 | 好友互动/关系时间线索：`U(r.qzone.qq.com, /cgi-bin/friendship/cgi_friendship)` | `activeuin=L, passiveuin=T, situation=1, isCalendar=1` | E 用于关系时间；响应字段和时间语义本轮未实测，不能把推测日期称确切加好友日期 | E；未接入 |
| R52 | 特别关心名单：`https://r.qzone.qq.com/cgi-bin/tfriend/specialcare_get.cgi`，E 走 U | `uin=L, do=3, fupdate=1` | 特别关心名单/相关计数字段；不等于 R12 动态流，不推断被关心者身份 | E/W；已有独立服务接入 |
| R53 | 本人黄钻等会员资料：`H5(vip.qzone.qq.com, /fcg-bin/fcg_get_vipinfo_mobile)` | P `get_all=1, g_tk, inCharset/outCharset=utf-8`，身份来自 cookie | P 原样返回；与 WeQ 已有装扮接口不同，不保证所有会员字段含义/时效可用 | P；未接入此路径 |

## 4. 写入接口：只作研究，不执行

这些路径会改变真实账号或他人可见内容。即便是 POST 超时，也可能已经被服务端接受；不得不核结果就跨路由重试。涉及验证码、权限拒绝、风控或二次验证时，应正常停止/交由本人处理。

以下默认 POST `application/x-www-form-urlencoded`，`g_tk` 常放 query；上传接口的表单格式见 W/H，不能直接把文件路径当 `picfile`。返回成功条件各异，不能只看 HTTP 200、字面 `success` 或“没有抛异常”。

### 4.1 说说与互动写入

| ID | 用途与路径 | 关键用法与成功证据 | 限制与来源 / WeQ |
| --- | --- | --- | --- |
| W01 | 发表文本/图文：`H5(taotao.qzone.qq.com, /cgi-bin/emotion_cgi_publish_v6)`；H/O 使用 U | W/H `hostuin=L, con, syn_tweet_verson=1, feedversion=1, ver=1, ugc_right`；图文用上传结果构造 `richtype/richval`；需明确返回新 `tid` | 公开/好友/自己 W 已支持；H 还有指定名单分支，不能据此称 W 已实现。H/O/W；已接入手动发表 |
| W02 | 上传图片：`https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image` | W `uin/p_uin/zzpaneluin=L, skey/p_skey, picfile=base64, base64=1, uploadtype=1, albumtype=7, refer=shuoshuo` 等；结果需有可用于发表的图片定位信息 | **上传本身已有副作用**，并非只有最终发表才写入。签名 URL/票据不展示给不必要的调用方。H/O/W；已接入 |
| W03 | 编辑说说/改可见范围：`U(taotao.qzone.qq.com, /cgi-bin/emotion_cgi_update)` | `tid, hostuin=L, con, ugcright_id, ugc_right`，H 对部分名单加 `allow_uins`；图片需保留/重组原 `richval/pic_bo` | 仅改权限也不能把正文、图片字段清空；优先先读原对象再精确更新。H/O；未接入 |
| W04 | 转发说说：`U(taotao.qzone.qq.com, /cgi-bin/emotion_cgi_forward_v6)` | O `tid, ouin=T, opuin=L, hostUin=T, topicId=T_tid, con`；H 有 `t1_uin/t1_source/hostuin` 版本 | 两套配方不混拼；转发源、操作者、原帖 ID 必须明确。H/O；未接入 |
| W05 | 评论/转发的旧链路：`U(taotao.qzone.qq.com, /cgi-bin/emotion_cgi_re_feeds)`，O 另有 H5 | O 评论用 `hostUin=T, topicId=T_tid, content`；回复附 `commentId/replyUin`；转发分支附 `forward=1`；H5 变体 topicId 有 `__1` | 同一路径可能评论或转发；不能把它当只读评论接口，未知结果不自动 fallback。H/O；未接入 |
| W06 | 删除说说：`U(taotao.qzone.qq.com, /cgi-bin/emotion_cgi_delete_v6)` | H `uin, topicId, feedsKey, feedsAppid=311, feedsTime, feedsType, feedsFlag`；O 另有 `tid/topicId` 方案 | 必须取真实 feed 句柄/发布时间，不能从展示文字或数组下标推导；删除不可由本工具保证恢复。H/O；未接入 |
| W07 | 点赞/取消赞：`U(w.qzone.qq.com, /cgi-bin/likes/internal_dolike_app)` | `opuin=L, unikey, curkey, appid, typeid, fid, abstime, active, fupdate` | **O 的 like/unlike 主分支都传 `active=0`，不能直接照抄为可靠取消赞**；真实语义需单独验证。H/O；未接入写操作 |
| W08 | 另一点赞链路：`U(taotao.qzone.qq.com, /cgi-bin/like_cgi_likev6)` | O `opuin=L, ouin=T, fid=tid, abstime, appid, typeid`；取消分支 `optype=1` | 不能用跨端或旧版本参数盲目补救 W07；需核目标实际赞状态。O；未接入 |
| W09 | 发表评论（含图片）：`U(taotao.qzone.qq.com, /cgi-bin/emotion_cgi_addcomment_ugc)` | H `uin=L, hostUin=T, topicId=T_tid, commentUin=L, content, private=0, format=fs`；图片 `richtype=1, richval` 取上传结果 | 明确成功返回的评论 `data.id` 才能继续回复；原图上传亦有副作用。H；未接入 |
| W10 | 回复评论：`U(taotao.qzone.qq.com, /cgi-bin/emotion_cgi_addreply_ugc)` | H `uin=L, hostUin=T, topicId, commentId, commentUin, content`，可带图文 `richval` | 根评论 ID、回复 ID、被回复者和操作者要分开，按实际封套核身份。H；未接入 |
| W11 | 删除评论：`U(taotao.qzone.qq.com, /cgi-bin/emotion_cgi_delcomment_ugc)` | H `uin, hostUin, topicId, commentId, commentUin`；O 另用 `hostuin/uin/tid/comment_id` | 不同源码变体存在字段差异，不能自行统一；管理员/作者权限由服务端决定。H/O；未接入 |
| W12 | 删除回复：`U(taotao.qzone.qq.com, /cgi-bin/emotion_cgi_delreply_ugc)` | H `uin, hostUin, topicId, commentId, replyId, commentUin` | 不把删除回复退化成删除根评论；只认实际目标句柄。H；未接入 |
| W13 | SNS 删除评论：`https://sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzsharedeletecomment` | O `hostUin=T, topicId=T_tid, commentId, commentUin, feedsType=100, format=fs, paramstr=2` 等 | 可能以 `frameElement.callback` 返回 `ret/code`；不能执行回调或在 unknown 后重复删除。O；未接入 |
| W14 | 评论点赞：复用 W07，但对象为评论 | H `curkey/unikey=T_tid_commentId, appid=311, opuin=L, fid=tid` | **是同一个端点的评论对象配方，不是新接口**；O 旧功能表曾称未实现，H 源码有构造不等于现网验收。H；未接入 |
| W15 | 删除动态：`U(w.qzone.qq.com, /cgi-bin/feeds/feeds_delete_cgi)` | P body `uin=L, hostUin=T, appid=4, key, type, flag, time, plat/source=qzone`；函数的 `skey` 参数实际写入 `key`，不是登录 skey | P 固定 `appid=4`，不能把它当泛用删除说说接口，删除时间线与删除原件也不一定等价。P；未接入 |

### 4.2 相册、留言与日志写入

| ID | 用途与路径 | 关键用法与成功证据 | 限制与来源 / WeQ |
| --- | --- | --- | --- |
| W16 | 创建相册：`U(photo.qzone.qq.com, /cgi-bin/cgi_create_album)` | O `hostUin=L, albumname, albumdesc, priv, format=json` | 旧相册接口族有失败记录；权限枚举不照搬说说的 `ugc_right`。O；未接入 |
| W17 | 删除相册：`U(photo.qzone.qq.com, /cgi-bin/cgi_del_album)` | O `hostUin=L, topicId=albumId, format=json` | 破坏性；不能因为读相册接口可用就称删除接口可用。O；未接入 |
| W18 | 旧删除照片：`U(photo.qzone.qq.com, /cgi-bin/cgi_del_photo)` | O `hostUin, topicId=albumId, lloc=photoId` | 旧路径，权限由服务端核；不与批量删除拼接混用。O；未接入 |
| W19 | 单张/批量删照片：`U(photo.qzone.qq.com, /cgi-bin/common/cgi_delpic_multi_v2)` | H/P `albumid, hostUin, uin, priv, codelist, ismultiup, resetcover`；H 单张定位包含 `lloc/sloc/priv` | 必须取原相册权限和原定位字段，不能固定写默认权限；可能连带影响封面。H/P；未接入 |
| W20 | 发表留言：`U(m.qzone.qq.com, /cgi-bin/new/add_msgb)` | H `uin=L, hostUin=T, content, signin, format=fs, json=1` | 与读取留言板分开授权；成功后核真实新增留言身份。H；未接入 |
| W21 | 删除留言：`H5(m.qzone.qq.com, /cgi-bin/new/del_msgb)` | H `hostUin=T, idList=messageId, uinList=authorUin, format=fs, json=1` | ID 列表和作者列表必须对应，不用操作者代替留言者。H；未接入 |
| W22 | 发表日志：`RC(b.qzone.qq.com, /cgi-bin/blognew/add_blog)` | H `uin=hostUin=L, title, html, cate, rightType, blogType=0, format=fs, json=1` | 正文是 HTML，需净化；日志 `rightType` 和说说权限枚举不同；新 `blogid` 是关键结果。H；未接入 |
| W23 | 编辑日志：`RC(b.qzone.qq.com, /cgi-bin/blognew/mod_blog)` | H 基于发表参数追加 `blogid`；标题、正文、分类、权限要保全 | 先读原件且保留历史；不能为了改标题覆盖正文。H；未接入 |
| W24 | 删除日志：`RC(b.qzone.qq.com, /cgi-bin/blognew/del_blog)` | H `uin, hostUin, idList=blogId, blogType, format=fs, json=1` | 破坏性、权限受限；不承诺存在回收/恢复 API。H；未接入 |

### 4.3 不可跨模块混用的权限值

H 的说说发布/编辑构造器列出 `ugc_right=1`（所有人）、`4`（好友）、`16`（指定可见）、`64`（自己）、`128`（指定不可见）。其中 `16/128` 还带 `allow_uins`。W 当前手动发表入口只暴露 `1/4/64`。

H 的日志构造器把 `rightType=1/2/3/4` 分别描述为公开/好友/指定/自己。相册 `priv/rights` 是另一套字段。以上都是各源码的语义声明，指定名单和实际可见性必须独立核验，不能仅看保存返回成功。

## 5. 旧路径、移动端备选及历史失败

这些条目用于知道“还存在什么线索”，不是建议在现有路径报错后自动轮询全部变体。第三方项目的历史失败不能外推为该能力永久失效；源码里的 fallback 也不能证明它当前可用。

| ID | 路径及方法 | 源码用法/证据 | 本轮判断 |
| --- | --- | --- | --- |
| B01 | `https://mobile.qzone.qq.com/get_mood_list`，GET | O 文档的移动列表路径：`uin, pos, num, g_tk, format=json` | O 的历史探测记录有 404；本轮未试，不作为默认能力 |
| B02 | `https://mobile.qzone.qq.com/detail`，GET | O `uin=T, cellid=tid, g_tk, format=json`，使用移动 UA/请求头 | 有具体 fallback 代码；响应成功、正文完整、真实对象需另核 |
| B03 | `https://mobile.qzone.qq.com/get_comment_list`，GET | O 探测用 `uin=T, cellid=tid, num, pos, format=json, g_tk` | 仅备选，不照搬 PC `start/topicId` 参数 |
| B04 | `https://mobile.qzone.qq.com/like`，POST | O 从 `friendUin/cellid` 构造 mood URL，body `unikey, curkey, appid, typeid, active, fupdate=1`，query `g_tk` | **写入**；移动 `active` 语义不可套给 PC W07 |
| B05 | `https://mobile.qzone.qq.com/del_comment`，POST | O `cellid, comment_id, format=json`，query `g_tk` | **破坏性写入**，unknown 后不可自动补发 |
| B06 | `U(photo.qzone.qq.com, /cgi-bin/cgi_list_album)`，GET | O `uin=T, hostUin=T, format=json, inCharset/outCharset=utf-8` | 与 W 的 `/fcgi-bin/fcg_list_album_v3` 不同；O 曾记录 photo 接口族 500 |
| B07 | `U(photo.qzone.qq.com, /cgi-bin/cgi_list_photo)`，GET | O 曾在相册列表失败后用它 fallback，未带正常照片 `topicId` | 不能把此回退输出默认视为可靠相册名单；W 当前 `/fcgi-bin/cgi_list_photo` 另列 R21 |
| B08 | `U(photo.qzone.qq.com, /cgi-bin/cgi_floatview_photo_list_v2)`，GET | O `uin=T, topicId, picKey='', num, pageStart=0` | 与 W 的 `/fcgi-bin/...` 路径不同，不互相背书 |
| B09 | `http://upbak.photo.qzone.qq.com/cgi-bin/upload/cgi_upload_image` 及旧 IP 上传备选 | O 文档有 HTTP 备用；W 上传表单 `backUrls` 中也留有该主机和 `http://119.147.64.75/cgi-bin/upload/cgi_upload_image` | **上传写入/明文传输风险**；本轮不请求、不改成 IP 直连、不建议自动回退；不把签名/凭据送往未经核验备用点 |

## 6. 腾讯旧前端仅登记的请求名

T 的 MoodRequest 3.0 根据 CGI ID 拼接 `emotion_cgi_<ID>`，读请求还可能按 `emotion_cgi_location` 返回的 `taotao/sh.taotao` 路由选域。脚本仍能下载，只能证明静态文件存在，不能证明这些旧服务今天可用。

本节没有找到足够完整的调用方参数或返回 schema，**不提供猜测出的工作请求**。名称中的英文含义仅作为检索提示，不据此许诺功能。已有较完整调用的 `msglist_v6/get_pics_v6/getcmtreply_v6/get_fullrelay_v6` 已放在前面，不在这里重复计数。

| ID | CGI ID / 路径线索 | 能确认的证据 | 未知项 |
| --- | --- | --- | --- |
| C01 | `get_mix_v6` | T 路由 switch 中登记 | 对象、筛选、分页和返回内容 |
| C02 | `urlinfo_v6` | T 路由 switch 中登记 | URL 参数、可访问目标范围、响应 |
| C03 | `get_timershuoshuopics_v6` | T 路由 switch 中登记 | 定时说说上下文、权限、图片键 |
| C04 | `get_tweet_msgs_v6` | T 路由 switch 中登记 | 数据类型和历史服务状态 |
| C05 | `get_tweetsset_v6` | T 路由 switch 中登记 | 具体用途及是否有状态副作用 |
| C06 | `mutireplies_v6` | T 检查编号 `uin` 参数以决定路由 | 批量请求数组/编号格式、上限、回复 ID |
| C07 | `muticomments_v6` | 同 C06，名称以源码拼写为准 | 批量评论请求 schema、完整性边界 |
| C08 | `multitopcomments_v6` | 同 C06 | 顶层评论或精选含义不能仅凭名称确定 |
| C09 | `shuoshuoinfo_v6` | T 按 `data.uin` 选路由 | 与详情接口的差别、请求和响应 |
| C10 | `comment_v6` | T 的操作统计 ID 映射中出现 | **疑似评论写入**，未找到完整 body，不应调用 |
| C11 | `delcomment_v6` | T 的操作统计 ID 映射中出现 | **疑似删除**，评论对象/权限/结果未知 |
| C12 | `addreply_v6` | T 的操作统计 ID 映射中出现 | **疑似写回复**，不可套用 `_ugc` 的 body |
| C13 | `delreply_v6` | T 的操作统计 ID 映射中出现 | **疑似删除回复**，不可套用 `_ugc` 的 body |
| C14 | `http://bp.taotao.qq.com/cgi-bin/emotion_cgi_location` | T 实际 GET 构造 `uin`，可带源码拼写 `souce`；读 `result.code/idcNo` | 历史 HTTP 路由服务；本轮未请求，不建议默认启用 |
| C15 | `like_cgi_getlikev2` | O 的用户/功能说明中作为旧点赞名单来源提及 | 本轮没有取得足够请求参数；不能当 R10 的等价替换 |

## 7. 辅助接口与基础设施

| ID | 用途与路径 | 用法及限制 | 来源 |
| --- | --- | --- | --- |
| X01 | 坐标转地址：`https://apis.map.qq.com/ws/geocoder/v1` | `location=lat,lng, key=腾讯地图开发者Key`；将坐标发送给地图服务，有隐私、额度和服务条款边界 | E `lbsInfo` |
| X02 | 坐标系转换：`https://apis.map.qq.com/ws/coord/v1/translate` | `locations=lat,lng, type=来源坐标系, key`；必须先知道坐标系，不因结果看似合理就声称已准确定位 | E `toTxLbs` |

登录基础设施不是内容接口。O 有浏览器扫码登录、cookie 导入和会话检查；H 使用自己的二维码登录封装；W 通过现有 `WebCredentialProvider` 获取和刷新域票据，并有 clientKey/ptlogin2 通路。不要为接入上述业务接口另建未经审查的登录旁路，也不要把静态脚本中的旧 HTTP 登录/跳转示例拿来传当前凭据。

`probeCapabilities`、`getPostsStrict`、`getPostDetailBestEffort`、`getCommentsBestEffort`、`getLikesBestEffort`、`getProfileStrict`、DOM 抽取和缓存查询是 SDK 包装或组合策略，不是额外的腾讯服务端端点，因此不另计接口数量。

## 8. 常见调用流程

以下是设计流程，不是已执行操作。`L/T` 使用符号身份；没有真实账号、票据或签名 URL。

### 8.1 看完整的一条说说

1. R01 分页得到 `tid` 和原始正文/媒体字段，保留是否截断的证据。
2. 确有全文缺口时研究 R02；R03 只作为单独验证的旧变体，不自动假定可用。
3. 图片总量大于当前返回量时研究 R04，核顺序与唯一定位键。
4. 有原始 `voice.url` 才按 R05 换链，不从 tid 伪造语音参数。
5. R07 读根评论/回复，R09 读计数，R06 按需读转发名单；明确每个字段的来源。
6. 导出报告区分正文完整性、互动覆盖、原件/预览/缺失，不把“任务完成”当“全量取得”。

### 8.2 批量读取日志

1. R35 分别确定年份/分类/总数，不保留“默认当前年”却把导出叫全部历史。
2. R36 取得正文，按 GBK/GB2312 等实际编码解码；HTML 经过白名单清理。
3. R38 分页读评论，R37 按实际 ID 批量核计数；R30 最近访客不是全部访客历史。
4. 日记 R39/R40 是独立敏感范围，不能从“导出日志”的授权隐含扩入。

### 8.3 查看照片及讨论

1. R20 列相册并确认分页范围，R21 获取每册媒体。
2. R22 为实际照片定位键获取详情或视频本体 URL，不按“本页任一视频”猜配。
3. R23 读相册讨论，R24 读照片讨论，分别绑定对象。
4. R29 的累计计数、近期按日计数、最近访客条目分别展示，不相互补造。

### 8.4 动态与回顾

好友动态用 R11（特别关心候选用 R12），某个用户主页用 R13/R14，与本人相关用 R17，历史回顾用 R18。它们是不同集合，不能用“某一流没有返回某帖”推断该帖被删，也不能用它们的并集数量冒称完整账号历史。

### 8.5 安全构造一个读取请求

示意代码仅构造 URL，不发送网络请求，也不接收真实凭据：

```ts
const query = new URLSearchParams({
  uin: '<TARGET_UIN>',
  pos: '0',
  num: '20',
  ftype: '0',
  sort: '0',
  code_version: '1',
  format: 'json',
  g_tk: '<IN_MEMORY_GTK>',
});
const url = new URL(
  'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6',
);
url.search = query.toString();
// 实际接入时由现有账号服务提供 cookie、请求上限、取消和业务响应检查。
```

`URLSearchParams` 负责编码；不要先手工编码 `unikey` 再让它二次编码。`<.>` 等分隔符属于原始值，按接口约定构造后整体编码一次。

## 9. 接入前的核验清单

1. 对象与身份：`L/T`、作者/转发者、根评论/回复、相册/照片是否准确绑定。
2. 授权：只取本人或当前账号正常可见内容；权限不足就停止，不绕过验证码、密码或平台限制。
3. 副作用：即使 GET 也核 `clear`、通知已读、访问上报；写操作必须用户主动触发，unknown 不自动重放。
4. 成功条件：业务码、对象 ID、必需结构都核对；明确零、缺字段和失败分别处理。
5. 分页：首尾页、空页、短页但总数仍有剩余、重复页、游标不前进、变化总数均有测试。
6. 完整性：接口声明总数、已读取去重项、未解析项、权限受限项、剩余范围分别记录。
7. 媒体：签名过期、原件/预览、视频封面/本体、语音格式分开；URL 有效不等于已下载成功。
8. 安全：不执行远端 JS/HTML；资源代理校验域名、协议、端口和重定向，防 SSRF、本地文件读取与凭据跨域泄漏。
9. 主题和 UI：沿用 WeQ 现有深浅色变量，覆盖空、加载、部分失败、未知和取消状态。
10. 来源：保存接口版本、解析器版本、来源字段和必要原始证据；业务原文与票据分离，不把导出正文变成登录信息备份。
11. 验收：mock/单测、编译、真实只读接口、GUI、导出文件核验分别记，不互相替代。

## 10. 已知矛盾与不应照搬的实现

- O 的旧功能表对留言板/日志的覆盖落后于 P/H 源码；本文以具体源码构造为证据，不把跨项目状态直接合并为统一可用清单。
- O 的相册文档记过 photo 旧接口 500，不否定 W 当前不同 `/fcgi-bin/` 路径已有实现；也不证明旧写接口今天恢复。
- O 的取消点赞主分支与点赞传相同 `active`，不能因为函数叫 `unlikeEmotion` 就相信请求已经表达取消。
- E 的 `visitorList` 主人分支带 `clear=1`；P 的不同读取封装有 `iNotice/notice` 等字段，应核语义而非按“GET”宣称零副作用。
- H/P 有把缺失业务码默认为成功、把缺失总数默认为零的便利封装；WeQ 接入时不应复制这种无法区分失败的语义。
- O 的某些详情回退来自列表或已观察 HTML；回退成功不能证明全文、全部评论或全部附图已取得。
- E 的部分列表按当前年份、极大页大小或固定首页构造；这些是该版本调用选择，不是服务端保证。
- K 的“最近 6 个访客”等是作者特定环境实测，不能作为所有账号的固定规格，也不应据此启动高频采集来累积名单。
- `-10000` 在不同模块可能涉及风控、参数或票据；不能统一无限刷新凭据。W 某些已存在的错误分类也是实现现状，不是本轮重新验证的服务端定义。
- 源码中的主机、HTTP 备选、IP、默认权限和回退路径都是研究对象，不因被列进本文就获准上线、调用或扩大数据采集范围。

## 11. WeQ 对照入口与后续建议

| 本地源码 | 当前职责 |
| --- | --- |
| `packages/service/src/account/web/qzone.ts` | 说说、好友动态、JSON/对象字面量安全解析 |
| `packages/service/src/account/web/qzone_comments.ts` | 有界结构化评论读取及已观察互动补充 |
| `packages/service/src/account/web/qzone_interaction.ts` | 动态 HTML 互动观察、计数、点赞名单 |
| `packages/service/src/account/web/qzone_forwards.ts` | 精确转发名单与总量/可见量分离 |
| `packages/service/src/account/web/qzone_album.ts` | 相册、照片和视频地址 |
| `packages/service/src/account/web/qzone_people.ts` | 按准确 UIN 读取空间昵称 |
| `packages/service/src/account/web/qzone_publish.ts` | 已有手动图片上传与说说发表 |
| `packages/service/src/account/web/credential.ts` | 域凭据、身份会话和有界换票 |
| `packages/service/src/account/web/index.ts` | 账号级 facade |
| `packages/service/src/account/export/qzone_export.ts`、`qzone_history.ts` | 已有空间内容导出与原始响应历史 |
| `apps/desktop/src/main/ipc/routers/qzone.ts` | 原生页面 RPC、身份校验、取消 |
| `apps/desktop/src/renderer/src/views/QzoneView.tsx` | 原生空间展示 |

主线程在途的 `qzone_stats.ts`、`reportedViewCount` 等以其后续实际修复和验证记录为准，本文不改动它们。

若只扩展查看/导出，优先研究 R02/R04（正文和图片完整性）、R23/R24（照片讨论）、R05（语音），其次 R18/R17（回顾与互动入口）。日志、留言板和空间收藏按独立栏目规划。写入目录和仅登记目录默认不进入实施范围。

本文只新增文档；没有提交或推送主线程的未提交功能修改，没有构建、安装、发布或进行真实账号接口验收。
