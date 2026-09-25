# 发消息（MessageSvc.PbSendMsg + 富媒体上传 + 文件）

> 实现：`packages/protocol/src/msg/send*.ts`（协议层）、
> `packages/protocol/src/highway/*`（媒体与文件上传）、
> `packages/protocol/src/file/*`（文件管线）、
> `packages/service/src/account/message_send.ts`（`MessageSendService`）、
> `apps/desktop/src/main/mcp/tools.ts`（MCP 工具 `send_text_message` /
> `send_media_message` / `send_file_message` / `send_rich_message`）。
>
> 相邻的**轻互动**（戳一戳 / 贴表情）不走这条管线，见
> `packages/protocol/src/oidb/send-poke.ts`、`set-reaction.ts`、
> `packages/service/src/account/interaction.ts` 与 MCP 的 `send_poke` /
> `set_message_reaction`。

## 一、它是什么

发消息走**原始 SSO 命令** `MessageSvc.PbSendMsg`（没有 OIDB 信封），三个场景共用同一条
命令，只差 `routingHead` / `contentHead`：

| 场景 | routingHead | contentHead | 备注 |
| --- | --- | --- | --- |
| 群聊 | `grp.groupCode` | `{ type: 1 }` | 不带 c2cCmd，也不带 ctrl |
| 私聊 | `c2c.{uin, uid}` | `{ type: 1, c2cCmd: 11 }` | 带 `ctrl.msgFlag`（Unix 秒） |
| 群临时会话 | `grpTmp.{groupUin, toUid}` | `{ type: 1, c2cCmd: 11 }` | 带 `ctrl.msgFlag` |

消息体是 `messageBody.richText.elems[]` —— 一个 `Elem` 数组。

## 二、元素：收侧解码器的镜像

发送端**没有**另写一份 schema：`msg/send-elements.ts` 产出的就是收侧
`msg/decode.ts` 解出来的同一批结构，编码交给同一个 `protobuf.encode`。

```
decode: bytes --decode(ELEM)--> proto 树 --lift--> { kind, ... }
encode: { kind, ... } --build--> proto 树 --encode(ELEM)--> bytes
```

好处：`decodeMessage()` 的 `elements` 可以**直接再发出去**（搬运、转发），不需要中间结构。
测试里有一条自解码往返就是钉这个性质。

已有的类型：

| kind | wire 形态 | 需要上传 |
| --- | --- | --- |
| `text` | `elem.text.str` | 否 |
| `at` | `elem.text` + `pbReserve`(3=type/4=uin/9=uid) | 否 |
| `face` | 老 `elem.face` / commonElem svc 33 / svc 37 | 否 |
| `mface` | `elem.marketFace`（16 字节 GUID） | 否 |
| `reply` | `elem.replyElement`（嵌套 `origElementsRaw`） | 否 |
| `ark` | `elem.lightApp.data`（deflate + 0x01 头） | 否 |
| `xml` | `elem.richMsg.template1`（同上） | 否 |
| `markdown` | commonElem svc 45 + MarkdownData | 否 |
| `poke` | commonElem svc 2 + PbElem{type} | 否 |
| `forward` | `elem.lightApp`（`com.tencent.multimsg` 卡片） | 否 |
| `image` | commonElem(48, 20).pbElem = msgInfo | **是** |
| `record` | commonElem(48, 22).pbElem = msgInfo | **是** |
| `video` | commonElem(48, 21).pbElem = msgInfo | **是** |
| `raw` | 直接给 `Elem` proto 对象（逃生舱） | — |

## 三、媒体上传：0xE37_100 申请 + highway TCP 传字节

媒体元素不能直接拼出来 —— 得先把文件传到 QQ 的富媒体服务，拿回 `msgInfo`，
**那份 msgInfo 字节就是 `commonElem.pbElem`**（收侧 `PIC_COMMON_PB` /
`PTT_COMMON_PB` / `VIDEO_COMMON_PB` 解的是同一个结构）。

