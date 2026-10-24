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
扩展段           ext_fec_byte 低 5 位 ∈ [11,20] → (值-10) 条 [len][type][data]
（按 pkg_idx 拼各分片）
sub-header N B   首字节 = N（实测 20）；[8:12] = 真实帧时间戳 ms
H.265 Annex B    以 00 00 00 01 开头，**明文**
```

- `ext_fec_byte` 高 3 位是跨帧 FEC 数，>3 视为非法；
- 实测扩展只有 type=3、1 字节数据（`0x00`）；
- 帧归属靠 `(gidx, fidx)`：`fidx=1` 基础层，`>=2` 增强层；
- 实测 c2c 通话只用基础层，640×360 Main profile、约 10 fps、单 GOP 很长
  （5 秒的视频只有一个关键帧）。

**没有加密。** sub-header 之后直接是 Annex B 裸流，`ffmpeg` 可直接解码。

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

29 字节，每 2 秒一条。视频停了还在发，直到挂断 —— 它是**会话级**的，不是
「正在发视频」的心跳。

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

关键接口：

- `CallSession.onVideo(listener)` —— 收到完整帧时回调，给 Annex B 裸流；
- `CallSession.setCamera(enabled)` —— 开 / 关本端摄像头（发控制包）；
- `CallVideoEncoder` —— 主进程注入的编码器，`next()` 吐一帧裸流。

## 6. 未完成

- **本端采集与编码**：`CallVideoEncoder` 的实现在主进程还没接（需要摄像头
  采集 + H.265 编码）。
- **渲染层解码与显示**：`<video>` 接 WebCodecs 的 HEVC 解码器。
- **屏幕共享**：协议侧与摄像头同一套 `subType=2`（可能要 `subType=7`），但
  Wayland 下采集受限，本次未验证成功。
- **群通话 / 被动接听**：与语音通话同样的限制（见 voice-call 文档 §1）。

## 7. 抓包复现方法

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
