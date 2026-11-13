# 主动操作类协议能力（2026-10-19）

把 SnowLuma 的 OneBot action 背后的协议实现搬进 `@weq/protocol` / `@weq/service`，
补齐 WeQ 之前缺的「主动操作」命令。本文记录**放在哪一层、命令号、签名判定**，
以及哪些还在真机验证中。

## 分层

| 类型 | 放哪 | 原因 |
| --- | --- | --- |
| OIDB / trpc / highway 编解码 | `packages/protocol` | 只依赖 native 的通用发包接口 |
| 需要 cookie + p_skey + bkn 的 HTTP CGI | `packages/service/src/account/web` | 复用 `WebCredentialProvider` / `withRetry` / `webRequest*` |

`protocol` 内部按域分目录（每个目录 `index.ts` 显式 re-export）：

```
src/oidb/group-admin/   群管理（改名 / 管理员 / 群名片 / 头衔 / 精华 / 头像 / 禁言 / 踢人 / 退群 / 加群选项 / 分类标签 / @全体 / 在线成员）
src/oidb/group-file/    群文件列表 / 下载地址 / 删除 / 重命名 / 移动 / 文件夹 / 数量与空间
src/oidb/group-album/   群相册媒体列表 / 删除 / 点赞 / 评论 / 动态详情
src/oidb/interaction/   戳一戳 / 贴表情 / 表情回应人 / 内联按钮 / 群打卡
src/oidb/request/       加群申请 / 好友申请 / 可疑好友申请
src/oidb/profile/       QQ 等级 / QQ 秀 / 资料卡赞 / 在线与输入状态 / 个人资料 / 头像
src/oidb/custom-face/   收藏表情
src/oidb/group-todo/    群待办
src/oidb/misc/          OCR / 解密密钥 / clientKey / rkey / pskey / Ark / AI 语音 / 群报名
```

消息类（`src/msg`，含 `SsoReadedReport`）、文件发送（`src/file`）、传输（`src/highway`）保持原位。

## 签名策略

在线状态写入统一使用 `oidb/profile/status.ts` 的 `SetOnlineStatus`，根导出、账号写操作和在线状态服务共用同一实现；旧 `oidb/set-self-profile.ts` 路径仅重导出，不再维护第二套状态协议。`StatusService.SetStatus` 不在白名单中，不额外签名。普通状态的默认电量值沿用上游 100，显式传入的扩展状态、电量 0 保留上 wire；旧 `{ custom: { faceId, wording, faceType } }` 参数兼容映射到 `customExt`，与 `SetDiyOnlineStatus` 共用校验和回包处理。非零 `errCode` 不论有无错误文案均抛错，成功文案 `set status success` 不被误判为失败。

> **2026-11-03 起白名单推导已移除**：`src/sign/whitelist.ts`（照抄 LagrangeV2
> `BotSignProvider.cs` 的 `WhiteListCommand`）删除，`needSign` 改为显式登记在签名表里，
> 没有兜底（查不到即不签名并打 warn）。依据是 `scripts/probe-sign.ts` 的真机实测——连已注入的 QQ
> 的 pipe 发包，抓包读 SSO reserved 的 tag 24（`SecInfo`），看 QQ 自己写不写。
>
> **2026-11-09 起按平台分别声明**：Linux 与 Windows 的签名集合不同（Linux 19 条 /
> Windows 42 条），macOS 实测前先跟 Windows。**禁止取并集**——Linux 上多发不必要的
> 签名曾触发风控。**2026-11-09 晚重构**：策略集中到 `sign-policy.ts` 的 `SIGN_RULES`
> 一张以 wire 命令为键的表里，spec 不再各自声明 `needSign`，`transport.ts` 统一查表
> 得到 `(needSign, mode)`。实测记录见
> [sign-policy-20261109.md](./sign-policy-20261109.md)。

白名单**不可作为依据**，2026-11-05 复测（每条三次一致）发现两侧都不符：

| 情形 | 命令 |
| --- | --- |
| 在名单里、QQ 实际**不签** | `0x5d6_6`、`0x5d6_19`、`0x8fc_3`、`0xa80_1`、`0x10c0_1/2` |
| 不在名单里、QQ 实际**会签** | `0x6d9_4`、`0x9082_1/2` |

**Linux 会签的完整集合**（2026-11-09 复测，19 条，与 2026-11-05 一致）：
`0x6d9_4`、`0x89a_0/15`、`0x102a_0/1`、`0x10c8_1/2`、`0x112a_2`、`0x112e_1`、
`0x11ec_1`、`0x9082_1/2`、`0x93d7_1`，以及 raw 侧的 `MessageSvc.PbSendMsg`、
`SsoReadedReport`、`SsoC2CRecallMsg`、`SsoSendLongMsg`、`SsoRecvLongMsg`、
`trpc.qqhb.qqhb_proxy.Handler.sso_handle`。

Windows 在上述 19 条之外还会签 23 条（见 issue #126 与
[sign-policy-20261109.md](./sign-policy-20261109.md)），代码里写
`SIGN_NON_LINUX` 或按命令传 `{ linux: false, win32: true }`。

改了 `needSign` 或新增命令后，跑 `pnpm sign:probe`（或 `pnpm tsx scripts/probe-sign.ts
--cmd <命令>`）复核，别照抄白名单；有平台差异时一定要分别在对应平台跑。

