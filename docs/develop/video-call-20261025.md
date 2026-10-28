# 视频通话：协议还原与实现

> 2026-10-25。本文记录私聊视频通话的协议细节（全部来自真实抓包），以及
> WeQ 当前实现到哪一步。语音通话的基础见 [voice-call-20261023.md](./voice-call-20261023.md)。

## 1. 与语音通话的关系

视频**不是**另一套协议，而是语音链路上的增量：

| 层 | 语音 | 视频 |
| --- | --- | --- |
| 信令 | `SsoCreateRoom` / `SsoInviteUser` | 同样的两条命令，**换档位**（见 §2） |
| 控制面 GCS | 认证 / 心跳 / 事件 | 完全相同 |
| 媒体 `0x5b` | `subType=1`（Opus） | 多出 `subType=2/3/7`（H.265） |
| 摄像头开关 | — | `subType=4` 空体控制包 |
| 视频保活 | — | `subType=5`，每 2 秒 |

所以 `CallSession` 的状态机、GCS 收发、房间事件全部复用，视频只是在 `0x5b`
的分流里多认几个子类型。

## 2. 发起视频通话：信令档位

**关键坑：视频不靠 `scene` 或 `params.video` 区分。** 实测这两项在语音和视频
通话里都是 `1` / `0`。真正的差异在这几项（2026-10-25 逐字节比对）：

| 字段 | 语音 | 视频 |
| --- | --- | --- |
| `createRoom.params.f3` | 1 | **0** |
| `createRoom.params.ipStack`（fixed32） | 88 | **12656** |
| `createRoom.params.f13` | 1 | **3** |
| `invite.params.f3` | 5 | **15** |
| `invite.params.f4` | 10056 | **10063** |

代码里按场景查表，见 `packages/protocol/src/call/signaling.ts` 的
`MEDIA_PROFILE`。

房间本身是同一套：拿到 `roomId` / `authKey` / 服务器表之后的流程完全一致。

## 3. 媒体包格式

### 3.1 外层（与音频共用）

```
0x5b | totalLen(2,BE) | [3]=subType | [4]=0 | seq(4) | sessionTs(4) | tick(4)
```

- `[9:13]` 是**每方向恒定的会话时钟**（实测 c2s / s2c 各差 1），不是每包变化的
  时间戳；
- `[13:17]` 是每包递增的 tick。

### 3.2 视频载荷（`subType=2/3/7`）

```
视频 RTP 头 6B   pkg_idx | total_pkg | total_fec | ext_fec_byte | gidx | fidx
扩展段 3B        03 03 00（len=3 含自身、type=3、data 1 字节 0x00）
（按 pkg_idx 拼各分片）
sub-header 20B   [0]=20 [1]=帧序号 [2]=方向 [3]=06 [8:12]=时间戳
H.265 Annex B    以 00 00 00 01 开头，**明文**
```

**分片规则**（2026-10-25 21 秒真实通话，451 帧全量统计）：

- 整帧**等分**，末片自然短。单片 payload 最大 1277 B，UDP 包最大 1303 B；
- `total_fec` 恒 0；`pkg_idx` 帧内从 0 递增，`total_pkg` 实测 1–14；
- **`seq` 每片 +1**，整通连续（实测 0…717），不按帧重置；
- **外层 `tick` 帧内恒定**，每帧换一次。

### 3.2.0 `gidx` / `fidx`：16 位帧序号（2026-10-26 修正）

**`fidx` 不是 SVC 层号，是帧序号的高字节。** `gidx` 是低字节，每帧 +1 并在
256 处回绕；`fidx` 从 1 起，跟着回绕 +1：

```
frameIndex = ((fidx - 1) << 8) | gidx
```

真机日志（连续 600 帧，2026-10-25）逐段取样：

| 日志 gidx / fidx | 拼出的帧序号 |
| --- | --- |
| g=0, f=1 | 0 |
| g=249, f=1 | 249 |
| g=43, f=2 | 299 |
| g=243, f=2 | 499 |
| g=37, f=3 | 549 |
| g=87, f=3 | 599 |

每 50 帧一档，全程连续；中途关 / 开摄像头也不重置。同一时刻只有一个 `fidx`
值在发，**不存在「基础层 + 增强层」并行**。

> 早期结论「fidx=1 基础层 / fidx>=2 时域增强层」是错的，代价是一个真 bug：主进程
> 据此丢弃 `fidx>=2` 的帧，而 `lastFrameWasBase` 停在 true 后不再更新 —— 通话到
> 第 256 帧（10 fps 下约 25 秒）之后画面**永久冻结**。发送侧同样踩了这个坑：
> `gidx = frameIndex & 0xff` 且 `fidx` 恒 1，第 256 帧包头从 `g=255/f=1` 跳回
> `g=0/f=1`，帧序号倒退。两侧都已改成 16 位帧序号（`videoFrameIndex` /
> `videoFrameHeader`）。

**sub-header 20 字节**（`pkg_idx=0` 的那片才有，后续分片是裸 Annex B 续）：