```
                 ┌─ 0xE37_100（OidbSvcTrpcTcp.0x11c4_100 等，uin-form）
                 │   fileInfo(尺寸/md5/sha1/类型) + extBizInfo(场景/文案)
                 │   → 回 uKey / ipv4s / msgInfo / subFileInfos
上传一张图 ──────┤
                 └─ 有 uKey 时：highway TCP PUT
                     POST /cgi-bin/httpconn?htcmd=0x6FF0087&uin=<自己>
                     帧：0x28 | headLen | bodyLen | head | body | 0x29
                     每 1 MiB 一块，串行 + keep-alive；失败重连重发同一块
              →   finalizeMediaMsgInfo() → commonElem.pbElem → PbSendMsg
```

命令号 / cmdId 对照（群 / 私聊）：

| 类型 | OIDB 申请 | highway cmdId（群 / 私聊） | requestId | businessType(场景) | commonElem businessType |
| --- | --- | --- | --- | --- | --- |
| 图片 | `0x11c4` / `0x11c5` | 1004 / 1003 | 1 | 1 | 20 |
| 语音 | `0x126e` / `0x126d` | 1008 / 1007 | 1 / 4 | 3 | 22 |
| 视频 | `0x11ea` / `0x11e9` | 1005 / 1001（封面 1006 / 1002） | 3 | 2 | 21 |

### 几个必须照抄的细节

- **`tryFastUploadCompleted: true`**：资源已在服务端时响应里**没有 uKey**，就不必传字节
  （秒传）。有 uKey 却没有字节时按 `fastOnlyError` 抛错，而不是发一条空消息。
- **`compatQmsgSceneType`**：图片 / 语音是 `群 2 / 私聊 1`（旧版兼容元素分场景），
  视频**固定 2**（连私聊也是 —— 老 `videoFile` 元素没有场景之分，给 1 会让旧客户端
  显示「视频已过期」）。
- **语音的 `bytesReserve` 分场景，形状不同**（真机抓包 2026-09-24）：
  - 群聊：4 字节 `08 00 38 00`，并带 `bytesGeneralFlags`（照抄 NapCat）。
  - 私聊：**33 字节容器**（见下），且**不带** `bytesGeneralFlags`。
  NapCat / SnowLuma 把群聊那 4 字节直接用在私聊上 —— 恰好是容器的最后一格，发出去不报错，
  但 QQ 端私聊语音**画不出波形**（群聊正常）。详见「私聊语音波形」。
- **视频尺寸**：群聊必须带真实宽高（0×0 会让 QQ-NT 安卓端显示「文件已过期」），
  私聊固定 0（服务端 schema 会拒非 0）。
- **视频分块 sha1**：`hash.fileSha1` 是「每个完整 1 MiB 块一条中间态 + 末条整文件 sha1」。
  注意它与闪传 `sha1StateV` 的差别：文件大小正好是 1 MiB 整数倍时条数不同，**不要复用**。
- **波形只是装饰**：时长走 `pttDuration`。有 WAV/PCM 就算真振幅，没有就给一条 30 字节
  合成条（官方静音底 25），不引任何音频解码依赖、也**不因为波形失败而让整条消息失败**。

### 两个「不报错但收端说已过期」的真机坑

这两个都**不会**让 `PbSendMsg` 或 highway 回错（`result=0`、`error_code=0`），只在收端表现为
「图片/语音/视频已过期」：

- **IP 必须小端解**：`ServerAddr.ip` / `IPv4.outIP` 是 `FIXED32`（线上小端），数字里
  **最低字节才是点分串的第一个八位组**。写成大端（`>>> 24` 开头）会把地址字节序整个反过来，
  `NTV2RichMediaHighwayExt.network.ipv4s[].domain.ip` 于是带着一个不存在的节点地址 ——
  上传帧照样拿到 `error_code=0`，但文件不会落到该 uKey 上。参考实现都取小端：
  NapCat `packet/highway/utils.ts:int32ip2str`、Lagrange.Core `Utility/ProtocolHelper.cs`。
