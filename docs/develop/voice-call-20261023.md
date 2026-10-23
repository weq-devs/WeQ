# 语音通话（主动发起）

> 2026-10-23。本文记录 WeQ 通话功能的协议分层、关键字段与实际踩过的坑。

## 1. 能力边界

| 场景 | 支持 | 说明 |
| --- | --- | --- |
| 私聊主动发起 | ✅ | 本文全部内容 |
| 私聊接听 | ❌ | 来电推送由 QQ 本体的 AVSDK 消费，我们借凭据发包，收不到那条 push |
| 群通话发起 | ❌ | 走 OIDB 4752/4753/4754，且要先 `EnterRoom` 才能邀请，与私聊不是同一条路径 |
| 视频通话 | ❌ | 媒体层与信令都有额外字段，当前抓包不足以还原 |

「一收一发」的约束在这里同样成立：所有请求由我们主动发出、响应回到我们自己建的
UDP 套接字。**不需要网卡旁路抓包**（这一点与在线语音转写不同，后者依赖异步 push）。

## 2. 三层结构

```
信令 (TCP, 借 SSO)        开房 → 邀请 → 挂断
   ↓ 拿回 roomId / authKey / authToken / 服务器列表
控制面 (UDP 0x28 GCS)     认证 → 心跳 → 状态上报 → 房间事件
媒体   (UDP 0x5b)         Opus 帧（20 ms 一帧）+ FEC + 质量反馈
中继   (UDP 0x02)         通道注册与保活（补充路径）
```

三条 UDP 流共用**同一个套接字**，靠首字节区分：`0x28` / `0x5b` / `0x02`。

代码位置：

| 层 | 文件 |
| --- | --- |
| 信令 | `packages/protocol/src/call/signaling.ts` |
| 控制面 / 媒体包格式 | `packages/protocol/src/call/gcs.ts` |
| FEC 与质量反馈 | `packages/protocol/src/call/fec.ts` |
| 状态机与收发编排 | `packages/service/src/account/call_session.ts` |
| 主进程接线（UDP / 编解码） | `apps/desktop/src/main/call.ts` |
| 音频重采样与响度 | `apps/desktop/src/main/call_audio.ts` |
| 通话窗口 | `apps/desktop/src/renderer/src/components/CallWindow.tsx` |

## 3. 信令

三条 `trpc.qqrtc.av_appsvr.AvAppsvr.*` 命令，走裸 SSO（不经 OIDB 信封）。
**都不签名** —— 签名白名单里没有它们，多签没有收益。

1. `SsoCreateRoom`：`common{roomId=0, relationId, scene=1, self_info}` +
   `params{audio=1, video=0, ipStack=88(fixed32), media{peer}}`。
   对端 uid 写在 `media.peer` 里，**不是顶层字段**。
2. `SsoInviteUser`：必须带开房回包的 `sessionId`，`scene=4`（邀请，不是开房）。
   回包的 `f4.authToken` 是中继准入凭证，缺了它中继会静默丢包。
3. `SsoLogOut`：`scene=1003`，`reason=2`（用户主动结束）。

### 3.1 两处 fixed32

`ipStack`、以及回包里服务器表的 `ip` / `altIp` 都是 **fixed32**（wire type 5）。
`@weq/protocol` 的 protobuf 运行时只有 varint 与 length-delimited，这两处单独处理：

- 开房请求：`CreateRoom.encodeRequest` 逐字段手工拼参数体；
- 回包：`decodeCreateRoomRspBytes` 用原始字节解析。

**坑**：schema 解码遇到 wire type 不匹配的字段会**整段跳过**，不报错 —— 表现是
「服务器列表是空的」。而 fixed32 在 wire 上小端、这里存的却是网络序 IPv4：
`0x1d ed e9 1d` 是 `29.237.233.29`，按小端读会得到镜像地址。

## 4. 控制面（GCS）

包格式：`28 | headLen(4,BE) | bodyLen(4,BE) | head | body | 29`。

关键 `body_type`：

| bt | 含义 | 备注 |
| --- | --- | --- |
| 1 / 2 | 认证请求 / 响应 | 请求连发两次，幂等 |
| 3 | 房间事件推送 | **核心**，见下表 |
| 15 | 状态上报 | 每 2 秒必发，否则服务端判掉线 |
| 23 / 24 | 心跳 / 心跳应答 | 2 秒一次 |
| 75 | 媒体控制推送 | 携带 codec 协商配置，ACK 要回显配置名 |
| 1003 | 登出 | 挂断时连发 5 次 |

