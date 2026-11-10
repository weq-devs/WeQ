# 签名策略按平台区分（2026-11-09）

`needSign` 之前只按 Linux 实测标注。issue #126 在 Windows 上用
`scripts/probe-sign.ts` 全量复测后发现 QQ 的签名集合和 Linux 不同：Linux 19 条、
Windows 42 条，而且全部差异都是「Linux 不签、Windows 会签」。

**不能取并集**：Linux 上多发不必要的签名（多带 `SecInfo`）曾经触发风控。WeQ 借的是
同机 QQ 的凭据，在哪个平台就应该模仿哪个平台的 QQ —— 于是改成按平台分别声明。

> 探测方法：QQ 注入 nnphook hook 后，通过 `\\.\pipe\mojo.<pid>.control`（Linux 是
> `mojo.<pid>.control.sock`）让 QQ 本体组帧发出，同时用 `nt_helper.startCapture` 抓
> 网卡解密，读 SSO reserved 的 tag 24（`SecInfo`）。只关心有没有 `SecInfo`，签名
> 长度 / `SecToken` / `SecExtra` 会随构建和 QUA 变化。

## 规则

1. **策略只在 `sign-policy.ts` 的 `SIGN_RULES` 里登记**，以 wire 命令为键；
   spec、service、界面层都不再各自声明 needSign。
2. **三端一致**用 `sign: 'all'` / `'non-linux'` / `'not-darwin'`；三端不一致才写
   `{ linux, win32, darwin }`，**三个字段都必填**，不要回落到别的平台（macOS 实测
   证明回落会算错）。
3. 不签名的命令可用 `sign: 'none'` **显式登记**，不触发未登记警告；查不到仍按
   不签名 + mode 3 处理，并打一条 warn，提醒核对新命令的实际策略。
4. 分发统一走 `transport.ts` -> `resolveSign(cmd, platform?)`，业务代码里**不要**
   手写 `process.platform` 判断，也不要直接调 `nt.sendOidbPacket` / `nt.sendPacket`。

## 实测集合

### Linux（19 条，2026-11-09 复测，与 2026-11-05 一致）

`0x6d9_4`、`0x89a_0/15`、`0x102a_0/1`、`0x10c8_1/2`、`0x112a_2`、`0x112e_1`、
`0x11ec_1`、`0x9082_1/2`、`0x93d7_1`，以及 raw 侧的：

- `MessageSvc.PbSendMsg`
- `trpc.msg.msg_svc.MsgService.SsoReadedReport`
- `trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg`
- `trpc.group.long_msg_interface.MsgService.SsoSendLongMsg`
- `trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg`
- `trpc.qqhb.qqhb_proxy.Handler.sso_handle`

### Windows 额外会签（23 条）

在 Linux 的 19 条之外，Windows 还会签：

| 命令 | 代码落点 |
| --- | --- |
| `0x6d6_2` / `0x6d6_3` | 群文件下载 / 删除 |
| `0x8fc_3` | 设置群名片 |
| `0xa80_1` | 设置群消息策略 |
| `0xe37_800` / `0xe37_1200` / `0xe37_1700` | 私聊文件 finalize / 下载 / 上传 |
| `0xfd4_1` | 好友名册 |
| `0xfe1_2` | QQ 等级 / 在线状态 / 云端资料 |
| `0xfe5_2` / `0xfe7_3` | 群消息策略 / 在线群成员 |
| `0x10c0_1` / `0x10c0_2` | 加群请求拉取 |
| `0x11e9_200` / `0x11ea_200` | 视频下载地址 |
| `0x126d_200` / `0x126e_200` | 语音下载地址 |
| `0x902e_1` | 收藏表情详情 / 改备注 / 排序 |
| `0x11c4_100` / `0x11c5_100` | 图片上传申请（群 / 私聊） |
| `HttpConn.0x6ff_501` | highway 会话 |
| `OidbSvc.0x480_9_IMCore` / `OidbSvc.0x42d_4` | 旧 OIDB 资料 / 共同好友 |

`0xfe1_2` 三处调用（`get-user-qq-level`、`status`、`cloud-profile`）现在共用同一份
策略：Linux 不签、Windows 签；删掉了 `cloud-profile.ts` 里写死的 `true`。