- **图片必须带 `extBizInfo.pic` 的 reserve**：群聊 `bytesPbReserveTroop`(tag 12)、
  私聊 `bytesPbReserveC2c`(tag 11)，内容都是 `{ subType }`（照抄 NapCat 的
  `UploadGroupImage` / `UploadPrivateImage`）。漏了服务端不会把文件真正落到该子类型的
  存储桶里。`finalizeMediaMsgInfo` 把服务端响应里的 pic **按 key 补齐**而不是重建，
  就是为了不把这两个字段丢掉。

### 私聊语音波形（2026-09-24 实机定位）

现象：我们自己发的**群聊语音** QQ 端有波形，**私聊语音**是平的。

结论：不是波形字节算错、也不是 `commonElem.businessType`（试过私聊 12，无效、已回滚），
而是 `extBizInfo.ptt.bytesReserve` 的**形状**。用安卓真机抓包（`0x126d_100`）逐字段对出来：

```
05 02 00 01 00                       ← 固定头
04 00 04 <clientRandomId BE32>        ← 该消息的 random（与 upload.clientRandomId / 消息 random 同值）
08 00 04 00 00 00 01
09 00 04 00 00 00 03
0A 00 04 08 00 38 00                 ← 尾部恰好就是群聊那 4 字节
```

即 `0A` 项的内容 = `08 00 38 00`；NapCat / SL 只发了这一格（连长度前缀一并丢），所以私聊
波形不渲染。实现见 `buildPttReserve()`（`src/highway/media-upload.ts`）：私聊走 33 字节容器、
群聊照旧 4 字节，且因为容器内嵌 `clientRandomId`，私聊语音的 `clientRandomId` 必须与
`upload.clientRandomId` **用同一个值**（`makeClientRandomId()` 已提为可注入参数）。

顺带排除的两条（都**不是**原因）：`ptt.waveform` 的振幅字节（服务端把发送端的波形原样带到
收端元素 `45925`，我们群聊/服务端漫游缓存里都能看到真波形）、收端元素缺 `45909/45911/45922`
（群聊也缺，但群聊能画）。

### 秒传（fast-upload）的实测结论

`tryFastUploadCompleted: true` 下，命中与否由**服务端**按「资源是不是真的在」决定：命中 = 响应里
没有 uKey = 不用传字节，`pbElem` 直接用响应回的 msgInfo（与 NapCat / Lagrange 的处理完全相同，
两边也都是靠「无 uKey 就不传」来判定的）。

真机验证（2026-09-24）——结论是**秒传本身可靠，不会把失败掩盖成永久 404**：

| 动作 | native 日志 | CDN 探针 |
| --- | --- | --- |
| 修复 IP bug 前，同一份文件反复重发 | 每次都申请了 `HttpConn.0x6ff_501` 会话（= 服务端每次都给了 uKey） | 每次 `404 file does not exist` |
| 修好后再发那份文件（内容没变） | 同样申请了会话（**没有**因为「见过这个 md5」而跳过） | **200 + 字节与本地逐字节一致** |
| 紧接着再发一次同一份文件 | `0x11c4` 之后**直接** `MessageSvc.PbSendMsg`，没有会话申请 | **200 + 字节一致**（秒传的 msgInfo 是可用的） |

也就是说：上传失败表现为「给了 uKey 但字节没落盘」，不会在服务端留下一个假的「已有」索引，
所以「下次遇到还是 404」的情形并没有出现。

要看某一条到底传没传字节，不用再靠推断：

- 回执自带 **`uploads[]`**（`{ kind, fileName, fileSize, md5Hex, fastUpload }`）——`fastUpload: true`
  就是秒传，一个字节没传；服务层与 MCP 都会带这个字段；
