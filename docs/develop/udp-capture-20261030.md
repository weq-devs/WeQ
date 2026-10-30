# UDP 抓包：设计、验证与踩坑

> 2026-10-30。本文记录「通用 UDP 抓包」这条链路的实现依据 —— 特别是两个只有
> 真机验证才能发现的内核行为，后面改这块之前先读一遍。

## 1. 定位

与「QQNT 抓包」（`capture/`，TCP + MSF 帧解密）**平行**、**互不依赖**：

| | QQNT 抓包 | UDP 抓包 |
| --- | --- | --- |
| 选择维度 | 账号（`uin` → pid） | **进程**（pid） |
| 传输层 | TCP | **UDP** |
| 是否解密 | 是（d2key → TEA） | **否**（载荷原样） |
| 是否解析协议 | 是（MSF 帧 / cmd / body） | **否**（只标首字节） |
| 依赖账号/SSO | 是 | 否 |

之所以不塞进 `capture/`：`Frame` 是 MSF 语义（`seq` / `cmd` / `body` / `plain`），
UDP 是「一个数据报 = 一条记录」，硬合并会让两边都难读。共用的是底层设施：
`Ring` 的游标语义、Linux 的 `Api` / `Session` / `cgroup()` / `process_handle()`。

## 2. 两个必须知道的内核行为

这两条都是 2026-10-30 在本机（Linux 7.2.11 + libbpf 1.7）实测出来的，
**不看会浪费一整天**。

### 2.1 socket 必须在目标 cgroup 内创建

`cgroup/sendmsg4|6` 钩子只对**属于被 attach 的那个 cgroup 的 socket** 生效。
而 socket 归属的是**创建它的进程当时所在的 cgroup** —— 事后把进程移进 cgroup
不会改变已经建好的 socket 的归属。

实测对照：

```
先建 socket，再把进程移进 cgroup → 钩子计数 0（完全看不到）
先把进程移进 cgroup，再建 socket → 钩子计数 2（正常）
```

**对 WeQ 的含义**：QQ 的通话媒体进程会在通话开始时才创建 UDP socket。所以

- 只要在**通话开始前** arm 抓包会话（现有设计就是「先 armed 再发包」），就能覆盖；
- 用户中途才点开始的话，已存在的 socket 靠 `seed_existing`（`pidfd_getfd` +
  `SO_COOKIE`）补登记 —— 它走的是 socket 对象本身，与 syscall 无关，所以不受
  这条限制。

### 2.2 `sendmsg(2)` ≠ `sendto(2)`

`cgroup/sendmsg4|6` 只拦 **`sendmsg(2)`**。`sendto(2)` 是另一个 syscall，
内核里虽然最终都进 `udp_sendmsg()`，但钩子挂载点在 syscall 层，`sendto` 不会触发。

实测（真机视频通话，ppapi 进程 fd 261）：

| syscall | 次数 | 说明 |
| --- | ---: | --- |
| `sendmsg(261, ...)` | 187 | 全部通话流量（IPv6 → 40678，载荷 `0x5b`） |
| `sendto(261, ...)` | 0 | — |
| `recvmsg(261, ...)` | 381 | 接收侧 |
| `recvfrom(261, ...)` | 0 | — |

**结论：QQ 的 avsdk 用 `sendmsg` 发、`recvmsg` 收，所以这条方案成立。**

⚠️ 这是 QQ 当前实现的行为，不是协议保证。如果哪天 avsdk 改用 `sendto`，
`sendmsg` 钩子就抓不到 —— 此时只能靠 `seed_existing`（会话开始前就存在的
socket）兜底。改这块之前先用 `strace -f -p <ppapi> -e trace=sendto,sendmsg`
复核一遍。

## 3. 实现分层

```
nt_helper
  src/capture/linux_capture.bpf.c   加 cgroup/sendmsg4|6 钩子；放开 UDP
  src/capture/port.rs               PortSpec.transport（Tcp/Udp）+ loose_filter()
  src/capture/sniffer.rs            proto == 17 走 feed_udp（不重组）
  src/capture/mod.rs                Frame.udp / CapturedFrame.udp
  src/capture/linux.rs              Packet.direction 传给 PacketStamp.egress
  src/detect/process_scan.rs        ★ 三平台进程扫描（找加载了 avsdk 的进程）

WeQ 主进程
  packages/native/src/types.ts      transport / CapturedUdp / ProcessScanEntry
  apps/desktop/src/main/udp_capture_session.ts   ★ 会话（不依赖账号）
  apps/desktop/src/main/ipc/routers/udp_capture.ts  ★ tRPC
  apps/desktop/src/main/capture_protocol.ts     wire 加 udp 字段

渲染层
  components/UdpCapturePanel.tsx    面板
  components/ProcessPicker.tsx      ★ 进程选择器（两个独立入口）
  components/HexDump.tsx            从 CapturePanel 抽出的共享组件
  styles/udp-capture.css
```