| 偏移 | 含义 |
| --- | --- |
| `[0]` | 20，sub-header 自身长度 |
| `[1]` | 帧序号 & 0xff |
| `[2]` | **方向标识**：c2s=`0x00`、s2c=`0x03` |
| `[3]` | 恒 `0x06`（**首帧也是**，早期「首帧 03」是误判） |
| `[4:6]` | 恒 0 |
| `[6:8]` | 码率档 / 帧质量（见下） |
| `[8:12]` | 时间戳，布局随 `[2]` 变（见下表） |
| `[12:16]` | **对端视频流的时间基准**（见下）/ 0（s2c） |
| `[16:20]` | 未还原，实测是 `0..totalPkg-1` 里的一个值 |

时间戳布局：

| 方向 | `[2]` | `[8:12]` | `[12:16]` |
| --- | --- | --- | --- |
| c2s（QQ Linux 发） | `0x00` | 帧 PTS（0,100,200… ms，10 fps） | 对端视频基准，见下 |
| s2c（QQ Windows 发） | `0x03` | 发送方 tick（每帧变） | 0 |

### `[12:16]` 是对端视频流的时间基准（2026-10-26 修正）

2026-10-26 QQ 本体抓包逐帧统计（239 帧）：**对端还没开始发视频时，这个字段恒为
0（前 128 帧）**；收到对端首个视频帧后（该帧 `[8:12]` = `1952894717`），从第 128
帧起改填这个值，**之后整通不变**。

语义是「我跟对端的哪个时间基准对齐」，不是本端接通的 tick。早期实现从第一帧就填
本端的 `mediaBaseTick`，与真实客户端不符 —— 这很可能是对端（尤其手机端）不认我们
视频流的原因之一。

### `[6:8]` 是码率档 / 帧质量（2026-10-26 修正）

来自 `GetVideoFrameQuality()`：`[6]` 是估算码率档、`[7]` 是帧质量。实测值随分辨率
变化 —— 480×270 时 28–33 / 36–41，640×360 时 36–44 / 40–48。对端只拿它做统计，
不参与解码，按真实分布抽样即可。

⚠️ 这个差异踩过坑：早期实现把 `[2]` 恒写成 `0x03`，等于用对端方向的格式发自己的
上行数据。构造侧必须按方向分支。

**没有加密。** sub-header 之后直接是 Annex B 裸流，`ffmpeg` 可直接解码。
解码侧用 `subHeaderSize = frameData[0]` 切头，所以 `[0]` 写错会连带整帧报废。

### 3.2.1 媒体路径：先中继、后直连

真实客户端**不是双发**，是硬切换（同一次抓包实测）：

```
0.0s ── 7.9s   音频 / 视频 / 保活全部只发服务端（中继）
7.9s ── 21.4s  全部只发对端 P2P 直连，服务端一个包都收不到
```

切换点两侧同时发生，且切换后没有任何回退。P2P 地址来自 GCS `bt=9` 的 f7
（16 字节 IPv6）；端口在 `bt=9` 里没有（f8=40666 与实测 47708 不符），真实
客户端是通过额外的 GCS 交互协商的，**这部分我们还没还原**。

实现取的是折中：学到对端端口后先双发 1 秒（`MEDIA_PROBE_MS`）探测，确认直连
有回程再停掉服务端那份；直连静默 2 秒（`MEDIA_DIRECT_TIMEOUT_MS`）自动回落
中继。见 `packages/service/src/account/call_session.ts` 的 `MediaPath`。

### 3.3 摄像头开关（`subType=4`）

17 字节空体，连发两次防丢包：

```
5b 00 11 04 00 00 00 00 00 | sessionTs(4) | tick(4)
```

**协议里没有「开」和「关」的布尔位** —— 两者是同一个包，方向靠「谁发的」区分：
收到一条就说明对端摄像头状态取反。

⚠️ 因此本端**不要**用「收到控制包」直接切换 UI 状态：对端可能发了控制包却出
不来画面（例如 Wayland 下屏幕共享失败）。实现里以「是否真的收到视频包」为准
维护 `videoReceiving`。

### 3.4 视频保活（`subType=5`）

29 字节，每 2 秒**两条**（间隔 40–90 ms）。视频停了还在发，直到挂断 —— 它是
**会话级**的，不是「正在发视频」的心跳。两条用 `body[0]` 区分变体：

```
body[0]=0x02   body[4:8]=自己 tick 的小端      body[8:12]=0
body[0]=0x03   body[4:8]=对端最新 tick 的小端   body[8:12]=自己 tick 的小端
```

`0x03` 那条相当于「我收到你发到某个 tick 了」的回执，对端据此判断直连通断。

body：`[0]=0x02`，`[4:8]` 是 tick 的小端副本，其余为 0。

## 4. 房间事件里的开关信号

「对端开 / 关摄像头」会让 `bt=3` 的 `event=10`（dataChange）**再触发一次**：

| 时刻 | event |
| --- | --- |
| 接通 | seq=2 |
| 开摄像头 | seq=3（比首个视频包早约 1.7 秒） |
| 关摄像头 | seq=4（末个视频包后约 1 秒） |

所以单看事件号分不出「开」还是「关」，得配合 `videoReceiving` 的当前值。实现
里没有依赖这个事件，只用来记日志。