- 账号日志里 `media-upload`（上传链路）/ `media-upload-summary`（每个媒体一行，含 `fastUpload`）两个事件；
- 命中秒传时还会额外记一条 `fileExist=…`（响应 msgInfoBody 的 `fileExist`）。它的语义
  （尤其「为 false 是否正常」）还没验证过，所以**只记不报错**；等有实测样本再考虑拿它当防护。

联调时的素材选择：**验「真上传」必须用内容不同的新文件**（同 md5 会走秒传、字节一个不传；
新文件才能验到 highway 那一段），而**验秒传**正好相反 —— 就用刚刚成功过的同一份文件再发一次。

验尸手法（不依赖任何客户端）：从本地库把该消息的元素挖出来，取出 `pic` 元素里的 fileid，
再用 `get_download_rkeys` 的群图 rkey 直连 CDN —— 上传成功是 200 + 图片字节，
没落盘是 `404 {"retmsg":"file does not exist"}`：

```
SELECT "40800" FROM group_msg_table WHERE "40001"=<msgId>   -- decode_db_blob
https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=<fileid>&spec=720&rkey=<群 rkey>
```

appid 与 rkey 都是「场景 × 媒体类型」绑定的：**群 1407 / 私聊 1406**；rkey 类型
`10/20` = 私聊图/群图、`12/22` = 视频、`14/24` = 语音（见 `account/media_download`）。
注意 `get_download_rkeys` 的 OIDB（`0x9067_202`）**只下发图片那三档**，传语音 / 视频的
类型会 `170019002 Service Failure` —— 要验语音 / 视频得走 `media_url` 的 OIDB 解析。

## 三之二、文件（群文件 / 私聊文件）

文件**不是**富媒体那条 NTV2 管线的分支，而是「老 OIDB 申请 + highway 裸帧 PUT +
发布/发送」，两条场景各不相同：

| 步骤 | 群文件 | 私聊文件 |
| --- | --- | --- |
| 申请 | `0x6D6_0` | `0xE37_1700` |
| highway cmdId | **71** | **95** |
| 额外一步 | `0x6D9_4` 发布成群聊气泡 | `0xE37_800` finalize（拿下载路由） |
| 发出 | （就是那条 OIDB） | `MessageSvc.PbSendMsg`（`trans0x211` 路由 + `msgContent`） |

代码：`packages/protocol/src/file/file-send.ts`（`sendGroupFile` / `sendPrivateFile`），
schema 在 `src/oidb/file-upload-schemas.ts`，highway 扩展在 `src/highway/file-upload-ext.ts`。

### 四个必须照抄的地方

- **群文件发布不能走 `PbSendMsg`**：带 `transElem(elemType=24)` 的发消息会被服务端直接
  `result=79` 拒收。发布是独立的 OIDB `0x6D9_4`（`body` 在 **tag 5**），`info.field5=true`
  是服务端反序列化器认这条分支的判别位、`info.field3` 是 31 位随机数。
- **私聊文件的路由是 `trans0x211 { ccCmd: 4, uid }`**，内容也**不在** `richText.elems` 里，
  而是在 `messageBody.msgContent` —— 一段 `FileExtra { file: NotOnlineFile, field6 }`。
  用常规 c2c 路由 + 元素送文件会被拒收。
- **`FileUploadExt.busiBuff` 只带 `senderUin`**（群文件再带群号），**不要**带旧 `busId:102`：
  带了会让离线文件服务端收下 highway 字节却永远 finalize 不成可下载的文件（大文件必现）。
- **私聊「前 10 MiB」md5 的上限是 `0x98A000`**（10002432），不是 `10*1024*1024`、
  也不是 `10^7`（`hash-file.ts` 的 `FILE_MD5_HEAD_LIMIT`）。用错会让超过该长度的文件
  的前段校验失败：字节传上去了，但永远 finalize 不成可下载的离线文件。