### macOS（41 条，2026-11-09 实测，QQ 6.9.x / wrapper.node x86_64）

macOS 的签名集合**既不是 Linux 的子集，也不完全等于 Windows**：

- 覆盖 Windows 全部 23 条额外命令；
- **额外签** `0x11e9_100`（私聊视频上传）——Windows 两轮探测都没覆盖这条，
  旧文档推测"按同族 `0x11ea_100` 处理"（即不签）是错的，macOS 实测会签；
- **不签** `0x9082_1` / `0x9082_2`（贴表情回应）——Linux 与 Windows 都签，
  这是 macOS 版 QQ 的真实平台行为，命令正常发出、reserved 里就是没有 `SecInfo`，
  复测稳定。

据此把 `0x9082` 改为三端显式声明 `{ linux: true, win32: true, darwin: false }`，
`ntv2-upload.ts` 的 `0x11e9_100` 三端（Windows 待补测）按签名处理。

macOS 探测方法：注入 nnphook 的 `libqq_hook.dylib`（`DYLD_INSERT_LIBRARIES`，
QQ.app 需 ad-hoc 重签并带 `allow-dyld-environment-variables` +
`disable-library-validation`），socket 在 `$TMPDIR/snowluma-hook/` 下，名字带
`snowluma-hook` 前缀。`scanSessionMaterial`（读 d2key）需要 `sudo`。

关键：x86_64 上 `nt::MSFService` 是抽象基类，活对象是派生实例，vptr 指向派生
vtable；hook 按「vtable[36] == SendSSO 包装器」识别派生 vtable，再按对象内
ASCII uin 逐字节匹配挑出当前会话的那个实例。

### highway 动态命令

`ntv2-upload.ts` 的上传申请命令来自 `params.oidbCmd`，不能用一个布尔覆盖：

- Windows：图片 `0x11c4_100` / `0x11c5_100` 签；
- Windows：语音 / 视频 `0x126d/126e_100`、`0x11ea_100` 不签；
- macOS：图片 `0x11c4_100` / `0x11c5_100` 签，**私聊视频 `0x11e9_100` 也签**，
  群视频 `0x11ea_100` 不签；
- Linux：以上全部不签。

`0x11e9_100`（私聊视频上传）两轮 Windows 探测都没有覆盖，先按 macOS 实测的
「签」处理，待 Windows 补测。

## 代码结构（2026-11-09 重构后）

策略集中在 `packages/protocol/src/sign-policy.ts` 的一张**以 wire 命令为键**的表里：

```ts
export const SIGN_RULES = {
  'MessageSvc.PbSendMsg': { sign: 'all', mode2: true },
  'OidbSvcTrpcTcp.0x9474_0': { sign: 'none' },
  'OidbSvcTrpcTcp.0x6d6_2': { sign: 'non-linux' },
  'OidbSvcTrpcTcp.0x9082_1': { sign: 'not-darwin', mode2: true },
} as const satisfies Record<string, SignRule>;

resolveSign(cmd, platform?) -> { needSign, mode }
oidbCommand(command, subCommand) -> 'OidbSvcTrpcTcp.0x6d6_2'
```

- `sign`：`'all'` / `'none'` / `'non-linux'` / `'not-darwin'`，或三端逐端对象
  `{ linux, win32, darwin }`。
- `mode2`：该命令用完整签名（VM mode = 2，见本文件后面的 mode 分组）。Linux 恒按 3；
  **该命令在这个平台上不签名时也按 3** —— native 的 `sec_info` 直接返回 None，
  mode 根本不会被用到，报 2 等于宣称一个没有依据的值（`0x9082_1/2` 在 macOS 就是
  这种情况：不签名，mode 未知）。
- 显式登记 `sign: 'none'` 的命令返回 `{ needSign: false, mode: 3 }`，不报警；
  未登记命令沿用同一缺省参数，但每个命令仍提醒一次。
- `transport.ts` 是**唯一**分发点：`sendOidb` / `sendPacket` 自己按命令查表，调用方
  默认什么都不用传。`override` 只给 `scripts/sso_send.ts` 的 `--sign` / `--no-sign`。
- spec 上不再有 `needSign` 字段；`invokeOidb` / `invokeTrpc` / `invokeLegacyOidb` 都只管
  编码解码与发包。