### 4.1 视频流状态握手（`bt=31`）

视频流建立依赖 `bt=31` 的四步状态交换，**不能当成普通未知推送只回 ACK**：

```text
event=4（振铃）
  C→S  bt31 body=0803   （带房间 authKey）
  S→C  bt32 body=0803
  S→C  bt31 body=0806
  C→S  bt32 body=<empty>

S→C  bt31 body=0804
  C→S  bt32 body=<empty>       普通 ACK
  C→S  bt31 body=0805          状态应答，同样带 authKey
  S→C  bt32 body=0805
```

QQ 电脑→电脑和电脑→手机的原生抓包中都能观察到这组状态交换。WeQ 旧实现把
`bt=31` 当成普通未知推送，只回 ACK，缺少 `0803/0805` 这两个有效的状态值。

### 4.2 视频参数是服务端推送（`bt=77`）

对照抓包（QQ 电脑→电脑、QQ 电脑→手机、WeQ→手机）确认：

- `bt=77` **只由服务端下发**，两个原生客户端都是 client→server 0 条；
- head.f5 带 88 字节密钥材料；
- body 有两种形态：13 字节（流索引）和 52 字节（完整视频参数）；
- body.f3 是流索引（0/1/2/3…），服务端会随会话推进持续更新；
- `f14/f15` 与目标端相关：电脑对端样本是 1920×1200，手机对端是 640×480；
- 收到 `bt=77` 后回普通空 `bt=78` ACK 即可，视频载荷仍是明文。

服务端在 `event=10` 接通前就会下发第一条 `bt=77`，说明它不是客户端摄像头
开关公告。客户端不应伪造这条包。

### 4.3 接听前如何知道对端设备

`bt=1` 认证 body 在三份抓包里完全相同，不能用来判断对端。服务端在
`bt=3/event=4` 的 `f2` 子消息里携带了对端媒体描述。实测值：

| 字段 | 对端电脑 | 对端手机 |
| --- | ---: | ---: |
| `info.f6` | 5 | 4 |
| `info.f13` | 700 | 5000 |
| `info.f15` | 10063 | 10064 |
| `info.f16` | 94 | 62 |
| `info.f19` | 0 | 1 |

这些值在接通事件前已经到达；随后服务端再按目标端下发对应的 `bt=77`
（尤其 `f14/f15`）。当前实现不根据本机平台猜测对端，直接按统一状态机应答。

`bt=15` 的 `f133/f134/f135` 在通话阶段会随视频状态变化，当前尚未把所有转移
都还原完整；没有逐字段抓包证据时不要用本地 endpoint 或编码参数现场拼这些字段。

## 5. 实现位置

| 层 | 文件 |
| --- | --- |
| 视频包解析 / 组帧 / H.265 提取 | `packages/protocol/src/call/video.ts` |
| 信令档位 | `packages/protocol/src/call/signaling.ts`（`MEDIA_PROFILE`） |
| 会话收发与状态 | `packages/service/src/account/call_session.ts` |
| 采集档位（分辨率 / 码率，两侧共用） | `apps/desktop/src/shared/call_video_profile.ts` |
| 本端 t265 编码 | `apps/desktop/src/main/call_video_encoder.ts` |
| 上行帧的二进制 IPC | `apps/desktop/src/shared/call_video_ipc.ts` + `main/call_video_ipc.ts` |
| 渲染层采集管线（共用） | `apps/desktop/src/renderer/src/hooks/useVideoCapture.ts` |
| 摄像头 / 屏幕共享取流 | `hooks/useCallCamera.ts` / `hooks/useCallScreen.ts` |
| 放行 `getDisplayMedia` | `apps/desktop/src/main/call_display_media.ts` |
| 渲染层解码（WebCodecs） | `apps/desktop/src/renderer/src/hooks/useCallVideo.ts` |
| 解码的纯逻辑（可单测） | `apps/desktop/src/renderer/src/lib/callVideo.ts` |

关键接口：

- `CallSession.onVideo(listener)` —— 收到完整帧时回调，给 Annex B 裸流；
- `CallSession.setCamera(enabled)` —— 开 / 关本端视频（发控制包）；
- `CallSession.setVideoSource(source)` —— 记录本端画面来自摄像头还是屏幕共享
  （**协议层不发任何东西**，只让 `snapshot()` 能告诉界面）；
- `CallManager.setVideoSource(source)` —— 切采集源并重开编码器（换档位）；
- `CallManager.resizeVideo(w, h)` —— 按源宽高比重设编码尺寸；
- `CallVideoEncoder` —— 主进程注入的编码器，`next()` 吐一帧裸流。

### 5.1 上行帧走二进制 IPC，不走 tRPC（2026-10-26）

采集在渲染层、编码在主进程，中间要传原始 I420 —— 摄像头 640×360 一帧 345 KB，
屏幕共享 1280×720 一帧 1.3 MB。**不要用 tRPC 传它**：tRPC 的 superjson 会把
`Uint8Array` 展开成十进制数字数组（体积 3~4 倍），实测一帧 30 ms，帧率一高渲染层
主线程就被吃满，采集、解码、绘制一起卡（两端画面都卡）。

