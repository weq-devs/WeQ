/**
 * 通话 UDP 流量落盘。
 *
 * 开关在「设置 → 通话录音 → 记录 UDP 流量」。打开后，WeQ 自己发起的通话在
 * **发起时**就开始记录：控制面（`0x28` GCS）、媒体（`0x5b`）、中继（`0x02`）
 * 三条 UDP 流全部进同一个文件，一条数据报一个包，不做任何协议解析。
 *
 * 为什么在这里做（而不是借 `udp_capture_session`）：
 *
 *   - 通话的 socket 就在主进程里（`NodeUdpTransport`），收发点是天然的，不需要
 *     提权、不需要抓进程、不需要网卡旁路抓包；
 *   - 抓包面板按 pid 抓的是**另一个进程**，抓不到我们自己的流量。
 *
 * 文件格式与「UDP 抓包」面板的 pcapng 导出**完全一致**（同一个
 * `udp_capture_format.ts`），Wireshark 直接可读。我们手里只有载荷，所以按五元组
 * 补一个合法的 IP + UDP 头（校验和照算）。
 *
 * 落盘位置：`<录音目录>/udp/<时间>_<对端>.pcapng`。与录音文件放在同一棵目录树
 * 下，用户翻录音目录时能一起看到，但**不进** `index.json` —— 索引是音频录音的
 * 语义，混进来会让播放器拿到一个不可播放的条目。
 */

import { createWriteStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { formatStamp } from './call_recording_store';
import { PcapngStream, synthesizeIpPacket, type UdpDirection } from './udp_capture_format';

/** 一条被记录下来的数据报（transport 侧填好地址）。 */
export interface TracedDatagram {
  direction: UdpDirection;
  payload: Buffer;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
}

export interface CallUdpTraceOptions {
  /** 录音根目录（与音频录音同一个根）。 */
  root: string;
  peerUin: string;
  startedAt?: number;
}

export class CallUdpTrace {
  readonly path: string;
  private readonly writer: PcapngStream;
  private closed = false;

  private constructor(path: string, writer: PcapngStream) {
    this.path = path;
    this.writer = writer;
  }

  get packetCount(): number {
    return this.writer.packetCount;
  }

  get byteCount(): number {
    return this.writer.byteCount;
  }

  /** 建目录、开文件、写 pcapng 头。失败返回 null（调用方只记日志，不挡通话）。 */
  static async start(options: CallUdpTraceOptions): Promise<CallUdpTrace | null> {
    const startedAt = options.startedAt ?? Date.now();
    const dir = join(options.root, 'udp');
    await mkdir(dir, { recursive: true });
    const fileName = uniqueName(dir, `${formatStamp(startedAt)}_${safeSegment(options.peerUin)}`);
    const path = join(dir, fileName);
    const stream = createWriteStream(path, { flags: 'w' });
    return new CallUdpTrace(path, new PcapngStream(stream, 'weq-call'));
  }

  /** 记一条数据报。构造 IP 头失败 / 文件已关闭时静默丢弃。 */
  record(datagram: TracedDatagram): void {
    if (this.closed) return;
    const outgoing = datagram.direction === 'c2s';
    const packet = synthesizeIpPacket({
      src: outgoing ? datagram.localAddress : datagram.remoteAddress,
      srcPort: outgoing ? datagram.localPort : datagram.remotePort,
      dst: outgoing ? datagram.remoteAddress : datagram.localAddress,
      dstPort: outgoing ? datagram.remotePort : datagram.localPort,
      payload: datagram.payload,
    });
    this.writer.writePacket(Date.now(), packet);
  }

  /** 收尾：关文件。幂等。 */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writer.close();
  }
}

/** 文件名里只留安全字符（对端可能是 uid，含 `_` 与 `-`，都保留）。 */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return cleaned || 'call';
}

/** 同一秒内重复发起（正常不会，服务端只给一路）时加 `-2`、`-3`…，不覆盖旧文件。 */
function uniqueName(dir: string, base: string): string {
  for (let index = 1; index < 1000; index++) {
    const name = index === 1 ? `${base}.pcapng` : `${base}-${index}.pcapng`;
    if (!existsSync(join(dir, name))) return name;
  }
  return `${base}-${Date.now()}.pcapng`;
}