- 防漂移：探测数据独立放在 `scripts/sign-probe-commands.ts`，可以离线导入，不运行
  native 或抓包。`test/sign_policy.test.ts` 双向检查 OIDB / raw 清单、真实导出的 spec、
  动态子命令、媒体上传及直发入口；每条必须有策略或明确的待确认原因。

### 已有不签名策略的显式登记（2026-11-10）

完整清点 149 条现有清单命令，84 条已有不签名声明的命令显式登记为 `sign: 'none'`，
包括群待办列表、QQ 秀、图片下载 rkey 与私聊输入状态；43 条至少一个平台需要签名；
另外 22 条在 `UNCONFIRMED_SIGN_COMMANDS` 列出原因，不把默认 false 当成已确认策略。
待确认命令仍按原默认参数发包并提醒一次，警告中附带待确认原因。

已有声明中仅依据旧白名单的条目、Windows 私聊视频与 mode=2 的未验收项另行列出。
这次静态清点和离线回归不代表新增三端抓包验收。完整分级、清单及补测要求见
[签名策略完整清点](./sign-policy-inventory-20261110.md)。

同时补回原平台实测文档已记录、中央表却漏掉的三个 raw 命令：
`HttpConn.0x6ff_501`、`OidbSvc.0x480_9_IMCore`、`OidbSvc.0x42d_4`，均为 Linux
不签、Windows / macOS 签。这三条在 Windows / macOS 的发包参数因此得到修正，
其余显式不签名登记及待确认入口不改原发包参数。

## macOS Core 探测续验（2026-11-10）

QQ 7.0.3-54395 arm64 的本轮活动发送路径是真实命中的
`MSFCoreService::SendSSORequest`，不能用旧 NG `SendSSORequestInternal` 的五参数 ABI
代替。hook 使用 QQ 原生选择器返回的共享 owner，并核对当前镜像、SessionInit 写入依据、
账号字段和发送槽；命令字符串按 Apple alternate libc++ 布局构造。

`probe-sign.ts` 新增 `--authorization-helper <绝对端点>`，复用已安装助手抓包；
`--iface` / `--port` 可显式覆盖捕获接口和端口策略。TUN 场景下，默认路由网卡并不
一定是 QQ 连接的实际出口，应查询 QQ 当前连接的目标路由，而不是固定使用 `en0`。
报告保留实际网卡、收包/帧统计及本轮观测命令，便于区分未发出、错误网卡和解析失败。

若系统 `taskgated` 拒绝普通 native/助手读 QQ 内存，可使用已获调试能力的本机 LLDB
只读提取本轮物料，传 `--session-material-file`。该 JSON 形如
`{"pid":123,"d2Key":"<32位十六进制>"}`，脚本核对 PID 与 key 格式；文件应为私人临时
文件，用后删除，不把 key 写入命令行、日志或版本库。这不要求关闭 SIP。

本轮两次定向运行均完整匹配以下五条真实请求，协议均为 13，签名正对照通过：

| 命令 | macOS 观测 |
| --- | --- |
| `0x102a_1`（正对照） | 签名，sign/token/extra 长度 28/12/28 |
| `0xfe1_2` | 签名，长度同上 |
| `0xfe1_3` | reserved 完整解析，无 tag 24 |
| `0x9067_202` | reserved 完整解析，无 tag 24 |
| `0x7ed_12` | reserved 完整解析，无 tag 24 |

这是五条定向请求的当前版本记录，不将其扩展为 149 条全量或其他平台的验收。

## 签名器 VM mode

`mode` 是签名状态机的入参，**只在 macOS / Windows 的 VM ABI 里有**；Linux 传非默认值
只会打一条 warn（见 nt_helper `src/sign/vm.rs`）。

- `mode = 3`（默认）：精简签名，Windows 28 字节 / macOS 28 字节；
- `mode = 2`：完整签名，Windows 96 字节 / macOS 92 字节。

分组依据是 issue #126 的 macOS 全量实测（按 `SecInfo.sign` 长度分两档）：Windows 15 条、
macOS 13 条，交集 13 条（差集是 macOS 不签的 `0x9082_1/2`）。这 13 条在表里标
`mode2: true`：