现在走 `window.weq.callVideo.pushFrame()` → `ipcRenderer.send` 的原生通道，
`Uint8Array` 直接结构化克隆（实测 0.17 ms，快两个数量级），且天然 fire-and-forget。
web 构建（`apps/web` 复用同一份 renderer）没有这个桥，调用方回退到 tRPC 的
`pushVideoFrame`。

## 6. 渲染层解码：参数集必须内联

Chromium 的 WebCodecs HEVC 解码器对 `VideoDecoderConfig.description` 的要求很挑
（2026-10-25，Electron 44 / Chromium 152，Linux + AMD VA-API 实测）：

| 配置 | 结果 |
| --- | --- |
| `hev1` / `hvc1`，**不带** `description`，参数集内联在数据里 | ✅ 52 帧全解出 |
| `description` = Annex B 形态的 VPS/SPS/PPS | ❌ `isConfigSupported` 恒 false |
| `description` = 规范 hvcC（ffmpeg 由同一码流生成） | ❌ 能配置成功，首帧就 `Decoder error` |

**结论：一律走 in-band。** 主进程推来的首帧本来就是
`VPS + SPS + PPS + IDR` 一个完整 access unit，直接按 Annex B 喂进去即可，既不
要剥掉参数集，也不要塞进 `description`。

> 之前的现象是界面显示「当前环境不支持 H.265 解码（试过 6 种）」—— 六个 codec
> string 候选其实都被同一份畸形 `description` 拖垮了，换 level / profile / hev1
> 全都没用。排查时先看 `isConfigSupported` 是「不带 description 也说 false」还是
> 「只在带 description 时才 false」，两者根因完全不同。

### 解码器重建后要补参数集

`decode()` 抛 Error 累计超过 3 次时，hook 会 `close()` 掉解码器重建。**新解码器

- 遇到一个不带参数集的关键帧，会一直抛
  `A key frame is required after configure()`，画面永久黑掉**。实测：不补 -> 0
帧；补上缓存的 VPS/SPS/PPS -> 正常解出。

两个容易写错的地方：

1. 判据不能是「这一帧是不是刚重建的那一帧」。重建点常常落在 delta 帧上，那帧会被
   「未配置就跳过 delta」丢掉，标记跟着一起丢，后面就再也不补了 —— 表现是**静默
   黑屏、不报错**。用一个独立的「还欠一份参数集」标记，挂到真的喂出一帧为止。
2. 参数集要**每帧扫描缓存**，不能只在首帧存一次：编码器可能中途换参数集（分辨率
   变化、重新编码），跟当前 SPS 不符会直接解错。

### 渲染层不能值导入 `@weq/protocol`

`packages/protocol/src/index.ts` 是 `export * from './call'`，而
`call/signaling.ts` → `oidb/invoke.ts` → `transport.ts` → `redbag/sign.ts`
用了 `node:crypto`。renderer 的 vite 构建会把它判成 `__vite-browser-external`：

```
"createHash" is not exported by "__vite-browser-external:node:crypto"
```

所以 `lib/callVideo.ts` 里自备了一份 `splitHevcNals`（二十来行、零依赖），
**有意重复**协议层的实现 —— 协议层那份继续在服务端用。renderer 里对
`@weq/protocol` 只允许 `import type`。

## 7. 未完成

### 7.1 sub-header 未解字段：`[16:20]`

2026-10-26 抓包逐帧统计（双向 335 帧）：

| `totalPkg` | `[16:20]` 取值 |
| --- | --- |
| 1 | 恒 0 |
| 2 | 0–1 |
| 3 | 0–2 |
| 4 | 0–3 |
| 5 | 0–4 |
| 6–8 | 0–total-1 |

也就是说它是 `0..totalPkg-1` 里的一个值，**不是** `totalPkg - 1` 定值（早先这么
填是错的），也不是帧内分片计数。看起来像「帧内第几个分片携带了某个标记」，具体
规则未确认。当前实现用随机值对齐分布。

`[6:8]` 已确认来自 `GetVideoFrameQuality()`（`[6]`=码率档、`[7]`=帧质量，关键帧
整体低一档），对端只拿它做统计，不参与解码，按真实分布抽样即可。

### 7.1.1 关键帧间隔：WeQ 比真实客户端密得多

实测 QQ 本体**一整通 19.8 秒只发 1 个关键帧**（首帧），对端同样只有 1 个。
WeQ 的 `t265` 配置是 `keyint=30`，摄像头档 12 fps 下**每 2.5 秒一个关键帧**，
码流里 I 帧占比高一个量级。

这是「对端看 WeQ 画面卡」的可疑原因之一（I 帧大、瞬时码率尖峰大，弱网下更容易
丢片 → 整帧丢弃 → 等下一个关键帧）。真实客户端显然用了很大的 keyint 或纯按需
插帧，待抓 WeQ 包对比后确认要不要调大。

### 7.1.2 三个让媒体退化成「全程中继」的坑（2026-10-26 实测）

