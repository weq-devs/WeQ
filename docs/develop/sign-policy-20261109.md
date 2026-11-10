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
- 防漂移：`test/sign_policy.test.ts` 断言表里每条 OIDB 命令都能在
  `scripts/probe-sign.ts` 的命令表里找到，保证新加的策略可复测。

### 已有不签名策略的显式登记（2026-11-10）

`0x9474_0`（群待办列表）、`0xfe1_3`（QQ 秀形象查询）和 `0x9067_202`（图片下载
`rkey`）沿用已有的不签名策略，现在显式登记为 `sign: 'none'`，避免正常调用被误报为
“未登记”。三条命令此前均已在
`probe-sign.ts` 的命令表中；本次只修正登记与提示，不改变发包参数，也不代表新增的
三端抓包验收。既有说明见[群待办协议清单](./protocol-actions-20261019.md)与
`packages/protocol/src/oidb/profile/get-qq-show-url.ts`、
`packages/protocol/src/oidb/misc/fetch-download-rkeys.ts`。

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

```bash
# 在当前平台全量重测（Linux 需要 root / CAP_NET_RAW 抓包）
pnpm sign:probe

# 只测差异命令
pnpm tsx scripts/probe-sign.ts --cmd 0x6d6_2 --cmd 0xfe1_2 --cmd HttpConn.0x6ff_501
```

改完 `needSign` 后，Linux 和 Windows 都要各跑一轮；不要在单平台上推导另一个平台。
