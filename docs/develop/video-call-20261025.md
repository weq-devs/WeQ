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
- `total_fec` 恒 0，`fidx` 恒 1（c2c 不启用增强层）；
- `pkg_idx` 帧内从 0 递增，`total_pkg` 实测 1–14；
- **`seq` 每片 +1**，整通连续（实测 0…717），不按帧重置；
- **外层 `tick` 帧内恒定**，每帧换一次。

**sub-header 20 字节**（`pkg_idx=0` 的那片才有，后续分片是裸 Annex B 续）：

| 偏移 | 含义 |
| --- | --- |
| `[0]` | 20，sub-header 自身长度 |
| `[1]` | 帧序号 & 0xff |
| `[2]` | **方向标识**：c2s=`0x00`、s2c=`0x03` |
| `[3]` | 恒 `0x06`（**首帧也是**，早期「首帧 03」是误判） |
| `[4:6]` | 恒 0 |
| `[6:8]` | **未还原**（每帧变化，对不上 CRC16 / 校验和 / 长度） |
| `[8:12]` | 时间戳，布局随 `[2]` 变（见下表） |
| `[12:16]` | 会话基准 tick（c2s）/ 0（s2c） |
| `[16:20]` | **未还原**（实测小整数 0–5） |

时间戳布局：

| 方向 | `[2]` | `[8:12]` | `[12:16]` |
| --- | --- | --- | --- |
| c2s（QQ Linux 发） | `0x00` | 帧 PTS（0,100,200… ms，10 fps） | 会话基准 tick，整通恒定 |
| s2c（QQ Windows 发） | `0x03` | 发送方 tick（每帧变） | 0 |

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

视频开始前还会出现两条未完全还原的控制面消息：

- `bt=31`：body.f1=4，一次性；
- `bt=77`：head.f5 带 88 字节密钥材料，body.f3 是流索引（0/1/2/3 递增）。
  视频载荷是明文，这份材料没有用在载荷上。

两者都只需 ACK，现有代码的「未知推送一律 ACK」已经覆盖。

## 5. 实现位置

| 层 | 文件 |
| --- | --- |
| 视频包解析 / 组帧 / H.265 提取 | `packages/protocol/src/call/video.ts` |
| 信令档位 | `packages/protocol/src/call/signaling.ts`（`MEDIA_PROFILE`） |
| 会话收发与状态 | `packages/service/src/account/call_session.ts` |
| 本端采集与 t265 编码 | `apps/desktop/src/main/call_video_encoder.ts` |
| 渲染层解码（WebCodecs） | `apps/desktop/src/renderer/src/hooks/useCallVideo.ts` |
| 解码的纯逻辑（可单测） | `apps/desktop/src/renderer/src/lib/callVideo.ts` |

关键接口：

- `CallSession.onVideo(listener)` —— 收到完整帧时回调，给 Annex B 裸流；
- `CallSession.setCamera(enabled)` —— 开 / 关本端摄像头（发控制包）；
- `CallVideoEncoder` —— 主进程注入的编码器，`next()` 吐一帧裸流。

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

### 7.1 sub-header 两个未解字段

| 字段 | 实测值 | 排查过的假设 |
| --- | --- | --- |
| `[6:8]` | 每帧变化（6948 / 8746 / 8233…） | CRC16-CCITT / CRC16-IBM / 字节和 / 16 位字和 / 帧长 / 分片数，**全部对不上** |
| `[16:20]` | 小整数 0–5（偶尔更大） | 疑似分片数相关（`total_pkg-1` 只对上一部分），未确认 |

当前实现两个字段都填 0。若对端仍不认我们发的画面，优先回头试这两个。

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

- **屏幕共享**：协议侧与摄像头同一套 `subType=2`（可能要 `subType=7`），但
  Wayland 下采集受限，本次未验证成功。
- **群通话 / 被动接听**：与语音通话同样的限制（见 voice-call 文档 §1）。
- **分片尾部 0 填充**：真实客户端等分后末片补 0，但补 0 是否被对端依赖无法从
  抓包证实，当前不补。

## 8. 抓包复现方法

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