`MessageSvc.PbSendMsg`、`0x6d9_4`、`0x89a_15`、`0x9082_1/2`（**仅 Windows**，macOS
不签名所以 mode 未知）、`0x93d7_1`、
`0x10c8_1/2`、`0x112a_2`、`0x112e_1`、`0x11ec_1`、
`trpc.msg.msg_svc.MsgService.SsoReadedReport`、`...SsoC2CRecallMsg`、
`trpc.group.long_msg_interface.MsgService.SsoSendLongMsg`、
`trpc.qqhb.qqhb_proxy.Handler.sso_handle`。

> ⚠️ **该分组是按签名字节数推断的，不是服务端行为证据**。上线前需要逐条验证
> 「mode=2 的完整签名能被服务端接受」；验证不过就把那一行的 `mode2` 去掉。

nt_helper 侧接线：`signPacketWithToken` 早就支持 `mode`；`send_oidb_packet` /
`send_packet` / `build_sso_packet` 的 `mode` 入参在 nt_helper v2.5.4 起才有。WeQ 要把
`native/pinned.json` 更新到含该改动的构建，`mode=2` 才真正生效。

## 复核

`scripts/probe-sign.ts` 现在区分四种结果：`signed`、`unsigned`、`parse-error`、
`not-captured`。只有 SSO 头、正文边界与 reserved 完整解析且没有 tag 24，才输出
不签名；空/重复/错类型的 SecInfo、截断 protobuf 和未知协议均保留为解析失败。
捕获帧必须命令和正文都与本次请求匹配，不再只按命令名取第一帧。

查询类优先提供现有协议 spec 编码出的真实正文，并包含一个已知会签名的查询作正对照：

```bash
# query-requests.json 是数组，每项为 { cmd, bodyHex, isUid? }
# OIDB 的 bodyHex 为 inner body；raw 命令为完整业务正文，允许显式空字符串
pnpm tsx scripts/probe-sign.ts --requests query-requests.json --control 0x102a_1 --json new-result.json

# 旧 --cmd 模式仍使用占位正文，只用于对应输入下的通道诊断
pnpm tsx scripts/probe-sign.ts --cmd 0x6d6_2 --cmd 0xfe1_2 --cmd HttpConn.0x6ff_501
```

`--requests` 与 `--cmd` 不能混用。OIDB 信封与 native `OidbBase` 对齐，UIN-form 使用
tag 12；不再写无关的 tag 6。默认候选清单含消息发送、资料修改、通话和旧模型，
查询探测不直接批量触发这些入口；写入类通过 QQ 正常操作的实际包补证。

已知实际端点时可用 `--control-socket <绝对路径>`，不必枚举整个 runtime 目录。
路径按 UTF-8 字节预检：macOS 最多 103 字节、Linux 最多 107 字节，均为末尾 NUL
保留空间；超长路径会在读取物料和抓包之前拒绝，避免将连错端点误报成未捕获。

JSON 报告使用顶层 `format: 'weq-sign-probe-v1'`，逐命令结果在 `results`；包含平台、
时间、正对照、请求正文来源及 SHA-256、匹配帧数、解析失败原因与清理异常，不保存
会话物料、请求正文或签名字节。报告仅新建，使用 0600，不覆盖已有文件。启动失败也
保存真实原因，不能把空 `results` 当作全部不签名。退出码 1 表示运行或正对照失败，
2 表示仍有未捕获/解析失败/清理异常，0 表示本轮全部请求取得有效观测。

脚本不替 QQ 注入 hook；它会执行所给清单中的请求，因此查询复核使用明确的查询
清单。需要已注入并上线的 QQ，以及当前平台实际可用的抓包、取物料条件。
连接或握手失败也会释放本脚本已启动的抓包。
macOS 可复用现有带 `com.apple.security.cs.debugger` 的 WeQ / Electron 读取端，以
`ELECTRON_RUN_AS_NODE=1` 运行脚本；目标 QQ 调试副本需有 `get-task-allow`。普通 Node
即使提权，也不等于拥有该读取能力，不能仅凭旧 `task_for_pid` 报错就要求关闭 SIP。
改完 `needSign` 后需分别取得对应平台的证据，不在单平台推导其他平台；正对照成功和
签名字节长度均不能代替 `mode=2` 的服务端业务接受验证。
