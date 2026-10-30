/**
 * UDP 抓包的落盘格式。
 *
 * 两个使用方共用这一份：
 *
 *   - `ipc/routers/udp_capture.ts` 的「导出」（把前端列表写成 pcapng）；
 *   - `call_udp_trace.ts` 的「通话 UDP 落盘」（把本进程收发的数据报边跑边写）。
 *
 * 之所以抽出来：两边的文件必须是**同一种格式**，否则用户拿通话记录去和抓包面板
 * 导出的文件对照时会发现结构不同。pcapng 采用最小实现（SHB + IDB + EPB，
 * linktype 1 以太网，套一个假的以太网头），Wireshark 直接可读。
 *
 * 通话那条路只拿得到**载荷**（数据报是我们自己的 dgram 套接字收发的），所以这里
 * 按五元组补一个合法的 IP + UDP 头 —— 校验和照常算，Wireshark 不会标红。
 */

import type { WriteStream } from 'node:fs';

export type UdpDirection = 'c2s' | 's2c';

/** 一条数据报的五元组 + 载荷（不含 IP 头）。 */
export interface UdpPacketParts {
  src: string;
  srcPort: number;
  dst: string;
  dstPort: number;
  payload: Uint8Array;
}

/** 可写进 pcapng 的一帧：完整 IP 包（`rawHex`）与毫秒时间戳。 */
export interface PcapngFrame {
  ts: number;
  rawHex: string;
}

// ─────────────────────────── IP / UDP ───────────────────────────

/**
 * 按五元组合成一个完整 IP 数据报（IP 头 + UDP 头 + 载荷）。
 *
 * 地址族以**目的地址**为准：udp6 套接字发 IPv4 目标时本端地址可能是 `::`，
 * 此时按 IPv4 补 `0.0.0.0`，避免 Wireshark 把它当成「IPv6 包里有 IPv4 头」。
 * 地址解析失败（主机名 / 取了 zone 的怪地址）时同样补全零地址，不抛错 ——
 * 抓包文件里丢一个字段好过整通电话因为写日志失败而受影响。
 */
export function synthesizeIpPacket(parts: UdpPacketParts): Buffer {
  const src = parseAddress(parts.src);
  const dst = parseAddress(parts.dst);
  // 只要有一端是 IPv4 就按 IPv4 写：udp6 双栈套接字的本地地址可能是 `::`，
  // 而对端是 IPv4 映射地址 —— 真实包是 IPv4，按 `::` 定族会把它写成 IPv6。
  const family: 4 | 6 =
    src?.family === 4 || dst?.family === 4 ? 4 : (src?.family ?? dst?.family ?? 4);
  const srcBytes = src?.family === family ? src.bytes : Buffer.alloc(family === 4 ? 4 : 16);
  const dstBytes = dst?.family === family ? dst.bytes : Buffer.alloc(family === 4 ? 4 : 16);
  const payload = Buffer.from(parts.payload);
  return family === 4
    ? buildIpv4(srcBytes, dstBytes, parts.srcPort, parts.dstPort, payload)
    : buildIpv6(srcBytes, dstBytes, parts.srcPort, parts.dstPort, payload);
}

function buildIpv4(
  src: Buffer,
  dst: Buffer,
  srcPort: number,
  dstPort: number,
  payload: Buffer,
): Buffer {
  const udp = buildUdp(src, dst, srcPort, dstPort, payload, 4);
  const header = Buffer.alloc(20);
  header[0] = 0x45; // IPv4，20 字节头
  header.writeUInt16BE(20 + udp.length, 2); // total length
  header.writeUInt16BE(0, 4); // identification
  header.writeUInt16BE(0x4000, 6); // DF
  header[8] = 64; // TTL
  header[9] = 17; // UDP
  src.copy(header, 12);
  dst.copy(header, 16);
  header.writeUInt16BE(checksum(header), 10);
  return Buffer.concat([header, udp]);
}

function buildIpv6(
  src: Buffer,
  dst: Buffer,
  srcPort: number,
  dstPort: number,
  payload: Buffer,
): Buffer {
  const udp = buildUdp(src, dst, srcPort, dstPort, payload, 6);
  const header = Buffer.alloc(40);
  header[0] = 0x60; // IPv6
  header.writeUInt16BE(udp.length, 4); // payload length
  header[6] = 17; // next header = UDP
  header[7] = 64; // hop limit
  src.copy(header, 8);
  dst.copy(header, 24);
  return Buffer.concat([header, udp]);
}