### 4.1 房间事件

| event | 含义 | 我们的状态转换 |
| --- | --- | --- |
| 4 | 服务端回「正在振铃」 | → `ringing` |
| 2 / 3 | 对端进入 / 接受 | → `connecting` |
| 10 | 对端开始送音频 | → `connected` |
| 7 | 对端挂断 | → `ended`（`peer_hangup`） |
| 5 / 8 / 9 | 连接失败 / 超时 / 被踢 | → `ended` |

**接通以 event=10 为准，不以「进入房间」为准** —— 后者只说明对方客户端收到了邀请。

### 4.2 服务器选择

回包给两张表：`type=1` 是 GCS，`type=2` 是中继，两者是**同一批机器的不同端口**
（GCS 8000/8001，中继 8800）。IPv4 与 IPv6 各一套，只用 IPv4（套接字是 udp4）。

其中总有一两台当前网络到不了。策略：从第一台开始，**3 秒内没有认证回包就换下一台**，
成功过的 IP 记住，同进程后续通话优先用它。

## 5. 媒体

### 5.1 帧格式

RS-FEC 帧头 13 字节 + Opus 载荷 + 2 字节尾零。时间戳 = `样本计数器高16位 | 载荷长度低16位`。

**载荷长度写在时间戳的低 16 位里**，接收端就是把它当 `plen` 读的 —— 这是协议设计，
不是巧合。

### 5.2 编码器

用 QQ 自带的 `AVSDKPlugin` 里的 Opus，**不是系统 libopus**：服务端协商的是腾讯
改过内部码表的版本，两边不匹配时对端听到的是噪声。

- linux / macOS：`.so` / `.dylib` 导出表完整，直接 `dlsym`；
- windows：符号没导出，按函数入口字节特征在模块内存里扫，失败退回静态 RVA。

参数与客户端一致：16 kHz / 单声道 / 20 ms / VOIP / 复杂度 10 / 24 kbps。

**linux 的坑**：`AVSDKPlugin.so` 会连带加载崩溃上报库 `libbugly.so`，后者把 GnuTLS
符号留成未定义、指望宿主进程已有。Electron 里 QQ 本体自有那一份，而独立 `.node`
没人兜底，`dlopen` 直接以 `undefined symbol: gnutls_free` 失败。解法是先以
`RTLD_GLOBAL` 把系统 `libgnutls` 加载进来。

### 5.3 质量反馈

每 2 秒一条。前 5 次不带音频接收统计，**第 6 次起带 `penguinsDecState=2`**
（声明支持解码 Opus）—— 对端看到这个之后才会把编码从 SILK 切到 Opus。

### 5.4 发送节拍

20 ms 一帧，对齐到**绝对时间**（`锚点 + n × 20`），不是每次
`setTimeout(20)`：后者会被事件循环抖动越拖越慢，20 秒就能差出好几帧。

单次最多补 2 帧。落后更多说明本机卡了（GC / 休眠），补发只会把一批音频瞬间砸向
接收端，jitter buffer 会当成网络抖动去补帧，听起来断续。

## 6. 音频链路（前端）

```
麦克风 → AudioContext({sampleRate: 16000}) → ScriptProcessor(320) → 640B → IPC → 编码
对端 → IPC → Int16 → 环形队列 → 定时器每 20 ms createBufferSource → 扬声器
```

用 Web Audio 而不是 `<audio>`：通话是连续的 20 ms 流，`<audio>` 的解码 / 缓冲模型
适合整段文件。积压超过 10 帧（200 ms）就丢旧帧 —— 实时比完整重要。

## 7. 实测

真实拨打（大号 → 小号）验证过完整链路：

```
calling → ringing(event=4) → connected(event=10)
对端音频持续到达（41~94 字节/帧，20 ms 间隔）
```

挂断后两端状态都正确收敛，对方即时看到「通话已结束」。

## 8. 未做

- 接听（需要 QQ 本体的来电 push，我们收不到）
- 群通话（OIDB 路径 + 先 EnterRoom）
- 视频（媒体层 `subType=2/3/7` 与信令字段都未还原）
- 音质调优（当前固定 24 kbps，未接带宽自适应）