对照 QQ 本体抓包（同样直接拨视频，走 P2P `...:64927`，1919 包）与 WeQ 抓包
（全程中继 `113.250.57.28:8800`，10842 包），挖出三处：

1. **GCS 选到了中继端口。** 服务端下发的 `type` 字段不可信：16 通里 5 通把
   `type=1` 的候选选到了 8800（中继）。认证、心跳、`bt=9` 全发给中继节点，
   而中继**从不给对端的 `f7`（IPv6）**。判据改成按端口：8000/8001 是真 GCS。
2. **服务器回包被学成「对端直连地址」。** socket 是 udp6 双栈，IPv4 来源在
   `rinfo.address` 里是 `::ffff:a.b.c.d`，服务器表里是 `a.b.c.d` —— 直接字符串
   比较永远不等。于是服务器自己的回包把 `peerDirect` 改写成服务器地址，媒体路径
   切到 `direct` 后其实仍发往同一台服务器（同 IP 同端口），「以为直连了，其实
   全程中继」。必须做 IPv4-mapped 归一化再比。
3. **`bt=9` 的形态随服务器角色变化。** 真 GCS 下发的是 `f7`（16 字节 IPv6）+
   `f8`（端口）；中继下发的是 `f1`（fixed32 IPv4 + 端口）且**没有 f7**。所以
   「拿不到 f7」本身就是「连错服务器」的症状，不是另一个独立问题。

三个坑叠加的结果：媒体包全部挤在一条服务端通道上（实测 2 万+ 包），丢包与排队
严重 —— 表现为两端画面都极卡、前 20 秒花屏。

### 7.2 P2P 端口协商

真实客户端会在 GCS 上交换 P2P 端口（对端把包发到本机 55558，正是我们自己的
socket 端口）。我们用 `bt=9` 只能拿到地址、拿不到端口，因此 `server` 阶段学不
到端口时就一直留在中继路径。抓包里还能看到一组 72 字节的 `0x02` 包（cmd=0..3，
每秒两次）在 P2P 地址与本机之间往返，疑似 STUN 式探测 / 应答，字段语义未还原：

```
c2s: 02 00 48 00 01 00 03 75 3f 14 08 b0 b2 6b 80 00 ... 00 03
     ↑  ↑     ↑        ↑  ↑
     0x02|len|cmd=3    |  |  末尾 03 = 序数
                       |  [7:11] 常量
                       [6] 0..3 递增
```

### 7.3 其他

- **群通话 / 被动接听**：与语音通话同样的限制（见 voice-call 文档 §1）。
- **分片尾部 0 填充**：真实客户端等分后末片补 0，但补 0 是否被对端依赖无法从
  抓包证实，当前不补。

## 8. 屏幕共享（2026-10-28）

### 8.1 结论：它就是一路普通摄像头视频

**协议层一个字节都不用改。** 屏幕共享复用摄像头那条完整链路：

| 层 | 是否区分摄像头 / 屏幕共享 |
| --- | --- |
| 信令 `SsoCreateRoom` / `SsoInviteUser` | 不区分 |
| GCS 认证 / 心跳 / `bt=31` 状态交换 / `bt=77` 参数 | 不区分 |
| 媒体 `0x5b subType=2`（主画面） | **不区分** |
| 摄像头开关 `subType=4` / 保活 `subType=5` | 不区分 |

`VideoSubType.screen = 0x07` 是协议里预留的独立子类型，但**没有抓包证据**表明
QQ 本体的「共享屏幕」走它。要单独适配（独立的 `subType=7` 流 + 独立的信令，让
对端弹出「对方正在共享屏幕」的提示）需要重新抓包整条 `switchScreenShare` /
`transformToScreenShare` 链路，代价是数小时逆向；而现状下对端虽然收不到独立
提示，但**能看到完整画面**，功能本身是通的。

因此实现取的是「换采集源」：同一路主视频流，`subType` 不变，只把采集到的像素
从摄像头换成屏幕。

### 8.2 四端采集：一条代码路径

用 `getDisplayMedia`，让 Electron / Chromium 按平台自己选后端：

| 平台 | 实际后端 |
| --- | --- |
| Windows | WGC（Win10 1903+）/ DXGI |
| macOS | ScreenCaptureKit |
| Linux X11 | XDG Portal ScreenCast → PipeWire |
| Linux Wayland | XDG Portal ScreenCast → PipeWire |

⚠️ **Linux 下即使传 `--ozone-platform=x11`（XWayland），采集仍然走 portal。**
2026-10-28 本机（Hyprland / pipewire 1.6.9 / Electron 44.9.1）实测日志里是
`third_party/webrtc/modules/desktop_capture/linux/wayland/shared_screencast_stream.cc`。
也就是说 X11 与 Wayland 在 Electron 里是**同一条代码路径**，不需要像 OBS 那样分
`linux-capture`（XSHM）与 `linux-pipewire` 两套。

实测结果（同一环境）：

```
desktopCapturer.getSources({types:['screen']})  → 1 个源「整个屏幕」，约 10 s
getDisplayMedia({video:true})                    → 1920×1080 @30fps，4 s
连续采样 6 次非黑像素占比                     → 1.000（avg 155）
```