### 秒传与回执（2026-09-24 真机实测）

两条管线都有 `boolFileExist`：为 true 时服务端已按 md5 持有该文件，**跳过 highway PUT**
（一个字节不传）。MCP 回执里的 `fastUpload` 就是它，`fileId` / `fileHash` / `fileName` /
`fileSize` / `md5Hex` 一并返回，便于事后排查。

| 场景 | 申请响应 | native 日志 | 结果 |
| --- | --- | --- | --- |
| 群文件首发（3 MiB） | `boolFileExist=false` | `1750_0` → `HttpConn.0x6ff_501` → `1753_4` | 真传字节（3 MiB 用 2.5s） |
| 群文件重发同一份 | `boolFileExist=true` | `1750_0` → **直接** `1753_4`（无会话申请） | **秒传命中**，换了个新 fileId |
| 私聊文件首发 | `boolFileExist=false` | `3639_1700` → 会话 → `3639_800` → `PbSendMsg` | 真传字节 |
| 私聊文件重发同一份 | `boolFileExist=false` | 同上（又申请了一次会话） | **未命中**，又真传了一遍 |

也就是说：**群文件会按 md5 去重，私聊（离线文件）不会** —— 服务端每次都发一个新 `uuid`。
两个分支的代码是同一条（都只看 `boolFileExist`），所以这是服务端行为，不是我们漏做了什么。

（群文件那张表的 `1750` = `0x6D6`、`1753` = `0x6D9`，`is_uid=true` 只有群文件申请是；
`HttpConn.0x6ff_501` 就是 highway 会话申请，它在不在＝有没有真传字节。）

私聊的 `0xE37_800` finalize 是**尽力而为**：`file` 本身已够收端下载，`field6` 只是加强项。
失败只记日志并照发（回执 `finalized: false`），不让整条发送跟着失败。

**大文件是流式上传**（`FileChunkSource` + 1 MiB 分块），不会把整文件读进内存。

### 与闪传的关系

闪传走的是 `multimedia.qfile.qq.com/sliceupload`（HTTPS + rkey），媒体上传走 highway TCP。
**两者只共享哈希层**（`highway/hash-file.ts`、`sha1-stream.ts`），传输层不共用。

## 四、服务层与 MCP

`MessageSendService`（`packages/service/src/account/message_send.ts`）负责把业务参数翻成
协议参数，四层能力：`sendText`（可带 @ / 引用）、`sendMedia`（图片 / 语音 / 视频）、
`sendFile`（群文件 / 私聊文件）、`sendElements`（逃生舱）。目标 `targetId` 收三种写法：

- 群聊：群号；
- 私聊：**QQ 号**（走本地 `nt_uid_mapping_table` 补 uid）或 **uid**（反查 QQ 号）。

uid 的宽松度分两档：**纯文本私聊不强制 uid**（陌生人也能发第一句），
**媒体必须 uid**（NTV2 上传与路由都按 uid 认人），查不到就如实报错并说明去哪拿。

MCP 四个发送工具（`send_text_message` / `send_media_message` / `send_file_message` /
`send_rich_message`）在生产上应保持 `assistantOnly`（真实发送 = 有外部副作用，按仓库约定不进对外只读 MCP
面板，只给内置助手）；真机联调期间临时摘掉了这个标记（`tools.ts:3366` 有恢复说明），
**联调结束要装回去**。失败一律回 `ok: false` + `result` / `errMsg` / `hint`，
**不把「调用了」当「发成功」**。媒体消息的回执额外带 `uploads[]`（见第三节的「秒传实测结论」）。

同样在真机联调期临时开放的还有两个**轻互动**工具（真实副作用，同样应恢复
`assistantOnly`）：`send_poke`（戳一戳）与 `set_message_reaction`（贴 / 撤表情回应）。
它们**不是消息**，走的是独立 OIDB，与上表的 `poke` 元素（窗口抖动）是两回事：

