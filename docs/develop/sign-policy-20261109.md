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

1. **三端一致**：`needSign` 继续写 `boolean`。
2. **平台有差异**：写 `{ linux, win32, darwin }`，**三个字段都必填**，不要回落到别的
   平台（macOS 实测证明回落会算错）。
3. 平台一致且多端都签时用 `SIGN_NON_LINUX`；三端不一致的单独声明。
4. 分发时统一走 `sign-policy.ts` 的 `needSignFor(policy, platform?)`，不要在业务代码
   里手写 `process.platform` 判断。

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

## 代码结构

```ts
// packages/protocol/src/sign-policy.ts
export type NeedSign =
  | boolean
  | { linux: boolean; win32?: boolean; darwin?: boolean };

export const SIGN_NON_LINUX: NeedSign = { linux: false, win32: true, darwin: true };

export function needSignFor(policy: NeedSign, platform = process.platform): boolean;
```

- `invokeOidb` / `invokeTrpc` 在分发时解析 `spec.needSign`；
- `invokeLegacyOidb` 用 `options.needSign`，调用点显式声明；
- `highway-client.ts` 的 `HttpConn.0x6ff_501`、`ntv2-upload.ts` 的上传申请直接调
  `needSignFor`。

## 复核

```bash
# 在当前平台全量重测（Linux 需要 root / CAP_NET_RAW 抓包）
pnpm sign:probe

# 只测差异命令
pnpm tsx scripts/probe-sign.ts --cmd 0x6d6_2 --cmd 0xfe1_2 --cmd HttpConn.0x6ff_501
```

改完 `needSign` 后，Linux 和 Windows 都要各跑一轮；不要在单平台上推导另一个平台。