`getSources` 那 10 秒是 portal 弹窗等待用户选择的时间，不是性能问题。

### 8.3 采到的源怎么选

- **Linux / macOS 15+**：交给系统选择器。Linux 的 portal 弹窗由桌面环境提供
  （Hyprland / KDE / GNOME 各自风格），macOS 用 `useSystemPicker: true` 走
  ScreenCaptureKit 的系统选择器；
- **Windows / macOS <15**：主进程用 `desktopCapturer` 取主显示器。

**不要自己画选源面板**：Linux 的 portal 强制弹窗，自己再画一层等于让用户选两次。

### 8.4 参数档位

见 `apps/desktop/src/shared/call_video_profile.ts`，那份文件里有每个数字的来由。

| 档位 | 分辨率 | 帧率 | 码率 | 每像素比特 |
| --- | --- | --- | --- | --- |
| 摄像头 | 640×360 | 15 fps | 30 kbps | 0.014 |
| 屏幕共享 | 960×540 | 15 fps | 1200 kbps | 0.017 |

**摄像头档位与 `dev` 主线保持一致**，不随屏幕共享的实测结论单独调整。屏幕共享
则是 2026-10-28 真机复盘后下调的（原为 1280×720）：真实运动下 720p 的编码 p95 是
58.8 ms，而 15 fps 的帧预算只有 67 ms —— 光编码就吃掉整个预算，对端于是只看到
7.5~10 fps。降低分辨率同时**提高了**每像素比特数，画面反而更清楚。

编码器是 native 的 t265（进程级单例，打开后**不能改参数**），所以切换采集源
只能 `closeVideoEncoder` + 重新打开。实测重开在 1080p 下也只要 ~10 ms，只在
用户点按钮时发生，不需要做增量更新。

采集尺寸按**源宽高比**推导（`fitWithin`）：共享 21:9 超宽屏时是 1280×540，
不是硬塞进 16:9。渲染层算出尺寸后要回头调 `call.resizeVideo` 让编码器对齐 ——
两边尺寸不一致时 `pushFrame` 会因平面长度校验失败而**静默丢帧**，表现是
「点了共享，对方什么都看不到」。

### 8.5 性能：让采集端直出目标尺寸

实测（本机 1920×1080 源，取一帧 → 缩放 → 转 I420）：

| 做法 | 耗时 |
| --- | --- |
| `getDisplayMedia` 给全分辨率，再 `drawImage` 缩到 1280×720 | 45 ms/帧 |
| `getDisplayMedia` 直接要 1280×720（`width/height: {ideal, max}`） | **22 ms/帧** |

所以约束必须带给采集端（`captureWidth` / `captureHeight`），不要在渲染层做完
缩放再转 I420。`willReadFrequently: true` 也能再省 3~4 ms（避免 `getImageData`
从 GPU 回读）。

### 8.6 用户主动停止共享

用户在系统共享栏点「停止共享」时，轨道会静默 `ended` —— 不接这个事件的话，
界面会一直停在「共享中」而且再也收不到新帧。`useVideoCapture` 监听每一条轨道的
`ended`，转成 `onEnded` 回调，`CallWindow` 收到后把采集源切回摄像头。

### 8.6.1 `Invalid capture constraints` 的真实原因（2026-10-28）

共享屏幕失败时渲染层报的是：

```
AbortError: Invalid capture constraints
```

**这个错误名是误导。** 实测对照（Electron 44.9.1 / Hyprland）：

| handler 行为 | 渲染层结果 |
| --- | --- |
| `callback({ video: source })` | ✅ `960x540@15` |
| `callback(null)` | ❌ `AbortError: Invalid capture constraints` |

也就是说这是**主进程拒绝了请求**，跟分辨率 / 帧率约束毫无关系。当时按错误名去改
约束（加 `max`、试 `exact`），全都没用——`exact` 确实不支持，但 `ideal+max` 与
只写 `ideal` 都能正常工作：

| 约束写法 | 结果 |
| --- | --- |
| `{ width:{ideal:960,max:960}, height:{ideal:540,max:540}, frameRate:{ideal:15} }` | ✅ 960×540@15 |
| `{ width:{ideal:960}, height:{ideal:540}, frameRate:{ideal:15} }` | ✅ 960×540@15 |
| `{ width:{exact:960}, height:{exact:540} }` | ❌ `TypeError: exact constraints are not supported` |

真正的 bug 在**「按窗口身份拦截调用方」这个思路本身**。前后试过两种判断，都错：

| 写法 | 结果 |
| --- | --- |
| `request.frame.name === 'weq-call'` | ❌ 实测恒为空串（取的是 `<iframe>` name，不是窗口名） |
| `owner.id !== 主窗口 id` | ❌ 请求本来就来自主窗口 |

真机诊断日志（这是定位的关键）：

```text
ownerId: 1, mainId: 1, frameName: "",
frameUrl: "http://localhost:5173/", frameParent: "top",
windowIds: [2, 1]
```

`frameUrl` 是**主窗口**的 dev server 地址，不是通话窗的 `about:blank`。原因：