/** UDP 头 + 载荷，并按 IP 版本算伪首部校验和（IPv6 下这项是强制的）。 */
function buildUdp(
  src: Buffer,
  dst: Buffer,
  srcPort: number,
  dstPort: number,
  payload: Buffer,
  family: 4 | 6,
): Buffer {
  const length = 8 + payload.length;
  const udp = Buffer.alloc(length);
  udp.writeUInt16BE(srcPort & 0xffff, 0);
  udp.writeUInt16BE(dstPort & 0xffff, 2);
  udp.writeUInt16BE(length & 0xffff, 4);
  payload.copy(udp, 8);

  const lengthBytes = Buffer.alloc(2);
  lengthBytes.writeUInt16BE(length, 0);
  const pseudo =
    family === 4
      ? Buffer.concat([src, dst, Buffer.from([0, 17]), lengthBytes])
      : Buffer.concat([src, dst, Buffer.from([0, 0, 0, length >>> 8, length & 0xff, 0, 0, 0, 17])]);
  // 校验和算出来是 0 时要写成 0xffff（0 表示「未计算」）。
  const sum = checksum(Buffer.concat([pseudo, udp])) || 0xffff;
  udp.writeUInt16BE(sum, 6);
  return udp;
}

/** 16 位反码和（RFC 1071）。 */
function checksum(data: Buffer): number {
  let sum = 0;
  for (let i = 0; i + 1 < data.length; i += 2) sum += data.readUInt16BE(i);
  if (data.length % 2 === 1) sum += data[data.length - 1]! << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

/** 解析 IPv4 / IPv6（含 `::ffff:` 映射）；认不出来返回 null。 */
export function parseAddress(raw: string): { family: 4 | 6; bytes: Buffer } | null {
  const address = raw.trim().replace(/^\[|\]$/g, '');
  if (!address) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) {
    const bytes = parseIpv4(mapped[1]!);
    return bytes ? { family: 4, bytes } : null;
  }
  if (address.includes(':')) {
    const bytes = parseIpv6(address);
    return bytes ? { family: 6, bytes } : null;
  }
  const bytes = parseIpv4(address);
  return bytes ? { family: 4, bytes } : null;
}

function parseIpv4(address: string): Buffer | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i]!)) return null;
    const value = Number(parts[i]);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseIpv6(address: string): Buffer | null {
  const bare = address.split('%')[0]!;
  const halves = bare.split('::');
  if (halves.length > 2) return null;
  const left = parseIpv6Groups(halves[0] ?? '');
  const right = halves.length === 2 ? parseIpv6Groups(halves[1] ?? '') : [];
  if (!left || !right) return null;
  const groups =
    halves.length === 2
      ? [...left, ...new Array(8 - left.length - right.length).fill(0), ...right]
      : left;
  if (groups.length !== 8 || groups.some((group) => group < 0)) return null;
  const bytes = Buffer.alloc(16);
  for (let index = 0; index < groups.length; index++) {
    bytes.writeUInt16BE(groups[index]!, index * 2);
  }
  return bytes;
}

