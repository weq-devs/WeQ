/**
 * 通话抓包留痕（**仅用于逆向 / 排障**，不参与通话逻辑）。
 *
 * 为什么在 UDP 层而不是会话层记录：`CallSession` 只认音频（`0x5b subType=0x01`）
 * 与质量反馈（`0x0e`），其它子类型一律丢弃 —— 视频包正好落在被丢的那一类里。
 * 在 `UdpTransport` 的收 / 发口子上记录，才能拿到「服务端到底发了什么」的真相。
 *
 * 产出是一个纯文本文件，一行一个包：
 *
 *   ```
 *   # call-trace v1  start=2026-10-25T01:30:00.000Z
 *   # room=12345 self=10001 peer=10002
 *   1761351000123 > 0x28 len=42 bt=1 tid=6489 280000002a0000...
 *   1761351000180 < 0x5b len=1184 sub=2 seq=1 ts=... 5b049...
 *   # state connected
 *   ```
 *
 * 行的三要素：**毫秒时间戳**（对齐「对方何时开摄像头」）、**方向**（`>` 发出 /
 * `<` 收到）、**首字节 + 十六进制全文**。前缀 `#` 的是标记行（状态变化），
 * 分析脚本跳过即可。
 *
 * 只记通话相关首字节（`0x28` GCS / `0x5b` 媒体 / `0x02` relay），其余丢弃 ——
 * 这条 socket 只收发这三类，留一道过滤是为了将来换实现时不把噪声写进来。
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

/** 认得出的通话首字节。 */
const CALL_STX = new Set([0x28, 0x5b, 0x02]);

/**
 * 单个文件的上限。视频包每秒能到 1 MB 级，不限的话一次长通话就能写满磁盘。
 * 到顶之后停止记录（文件保留，末尾写一行标记），不影响通话。
 */
const MAX_BYTES = 64 * 1024 * 1024;

export interface CallTraceOptions {
  /** 落盘目录（不存在会自动创建）。 */
  dir: string;
  /** 房间 / 账号信息，写进文件头，便于事后对上是哪一通。 */
  header?: Record<string, string>;
}

function hex(data: Uint8Array): string {
  // 手写而不是 Buffer.toString('hex')：调用方可能是 Uint8Array 视图，
  // 且这里要保证不依赖 Node 的 Buffer 语义（与 protocol 层保持一致）。
  let out = '';
  for (let i = 0; i < data.length; i++) {
    out += data[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/** 首字节的粗分类，写进行里省得分析时每次自己判断。 */
function describeStx(stx: number, data: Uint8Array): string {
  if (stx === 0x28) {
    // GCS：body_type 在 head 的 protobuf 里，这里只标出长度，解析交给 TS 侧。
    return 'gcs';
  }
  if (stx === 0x5b) {
    // 媒体：第 4 字节是 subType，是音频 / 视频 / QFB 的唯一区分。
    const sub = data.length > 3 ? data[3] : -1;
    return `media sub=${sub}`;
  }
  if (stx === 0x02) return 'relay';
  return 'unknown';
}

/**
 * 一次通话的留痕会话。生命周期与 `CallManager` 一致。
 *
 * 写盘用 `createWriteStream` 而不是 `appendFileSync`：视频包高频，同步写会把
 * 主进程的 20 ms 音频节拍拖歪 —— 那样记录到的现象就不是真实行为了。
 */
export class CallTrace {
  private stream: WriteStream | null = null;
  private bytes = 0;
  private truncated = false;
  private readonly path: string;
  /** 已见过的媒体子类型 → 首次出现的时刻，用来在文件里插一行「首次」标记。 */
  private readonly firstSeen = new Map<string, number>();

  constructor(options: CallTraceOptions) {
    mkdirSync(options.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.path = join(options.dir, `call-trace-${stamp}.log`);
    this.stream = createWriteStream(this.path, { flags: 'a' });
    // 写失败（磁盘满 / 权限）不该把通话带崩：静默关掉即可。
    this.stream.on('error', () => this.close());

    const lines = [`# call-trace v1  start=${new Date().toISOString()}`];
    for (const [key, value] of Object.entries(options.header ?? {})) {
      lines.push(`# ${key}=${value}`);
    }
    this.write(`${lines.join('\n')}\n`);
  }

  /** 落盘路径（排障时直接告诉用户去哪儿找）。 */
  get filePath(): string {
    return this.path;
  }

  /** 收到一个包。 */
  inbound(data: Uint8Array, from: { address: string; port: number }): void {
    this.record('<', data, `${from.address}:${from.port}`);
  }

  /** 发出一个包。 */
  outbound(data: Uint8Array, port: number, address: string): void {
    this.record('>', data, `${address}:${port}`);
  }

  /** 一条标记（状态变化 / 人工注记），不带包体。 */
  mark(text: string): void {
    this.write(`# ${text}\n`);
  }

  close(): void {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    if (this.truncated) {
      stream.write(`# truncated at ${MAX_BYTES} bytes\n`);
    }
    stream.end();
  }

  private record(direction: '<' | '>', data: Uint8Array, peer: string): void {
    if (data.length === 0) return;
    const stx = data[0]!;
    if (!CALL_STX.has(stx)) return;
    const now = Date.now();
    const kind = describeStx(stx, data);
    // 首次见到某个子类型单独插一行：分析时一眼就能找到「对端开始发视频」的
    // 那一刻，不用在几千行里翻第一个 `sub=2`。
    if (!this.firstSeen.has(kind)) {
      this.firstSeen.set(kind, now);
      this.write(`# first ${direction} ${kind} at ${now}\n`);
    }
    const line = `${now} ${direction} ${kind} len=${data.length} peer=${peer} ${hex(data)}\n`;
    this.write(line);
  }

  private write(line: string): void {
    if (!this.stream || this.truncated) return;
    this.bytes += line.length;
    if (this.bytes > MAX_BYTES) {
      this.truncated = true;
      this.stream.write(`# reached ${MAX_BYTES} bytes, stop recording\n`);
      return;
    }
    this.stream.write(line);
  }
}