**`CallWindow` 用 `createPortal` 把 DOM 渲染进 `popup.document` —— DOM 在子窗口
里，但 JS 执行上下文仍属于主窗口。** 所以 `useCallScreen` 里的
`navigator.mediaDevices` 是主窗口那一份，`getDisplayMedia` 只能从主窗口发出。

结论：**不要按窗口身份拦截**。能走到这个 handler 的，一定是本应用注册了 preload
的渲染进程。现在直接放行。

> 排查口诀：看到 `Invalid capture constraints`，先确认 handler 是不是回了
> `callback(null)` —— 不要被错误名带偏去改分辨率 / 帧率约束。

### 8.6.2 `getSources` 在 Linux 上就是那个 portal 弹窗

`desktopCapturer.getSources({types:['screen']})` 会**阻塞到用户在系统选择器里选完
为止**（本机实测无交互时 33 秒才返回）。它不是「拿到一个已经选好的源」，而是
弹窗本身。

所以：

- handler 里**不要**在它之前做任何耗时的事；
- 必须给它超时兜底（当前 120 秒），否则弹窗被窗口管理器吞掉时这里会永远挂着，
  界面一直转圈且再也发不出新请求。

### 8.7 掉帧复盘：分辨率与采集节拍（2026-10-28）

上线第一版（摄像头 640×360@12fps/300kbps、共享 1280×720@15fps/1.2Mbps）后真机
反馈「对端画面特别卡」。抓包 + 日志定位到**两个独立问题**，都不是码率。

#### 问题一：采集节拍随执行耗时漂移

抓包（65 秒 P2P 通话，`inbound` 与 `outbound` 分开统计）：

| 方向 | 帧数 | 时长 | fps | 分片/帧 | 线路码率 |
| --- | --- | --- | --- | --- | --- |
| 对端 → 我们（服务器中转） | 776 | 64.9 s | **12.0** | 5.7 | 679 kbps |
| **我们 → 对端（P2P 直连）** | 475 | 63.5 s | **7.5** | 3.1 | 208 kbps |

我们上行只有 7.5 fps（目标 12）。逐帧间隔：

```
p50 = 99 ms   (10.1 fps)
p90 = 113 ms
p99 = 1088 ms
平均 = 104 ms (9.6 fps)
>120 ms 的断档 33 次，累计 7.0 秒
```

**分片数完全正常（3.1 片/帧，p95 4）**，所以不是码率也不是分片上限的问题。

根因在 `useVideoCapture`：旧的排程是 `setTimeout(..., 1000/fps)` 排在
`captureOnce()` **之后**，实际周期 = 周期 + 采集耗时 + 抖动，误差逐帧累积。
12 fps 下每帧采集要 5~10 ms，于是 83 ms 变成 99 ms。

改为**绝对时刻排程**：`nextAt += period`，耗掉的时间自动补回来；落后超过一个
周期时（主线程被长任务占了）直接对齐到当前时刻，**不补发积压** —— 实时画面宁可
丢帧也不要延迟。回归测试见 `apps/desktop/test/call_capture_cadence.test.ts`。

#### 问题二：720p 编码吃掉整个帧预算

真实**滚动运动**（不是静态截图反复喂）下的 t265 耗时：

| 档位 | 编码 p50 | p95 | max | 帧预算 |
| --- | --- | --- | --- | --- |
| 1280×720@15 | 20.7 ms | **58.8 ms** | 68.5 ms | 67 ms |
| 960×540@15 | 15.2 ms | 27.8 ms | 48.1 ms | 67 ms |
| 640×360@12 | 2.4 ms | 19.4 ms | 24.3 ms | 83 ms |
| 480×270@12 | 0.6 ms | 15.2 ms | 15.8 ms | 83 ms |

720p 光编码就贴着帧预算，再叠加采集与 IPC 必然掉帧。**这是「对端特别卡」的
主要元凶。**

> ⚠️ **教训：不要用静态截图反复喂来估编码耗时。** 第一次评估时我这么测，720p 只有
> 13 ms/帧，于是放心上线；真实滚动内容下是 33 ms，差了 2.5 倍。屏幕共享的实际
> 负载几乎总是运动（滚动、光标、视频），必须用运动序列测。

#### 现在的档位

屏幕共享下调分辨率后每像素比特数反而上升，画面更清楚：

| 档位 | 从前 | 现在 | 每像素比特 |
| --- | --- | --- | --- |
| 摄像头 | 640×360（0.014） | 640×360（不变） | 0.014 |
| 屏幕共享 | 1280×720（0.012） | 960×540 | **0.017**（+42%） |

摄像头一度也按同样的理由降到 480×270 / 12 fps / 300 kbps，后来按产品要求
**统一回 `dev` 主线口径**（640×360 / 15 fps / 30 kbps）。所以上面「问题一：采集
节拍漂移」的修复对摄像头仍然有效（排程算法与档位无关），但 30 kbps 下画面会偏糊、
640×360 的编码耗时也更高 —— 这是对齐主线时接受的代价，要再调请连同主线一起改。

#### 排障开关：禁用 P2P