function parseIpv6Groups(chunk: string): number[] | null {
  if (!chunk) return [];
  const out: number[] = [];
  for (const group of chunk.split(':')) {
    if (group.includes('.')) {
      const v4 = parseIpv4(group);
      if (!v4) return null;
      out.push(v4.readUInt16BE(0), v4.readUInt16BE(2));
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    out.push(Number.parseInt(group, 16));
  }
  return out;
}

// ─────────────────────────── pcapng ───────────────────────────

/** 一个 pcapng block（长度字段会自动补齐并首尾各写一份）。 */
export function pcapngBlock(type: number, body: Buffer): Buffer {
  const pad = (4 - (body.length % 4)) % 4;
  const total = 12 + body.length + pad;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(type, 0);
  out.writeUInt32LE(total, 4);
  body.copy(out, 8);
  out.writeUInt32LE(total, total - 4);
  return out;
}

/** SHB：字节序 0x1A2B3C4D，版本 1.0，section 长度 -1。 */
export function pcapngSectionHeader(): Buffer {
  const shb = Buffer.alloc(16);
  shb.writeUInt32LE(0x1a2b3c4d, 0);
  shb.writeUInt16LE(1, 4);
  shb.writeUInt16LE(0, 6);
  shb.writeBigInt64LE(-1n, 8);
  return pcapngBlock(0x0a0d0d0a, shb);
}

/** IDB：linktype 1 (Ethernet)，snaplen 0，附一个 if_name option。 */
export function pcapngInterfaceDescription(ifaceName: string): Buffer {
  const name = Buffer.from(ifaceName, 'utf8');
  const namePad = (4 - (name.length % 4)) % 4;
  const idb = Buffer.alloc(8 + 8 + name.length + namePad);
  idb.writeUInt16LE(1, 0); // linktype
  idb.writeUInt16LE(0, 2); // reserved
  idb.writeUInt32LE(0, 4); // snaplen
  idb.writeUInt16LE(2, 8); // opt: if_name
  idb.writeUInt16LE(name.length, 10);
  name.copy(idb, 12);
  idb.writeUInt16LE(0, 12 + name.length + namePad); // opt_endofopt
  idb.writeUInt16LE(0, 14 + name.length + namePad);
  return pcapngBlock(0x00000001, idb);
}

/** 给 IP 包套一个假以太网头（12 字节 MAC + 2 字节 EtherType）。 */
export function ethernetFrame(ip: Buffer): Buffer {
  const version = ip[0]! >> 4;
  const header = Buffer.alloc(14);
  header[12] = version === 6 ? 0x86 : 0x08;
  header[13] = version === 6 ? 0xdd : 0x00;
  return Buffer.concat([header, ip]);
}

/** EPB：一个包一条，时间戳单位 1e-6 秒（pcapng 默认 tsresol）。 */
export function pcapngEnhancedPacket(ts: number, ip: Buffer): Buffer {
  const packet = ethernetFrame(ip);
  const pad = (4 - (packet.length % 4)) % 4;
  const body = Buffer.alloc(20 + packet.length + pad);
  body.writeUInt32LE(0, 0); // interface id
  body.writeUInt32LE(Math.floor(ts / 1000) >>> 0, 4);
  body.writeUInt32LE(Math.round((ts % 1000) * 1000) >>> 0, 8);
  body.writeUInt32LE(packet.length, 12); // captured len
  body.writeUInt32LE(packet.length, 16); // original len
  packet.copy(body, 20);
  return pcapngBlock(0x00000006, body);
}

/** 一次性把若干帧拼成完整的 pcapng（抓包面板的「导出」用）。 */
export function buildPcapng(frames: PcapngFrame[], ifaceName: string): Buffer {
  const chunks = [pcapngSectionHeader(), pcapngInterfaceDescription(ifaceName)];
  for (const frame of frames) {
    const ip = Buffer.from(frame.rawHex, 'hex');
    if (ip.length === 0) continue;
    chunks.push(pcapngEnhancedPacket(frame.ts, ip));
  }
  return Buffer.concat(chunks);
}

/**
 * 流式 pcapng 写盘（通话落盘用）。
 *
 * 头两个 block 在构造时就写掉，之后一条数据报一个 EPB —— 长通话不能把整段流量
 * 攒在内存里（视频通话一小时是 GB 级）。
 *
 * 写流是异步的，`error` 必须有人接住：磁盘满 / 目录被删时没有监听器会把整个主
 * 进程抛掉。出错只置 `failed`，调用方后续写入直接丢弃。
 */
export class PcapngStream {
  private failed = false;
  private packets = 0;
  private bytes = 0;

  constructor(
    private readonly stream: WriteStream,
    ifaceName: string,
  ) {
    stream.on('error', () => {
      this.failed = true;
    });
    this.write(pcapngSectionHeader());
    this.write(pcapngInterfaceDescription(ifaceName));
  }

  get packetCount(): number {
    return this.packets;
  }

  get byteCount(): number {
    return this.bytes;
  }

  get isFailed(): boolean {
    return this.failed;
  }

  /** 写一条完整 IP 包（IP 头 + UDP 头 + 载荷）。 */
  writePacket(ts: number, ip: Buffer): void {
    if (this.failed || ip.length === 0) return;
    this.write(pcapngEnhancedPacket(ts, ip));
    this.packets += 1;
  }

  /** 收尾：把写流关干净。幂等。 */
  async close(): Promise<void> {
    if (this.failed) return;
    await new Promise<void>((resolve) => this.stream.end(() => resolve()));
  }

  private write(chunk: Buffer): void {
    if (this.failed) return;
    this.bytes += chunk.length;
    this.stream.write(chunk);
  }
}