## 4. 进程识别（`process_scan.rs`）

「识别 avsdk 进程」与「选择进程抓包」是**两个独立功能**，刻意不做在一起。

判据统一是「映射路径里含 hint（大小写不敏感）」。三平台各实现一版：

| 平台 | 读什么 |
| --- | --- |
| Linux | `/proc/<pid>/maps` 的第 6 列 |
| macOS | `proc_pidinfo(PROC_PIDREGIONPATHINFO)` 逐条映射区 |
| Windows | `EnumProcessModulesEx` + `GetModuleFileNameExW` |

QQ 的通话媒体进程是 Chromium 的 `--type=ppapi` 子进程，**唯一稳定特征是加载了
`resources/app/avsdk/` 下的库**（主进程和渲染进程都加载 `major.node`，但只有
ppapi 加载 avsdk）。所以传 `avsdk` 就能定位到它。

上限：最多 64 条命中进程、每进程最多 8 条命中模块 —— 防止在装了成百上千进程的
机器上把结果撑爆。

## 5. 方向判定

`cgroup_skb/ingress|egress` 的 BPF 头里带 direction（0=收 1=发），
`linux.rs` 把它传进 `PacketStamp.egress`，UDP 分支据此填 `c2s` / `s2c`。

拿不到方向的后端（macOS PKTAP / libpcap）退化为端口启发式：端口命中集合里的是
目的侧 → `c2s`。

## 6. 不丢包

- 环形缓冲沿用 `Ring` 的游标 + `dropped` 语义，UDP 默认容量比 TCP 大（包更小更多）。
- 内核侧 `losses` map 与用户态 `Pending.lost` 都累加进 `dropped`，**UI 上红色告警**。
- 前端 `MAX_FRAMES` 裁剪只影响展示，不影响后端缓冲。

## 7. 导出

| 格式 | 用途 |
| --- | --- |
| `json` | 自包含文档（meta + 数据报数组） |
| `jsonl` | 每行一条，方便 `jq` / `grep` |
| `pcapng` | **标准抓包文件，Wireshark 直接可读** |

pcapng 是手写的最小实现（SHB + IDB + EPB，linktype 1），只给 IP 包套一个假的
以太网头，Wireshark 会按 IP 版本自己解析。

## 8. 验证

```bash
# 单测
cd ../nt_helper && cargo test --release --lib
cd ../nt_helper && cargo test --release -p weq-authorization-helper

# 真机探针（需要 root；构造未连接 UDP socket，验证 cgroup/sendmsg 能登记）
sudo ./target/release/weq-authorization-helper udp-probe new v4
sudo ./target/release/weq-authorization-helper udp-probe existing v6
```

探针覆盖：新建 / 已存在 socket × IPv4 / IPv6，并断言**其它 UID 的载荷不会泄漏**。

## 9. 平台现状

| 平台 | 抓 UDP | pid 归属 | 备注 |
| --- | --- | --- | --- |
| Linux + 授权助手 | ✅ | 精确（socket cookie） | `cgroup/sendmsg` + `seed_existing` |
| macOS + 授权助手 | 需验证 | 精确（PKTAP） | 只需过滤表达式支持 `udp` |
| Windows | 需验证 | 无（按端口） | Npcap 本身没有 pid 元数据 |
| Linux 普通 `.node` | libpcap | 无 | 只按端口过滤 |

## 10. 已知限制

- **TUN 代理下同一包会出现两次**（TUN 内一次、物理网卡 NAT 后一次），端口也不同。
  Linux/macOS 的精确归属路径不受影响（socket 层只经过一次），libpcap 路径会看到。
- 不做 IP 分片重组：UDP 数据报若被 IP 分片，只取首片（正常路径下不会发生）。
- 不解析业务协议（GCS 字段 / 视频分片 / H.265）—— 这是刻意的设计边界，解析交给
  用户或 Wireshark。