| 能力 | 协议 | SSO | 说明 |
| --- | --- | --- | --- |
| 戳一戳 | 0xED3_1 | `OidbSvcTrpcTcp.0xed3_1` | 群聊戳成员 / 私聊戳对方，收端是「戳一戳」灰条 |
| 窗口抖动 | 0xED3 之外的 PbSendMsg | `MessageSvc.PbSendMsg` | 私聊消息里的 `commonElem svc 2` 元素，只能私聊且独占一条 |
| 贴 / 撤表情回应 | 0x9082_1 / 0x9082_2 | `OidbSvcTrpcTcp.0x9082_N` | 群消息上的表情回应；`code` ≤3 位 = 小黄脸 id，>3 位 = Unicode 码点 |

查询侧（0x9083_1 某表情的回应人列表、0x9084_1 常用表情目录）**没有对接**；要知道一条
消息当前有哪些回应，读 `get_message_details` 的 `reactions[]`（来自本地库 40062 列）。

这两条都**尚未真机验证**（字段与 SnowLuma / Lagrange / NapCat 三边一致，但没有实发过）。

上传链路会把会话节点与每块 highway 回帧（`errorCode` / `segRetCode` / head hex）写进
账号日志（`logger.info(..., { event: 'media-upload' })`，日志目录见 `getLogDir()`）——
排查「上传成功但收端说过期」时，这是唯一能看到服务端态度的地方。

语音的 WAV→SILK 转换在 app 层（`apps/desktop/src/main/voice.ts` 的 `encodeFileToSilk`，
用已在依赖里的 `silk-wasm`），wasm 不放 `@weq/service`。

## 五、已知缺口

- **文件只做了「上传 + 发送」**：群文件的列目录 / 删除 / 移动 / 重命名还没接（下载 URL 已接）。
  真机已验证：群文件气泡能落进本地库（我们自己的解码器读成 `[文件: <name>]`）、
  3 MiB 文件 md5 与本地一致、重发命中群文件秒传。
- **文件转发（收 → 原样再发）没做**：私聊文件元素能解码（`kind: 'file'`），但 `buildSendElems`
  还不接受它，需要先把 decode 的字段反向映射回 `NotOnlineFile`。
- **私聊文件拿不到秒传**（见上「秒传与回执」实测表）：服务端对离线文件按次发新 `uuid`，
  同一个文件重发也会再传一遍字节。想省流量得自己按 md5 缓存 `fileId`/`fileHash` 后直接重发消息。
- **语音 / 视频的下载 rkey 拿不到**：`0x9067_202` 只给图片（见上）。要做「发完自查」的
  语音 / 视频验收，得先接 `resolvePttUrl` / `resolveVideoUrl` 那条 OIDB。
- **系统表情目录（0x9154_1）没内置**：`superSticker` 的 `packId` / `stickerId` 要调用方给，
  拿不到就别走 svc 37 —— 服务端会把 faceId 静默换一张脸。
- **@ 的显示名**：`at` 元素默认显示 `@uin`，真名由收端解析；想显示群名片得自己查 roster 再传
  `textContent`。
- **没有撤回**：`messageId` / seq 都返回了，但撤回接口还没接。
- **自发消息不会写回本地库**：真机验证过 —— 群里自发消息靠服务端 push 回显入库，
  私聊则可能延迟很久甚至不进（`result=0` + 服务端历史能拉到 ≠ 本地库有）。
  所以前端做发送时必须**自己乐观渲染**，不能等本地库。
- **markdown 是账号级硬限制**：普通账号发的 `commonElem{serviceType:45}` 会被服务端静默丢掉
  （`result=0`，但群里没有 seq/回显；私聊只留一条 `[空消息]`）。markdown 只有官方机器人身份
  （`@tencent-connect/qqbot-nodejs` 那条通道）才发得出去。