**探测脚本的平台差异**：`probe-sign.ts` 两边都能跑，传输层自动按平台选——
Linux/macOS 走 Unix socket（`mojo.<pid>.control.sock`），Windows 走命名管道
（`\\.\pipe\mojo.<pid>.control`，pid 直接枚举 `\\.\pipe\` 发现）。Windows 前提是
QQ 已注入 hook、装了 Npcap 且以管理员身份运行；`--disconnect`（砍 MSF 长连接看
断连时是否仍签）只有 Linux 实现。

动态 subCommand 的命令（`FetchGroupRequests` / `SetGroupRequest` / `SetReaction` /
`SetPeerPin` / `GroupTodo`）在分发时无法按 sub 分别判定，所以要按实际会签情况整族标注。

## 命令清单（本次新增）

### OIDB / trpc

| 功能 | 命令 | needSign |
| --- | --- | --- |
| 标记已读 | `trpc.msg.msg_svc.MsgService.SsoReadedReport` | true |
| 收藏表情列表 / 删除 | `Faceroam.OpReq` | false |
| 收藏表情详情 / 改备注 | `0x902E_1` | Linux false / Windows true |
| 收藏表情移到最前（position=1） | `0x902F_1` | false |
| 添加收藏表情 | `ImgStore.BDHExpressionRoam` + highway cmdId 9 | false |
| 点击内联按钮 | `0x112E_1` | true |
| 群打卡 | `0xEB7_1` | false |
| 群文件删除 / 重命名 / 移动 | `0x6D6_3 / _4 / _5` | `_3` Linux false / Windows true；`_4/_5` false |
| 群文件夹新建 / 删除 / 重命名 | `0x6D7_0 / _1 / _2` | false |
| 群文件数量 / 空间 | `0x6D8_2 / _3` | false |
| @全体剩余次数 | `0x8A7_0` | false |
| 在线群成员列表 | `0xFE7_3` | Linux false / Windows true |
| 用户在线 / 扩展状态 | `0xFE1_2` key 27372 | Linux false / Windows true |
| 设置在线 / 自定义状态 | `trpc.qq_new_tech.status_svc.StatusService.SetStatus` | false |
| 设置输入状态 | `0xCD4_1` | false |
| 设置个人头像 | highway cmdId 90 | — |
| 个人资料 / 长昵称 | `0x112A_2` | true |
| 群待办 设置 / 完成 / 取消 | `0xF90` sub 1/2/3 | false |
| 群待办列表 | `0x9474_0` | false |
| 群分类标签 查询 / 添加 / 删除 | `0x967C/D/E_0` | false |
| 设置加群选项 | `0x89A_0` | true |
| 退群 | `0x1097_1` | false |
| 群相册媒体删除 | `QunMedia.DeleteMedias` | false |
| 群相册点赞 / 取消 | `FeedsWriter.DoQunLike` | false |
| 群相册评论 | `FeedsWriter.DoQunComment` | false |
| 群相册动态详情 | `FeedsReader.GetQunFeedDetail` | false |
| 好友申请 同意 / 拒绝 | `0xB5D_44` | false |
| 可疑好友申请 列表 / 拒绝 / 同意 | `0xD69_0` / `0xD72_0` | false |
| 加群请求 拉取 | `0x10C0_1/2` | Linux false / Windows true |
| 加群请求 处理 | `0x10C8_1/2` | true |

### HTTP CGI（service/web）

| 功能 | 端点 |
| --- | --- |
| 发送群公告 | `POST web.qun.qq.com/cgi-bin/announce/add_qun_notice` 或 `add_qun_instruction` |
| 删除群公告 | `POST .../announce/del_feed` |
| 上传公告图片 | `POST .../announce/upload_img`（multipart） |
| 群打卡列表 | `POST qun.qq.com/v2/signin/trpc/GetDaySignedList` |
| 群相册图片上传 | `FileBatchControl/{md5}` + 16 KiB 分片 `FileUpload` |
| Qzone 点赞 / 取消 | `internal_dolike_app` / `internal_unlike_app` |
| Qzone 评论 | `emotion_cgi_re_feeds` |

## 已实现、未重复搬

群精华、设置群名片、修改群名称、修改群头像、设置群头衔、全员禁言、群相册列表、
群公告读取、Qzone 发表 / 上传图片 —— 这些 WeQ 原本就有。

## 明确未做

**获取在线客户端**：三个参考仓库都没有可用的主动命令。

- SnowLuma 只有 `0x210` / subType 349 的**被动推送快照**，`get_online_clients`
  在 `no_cache` 时直接失败。
- LagrangeV2 白名单里只有 `StatSvc.GetDevLoginInfo` 这个**命令名**，没有实现。
- WeQ 没有常驻收包 API；`startCapture` / `takeFrames` 是一次性窗口抓包，不适合做
  主动查询。

需要时再补，前提是先拿到 `StatSvc.GetDevLoginInfo` 的请求/响应抓包。

## 真机待验证

- `0xEB7_1`：SnowLuma 历史上发大写 `0xEB7_1`，native 固定小写；SnowLuma 注释称
  服务端两种都收，需真机确认。
- `StatusService.SetStatus`：不在白名单，本次按不签发送；若被拒，回退
  `StatSvc.SetStatusFromClient`（在名单里）。
- `internal_unlike_app`（取消点赞）：SnowLuma 标注未实测。
- 群相册视频上传：本次只做图片；视频需要封面探测（SnowLuma 依赖 ffmpeg），
  WeQ 不引入该依赖，等有需求时再让调用方传封面。