抓包里 P2P 直连的上行质量明显不如中继（7.5 fps / 208 kbps vs 12 fps / 679 kbps），
所以加了一个全局设置 `callDisableP2P`（设置 → 基础功能 → 通话录音 → 连接方式）。

置位后：

- `applyPeerEndpoint` 直接返回，不记对端端点；
- `mediaTargets` 永远只返回 GCS；
- 连 `0x02` 打洞探测包也不发（这一条最早漏了，是单测抓出来的）。

> ⚠️ 必须**两个地方都挡**。只在 `mediaTargets` 挡的话，媒体包确实不发对端了，
> 但 `sendPeerProbe` 仍会按 `peerDirect` 打洞 —— 实测会漏出一条 72 字节的
> `0x02` 包，对端仍会以为我们想建 P2P。

开关只在**发起时**读一次：`CallSession` 的媒体路径在生命周期内会变化，中途改会
让已在途的包走两条路。

## 9. 码率：为什么从 30 kbps 提到 300 kbps（2026-10-28）

### 9.1 旧值的来源是个误判

`call_video_encoder.ts` 原来的注释：

```
// 30 kbps：与 QQ 本体对齐（实测静态 6 kbps、运动峰值 26 kbps）。
// 旧的 400 kbps 会让每帧涨到 3KB+、拆成 3~28 个 UDP 包，丢一片整帧报废。
```

那组数字是**静态画面**下 ABR 的实际输出。ABR（`rc=ABR`）在画面不动时本来就会
自己把码率降下来 —— 把它当成目标码率写死，等于给了一个「静止时够用、一动就欠码」
的上限。

### 9.2 QQ 本体的真实数值

对 `~/Desktop/weq-call-compare/1-QQ-native__P2P-OK.pcap` 按方向重新统计
（`subType=2`，按 `(gidx,fidx)` 组帧，只算补全的帧）：

| 方向 | 帧数 | 帧率 | 码率 | SPS 分辨率 |
| --- | --- | --- | --- | --- |
| 对端 → 本端 | 229 | 12.0 fps | **710 kbps** | 640×360 |
| 本端 → 对端 | 226 | 12.1 fps | **283 kbps** | 640×360 |

所以 QQ 本体与我们**分辨率完全一样**（640×360），差的是码率。而且上下行不对称
（下行给得更多）—— 这也解释了为什么「觉得对方画面糊」比「对方觉得我们糊」更常见。

### 9.3 质量差多少

同一张真实屏幕截图、同一个 t265 编码器、640×360@15fps，逐档实测：

| 目标码率 | 实际码率 | PSNR-Y | 单帧平均 | 单帧峰值 |
| --- | --- | --- | --- | --- |
| 30 kbps（旧值） | 43 kbps | **32.6 dB** | 0.35 KB | 2.09 KB |
| 100 kbps | 124 kbps | 34.7 dB | 1.01 KB | 3.69 KB |
| 200 kbps | 203 kbps | 40.6 dB | 1.65 KB | 7.34 KB |
| **300 kbps** | 286 kbps | **43.4 dB** | 2.33 KB | 9.35 KB |
| 500 kbps | 441 kbps | 45.2 dB | 3.59 KB | 10.72 KB |
| 700 kbps | 546 kbps | 45.2 dB | 4.44 KB | 10.72 KB |

30 → 300 kbps 是 10.8 dB，肉眼是「糊成一团」到「能看清字」的差别；再往上收益
迅速递减（300 → 700 只多 1.8 dB，流量却翻倍），所以取 300。

### 9.4 分片风险

`0x5b` 的 `pkg_idx` 是单字节，单帧上限 255 片。实测：

| 档位 | 单帧平均 | 单帧 p95 | 单帧峰值 |
| --- | --- | --- | --- |
| 480×270@300kbps（摄像头） | 3.1 KB（≈3 片） | 21.8 KB（≈20 片） | 23.8 KB（≈21 片） |
| 960×540@1.2Mbps（共享） | 6.5 KB（≈6 片） | 28.7 KB（≈26 片） | 45.8 KB（≈40 片） |

离 255 很远。（脚本里按 1174 B/片估算：1200 B UDP 载荷扣掉 17 B 外层头 +
6 B RTP 头 + 3 B 扩展。）

**分片数不是这次掉帧的原因** —— 真机抓包实测上行只有 3.1 片/帧（p95 4）。
瓶颈在采集节拍与编码耗时，见 §8.7。

## 10. 抓包复现方法

不需要改代码：`tcpdump` 抓原始包即可（媒体是明文）。

```bash
# 通话媒体走 UDP 8000/8001/8800，信令走 MSF（80/443/14000 轮换）
sudo tcpdump -i <网卡> -s 0 -U -w /tmp/call.pcap \
  "udp or (tcp and (port 80 or port 443 or port 14000))"
```

注意 `-s 0`：视频包常有 1 KB 以上，默认 snaplen 会截断。

另一种更省事的办法是在 `CallSession` 的 UDP 收发口子上留痕（本项目 dev 构建
会写 `~/.config/weq/call-trace/`），但它只能看到**我们自己这条 socket** 的流量
——要看 QQ 客户端自己发起的通话，仍得用 tcpdump。
