# 图文 Ark 卡片发送（OIDB 0xdc2_34）

> 实现：`packages/protocol/src/oidb/send-tuwen-ark.ts`（协议层）、
> `packages/service/src/account/flash_transfer.ts`（`sendTuwenArkToGroup`）、
> `apps/desktop/src/main/mcp/tools.ts`（MCP 工具 `send_tuwen_ark`）。

## 一、它是什么

`0xdc2_34` 是一条 **IM 发送协议**：构造一张「自定义图文卡片」（标题 + 描述 + 摘要
+ 跳转链接 + 预览图）直接下发到私聊或群聊。请求形状由 Android QQ 9.3.25 抓包 RE 得到
（见源文件头注释），固定字段：

```
appInfo: { appId: 100446242, field2: 1, field3: 0, field5: {field1: 1},
           targetId, content: { flag: 1, title, desc, summary, jumpUrl, previewUrl } }
meta:    { peerType, targetId }        # peerType: 0 = C2C, 1 = 群聊
```

`peerType` / `field3` / `previewUrl` 是 `pb_optional`，**0 / 空值也必须上 wire**，否则
服务端按字段缺失处理。

## 二、响应不是「空 ack」——必须检查业务错误码

这条协议**没有 message_id**（因此无法撤回 / 设精华），但它同样**不是**只有
`errorCode=0` 的空 ack：

服务端把「消息下发结果」放在 **body 的 `result`（tag 1）** 里，而 OIDB **外层**
`errorCode` 即使在下发失败时也仍然是 `0`。也就是说：

> 只看 OIDB 外层 retCode，会把「服务端拒绝下发」当成「发送成功」——静默假成功。

WeQ 的实现把 `result` 里的业务错误码解出来并向上返回：

```ts
const result = await SendTuwenArk.invoke(nt, pid, params);
if (result.errorCode !== 0) {
  // 服务端拒绝：result.errorCode / result.errorMessage / result.detail
}
```

`SendTuwenArk.deserialize` 解出的字段：

| tag | 字段 | 说明 |
| --- | ---- | ---- |
| `result.4` | `errorCode` | 0 = 已下发；非 0 = 服务端拒绝 |
| `result.5` | `errorMessage` | 服务端英文描述，如 `imagent service_error:319_...` |
| `result.6.1` | `detail.message` | 中文文案，如 `消息下发失败(错误码:901501)` |
| `result.6.6` | `detail.source` | 错误来源，如 `imagent error` |

MCP 工具 `send_tuwen_ark` 同样据此返回 `{ ok: false, errorCode, errorMessage, detail }`，
不再无条件回 `ok: true`。

## 三、已知实现缺口：Linux / PC 端发不出去

**现状**：在 Linux（以及 PC）NTQQ 上，这条协议会被服务端拒绝：

```
errorCode = 901501
errorMessage = imagent service_error:319_[oidb] rule type not match appid
detail.message = 消息下发失败(错误码:901501)
```

**原因**：`appId = 100446242` 是 **Android 端图文卡片**（`com.tencent.tuwen.lua` /
`qqconnect.sdkshare`）的 appId。PC 端 imagent 的下发规则（rule type）里没有登记这个
appId，`rule type not match appid` 就是「这个 appId 不属于本平台的下发规则」。

> 这条链路能跑在 PC NTQQ 上，本身就依赖腾讯的一个协议缺口；改成 Linux/PC 能接受的
> 参数，需要先解出 **PC 端 imagent 接受的 appId / rule type**，再把 `AppInfo` 与
> `content` 的字段对齐到那条规则。目前没有可复现的抓包样本，所以补齐难度不小。

**待办（想继续推进时）**：

1. 抓一次 **PC/Android 端自身成功发出的** 图文卡片（同协议 `0xdc2_34`），比对
   `appId` / `field2` / `field3` / `field5` / `content` 的实际取值；
2. 若 PC 端根本不走 `0xdc2_34`（例如改走 `0x93d7` 闪传或 markdown 卡片），就在
   `packages/protocol` 里补对应协议，而不是硬套 Android 的 appId；
3. 在能稳定下发前，MCP 工具保留「返回错误码」的行为 —— 失败要能被调用方看见，
   不要再回到静默成功。

## 四、MCP 暴露范围

`send_tuwen_ark` 是真实发送（有外部副作用）的工具，按仓库约定本该 `assistantOnly`
（只在内置助手里可见）。**这里保留它对外部只读 MCP 面板开放**：图文卡片是纯文本 +
链接的卡片消息，不是可执行的载荷，且工具本身已经把服务端的业务错误码如实透出
（见第二节），外部客户端拿到的是「发失败 + 原因」而不是假成功。已知的
`901501` 缺口意味着它在 PC/Linux 上大概率发不出去 —— 这是有意的行为，别为了
「看起来能用」而把错误码吞掉。

---

[← 返回开发者入口](./index.md)
