/**
 * 通用 UDP 抓包 router。
 *
 * 与 `wonderful_tools.ts` 的 QQNT 抓包（TCP / MSF）刻意分开：
 *
 *   - `processes`     列出所有进程（可带模块 hint），供「选择进程抓包」用。
 *   - `detectAvsdk`   识别 QQ 的通话媒体进程（加载了 `resources/app/avsdk/`）。
 *                     **与进程选择是两个独立功能**：一个只推荐，一个只选。
 *   - `support`       后端可用性 + 是否支持进程扫描。
 *   - `start` / `poll` / `stop`  抓包会话。
 *   - `export`        导出 json / jsonl / pcapng。
 *
 * 不解析任何业务协议：载荷原样 hex 交给前端，详情面板自己试 protobuf/JCE。
 */

import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { getHost } from '@weq/service';
import { procedure, router } from '../trpc';
import {
  disposeUdpCaptures,
  listProcessesWithModule,
  probeProcessScan,
  probeUdpCaptureBackend,
  startUdpCapture,
  stopUdpCapture,
  takeUdpDatagrams,
} from '../../udp_capture_session';
import type { CaptureBatchWire, CaptureStatsWire } from '../../capture_protocol';

export { disposeUdpCaptures };

/** 与 `CaptureSupportWire` 同形，多一个「能不能扫进程」。 */
export interface UdpCaptureSupportWire {
  available: boolean;
  backend: string;
  elevated: boolean;
  hint: string;
  platform: string;
  processScan: boolean;
}

/** 进程列表项（前端选择器用）。 */
export interface UdpProcessWire {
  pid: number;
  ppid: number;
  name: string;
  cmdline: string;
  modules: string[];
  /** 是否是推荐的通话媒体进程（加载了 avsdk）。 */
  recommended: boolean;
}

/** 导出格式。pcapng 可直接丢给 Wireshark。 */
const UDP_EXPORT_FORMATS = ['json', 'jsonl', 'pcapng'] as const;

const udpFrameSchema = z.object({
  cursor: z.number().int(),
  ts: z.number(),
  direction: z.enum(['c2s', 's2c']),
  src: z.string(),
  srcPort: z.number().int().min(0).max(65535),
  dst: z.string(),
  dstPort: z.number().int().min(0).max(65535),
  payloadHex: z.string(),
  rawHex: z.string(),
});

function fileStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function safeName(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  return cleaned || fallback;
}

/**
 * 写一个最小 pcapng：SHB + IDB + EPB。
 *
 * 用 pcapng 而不是 pcap：能带接口名、时间戳精度更高，Wireshark 直接可读。
 * 只写 Ethernet 链路类型（linktype 1）—— 包本身是完整 IP 包，套一个假的
 * 以太网头即可，Wireshark 会按 IP 版本自己解析。
 */
function buildPcapng(frames: { ts: number; rawHex: string }[], ifaceName: string): Buffer {
  const chunks: Buffer[] = [];

  const block = (type: number, body: Buffer): Buffer => {
    // 长度 = 类型(4) + 长度(4) + body + 长度(4)，且按 4 字节对齐。
    const pad = (4 - (body.length % 4)) % 4;
    const total = 12 + body.length + pad;
    const out = Buffer.alloc(total);
    out.writeUInt32LE(type, 0);
    out.writeUInt32LE(total, 4);
    body.copy(out, 8);
    out.writeUInt32LE(total, total - 4);
    return out;
  };

  // SHB：字节序 0x1A2B3C4D，版本 1.0，section 长度 -1。
  const shb = Buffer.alloc(16);
  shb.writeUInt32LE(0x1a2b3c4d, 0);
  shb.writeUInt16LE(1, 4);
  shb.writeUInt16LE(0, 6);
  shb.writeBigInt64LE(-1n, 8);
  chunks.push(block(0x0a0d0d0a, shb));

  // IDB：linktype 1 (Ethernet)，snaplen 0，附一个 if_name option。
  const nameBytes = Buffer.from(ifaceName, 'utf8');
  const namePad = (4 - (nameBytes.length % 4)) % 4;
  const idb = Buffer.alloc(8 + 8 + nameBytes.length + namePad);
  idb.writeUInt16LE(1, 0); // linktype
  idb.writeUInt16LE(0, 2); // reserved
  idb.writeUInt32LE(0, 4); // snaplen
  // option: code=2 (if_name), len, value, pad
  idb.writeUInt16LE(2, 8);
  idb.writeUInt16LE(nameBytes.length, 10);
  nameBytes.copy(idb, 12);
  idb.writeUInt16LE(0, 12 + nameBytes.length + namePad); // opt_endofopt
  idb.writeUInt16LE(0, 14 + nameBytes.length + namePad);
  chunks.push(block(0x00000001, idb));

  // EPB：每个包一条。时间戳单位 1e-6 秒（默认 tsresol）。
  const ethHeader = Buffer.from([
    0,
    0,
    0,
    0,
    0,
    0, // dst mac
    0,
    0,
    0,
    0,
    0,
    0, // src mac
    0x08,
    0x00, // IPv4 —— 下面按包实际版本改写
  ]);
  for (const frame of frames) {
    const ip = Buffer.from(frame.rawHex, 'hex');
    if (ip.length === 0) continue;
    const header = Buffer.from(ethHeader);
    const version = ip[0]! >> 4;
    header[12] = version === 6 ? 0x86 : 0x08;
    header[13] = version === 6 ? 0xdd : 0x00;
    const packet = Buffer.concat([header, ip]);
    const pad = (4 - (packet.length % 4)) % 4;
    const body = Buffer.alloc(20 + packet.length + pad);
    body.writeUInt32LE(0, 0); // interface id
    const seconds = Math.floor(frame.ts / 1000);
    const micros = Math.round((frame.ts % 1000) * 1000);
    body.writeUInt32LE(seconds >>> 0, 4);
    body.writeUInt32LE(micros >>> 0, 8);
    body.writeUInt32LE(packet.length, 12); // captured len
    body.writeUInt32LE(packet.length, 16); // original len
    packet.copy(body, 20);
    chunks.push(block(0x00000006, body));
  }

  return Buffer.concat(chunks);
}

export const udpCaptureRouter = router({
  /** 后端可用性。 */
  support: procedure.query(async (): Promise<UdpCaptureSupportWire> => {
    return {
      ...probeUdpCaptureBackend(),
      platform: process.platform,
      processScan: probeProcessScan(),
    };
  }),

  /**
   * 列出进程。`moduleHint` 有值时只返回加载了该模块的进程（大小写不敏感）。
   * `recommended` 标记加载了 avsdk 的那些，方便 UI 高亮。
   */
  processes: procedure
    .input(
      z
        .object({
          moduleHint: z.string().max(64).optional(),
        })
        .optional(),
    )
    .query(async ({ input }): Promise<UdpProcessWire[]> => {
      if (!probeProcessScan()) {
        throw new Error('当前原生模块不支持进程扫描，请更新原生组件');
      }
      const hint = input?.moduleHint?.trim();
      if (hint) {
        return listProcessesWithModule(hint).map((entry) => ({
          ...entry,
          recommended: true,
        }));
      }
      // 没有 hint 时用 avsdk 扫一遍，其余进程由前端按需再查（避免全量枚举拖慢）。
      return listProcessesWithModule('avsdk').map((entry) => ({
        ...entry,
        recommended: true,
      }));
    }),

  /**
   * 识别 QQ 的通话媒体进程。
   *
   * 与「选择进程抓包」是两个独立功能：这里只给推荐，不启动任何抓包。
   * 找不到时返回空列表 + 引导文案，不抛错（本机可能没在通话）。
   */
  detectAvsdk: procedure.query(
    async (): Promise<{
      available: boolean;
      processes: UdpProcessWire[];
      hint: string | null;
    }> => {
      if (!probeProcessScan()) {
        return {
          available: false,
          processes: [],
          hint: '当前原生模块不支持进程扫描，请更新原生组件后重试。',
        };
      }
      const found = listProcessesWithModule('avsdk');
      return {
        available: true,
        processes: found.map((entry) => ({ ...entry, recommended: true })),
        hint:
          found.length === 0
            ? '没有找到加载了 QQ 通话组件（avsdk）的进程。通话进行中才会有这个进程；也可以手动选择其它进程。'
            : null,
      };
    },
  ),

  /** 开始抓某个进程的 UDP。 */
  start: procedure
    .input(
      z.object({
        pid: z.number().int().positive(),
        iface: z.string().max(120).optional(),
        port: z.string().max(120).optional(),
        ringFrames: z.number().int().min(16).max(65_536).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const handle = await startUdpCapture(input.pid, {
        iface: input.iface,
        port: input.port,
        ringFrames: input.ringFrames,
      });
      return {
        ...handle.session,
        pid: handle.pid,
        sessionId: handle.sessionId,
        elevated: handle.elevated,
      };
    }),

  /** 拉取新增数据报（长轮询）。 */
  poll: procedure
    .input(
      z.object({
        pid: z.number().int().positive(),
        sessionId: z.string().min(1).max(128).optional(),
        cursor: z.number().int().nonnegative().optional(),
        waitMs: z.number().int().min(0).max(10_000).optional(),
      }),
    )
    .query(async ({ input }): Promise<CaptureBatchWire> => {
      return await takeUdpDatagrams(input.pid, {
        cursor: input.cursor,
        waitMs: input.waitMs ?? 1200,
        sessionId: input.sessionId,
      });
    }),

  /** 停止抓包并释放会话（幂等）。 */
  stop: procedure
    .input(
      z.object({
        pid: z.number().int().positive(),
        sessionId: z.string().min(1).max(128).optional(),
      }),
    )
    .mutation(async ({ input }): Promise<CaptureStatsWire | null> => {
      return await stopUdpCapture(input.pid, input.sessionId);
    }),

  /**
   * 导出。
   *
   * `json` / `jsonl` 是自包含文档；`pcapng` 是标准抓包文件，可直接用
   * Wireshark 打开（带进程元信息的是 JSON 那两种）。
   */
  export: procedure
    .input(
      z.object({
        name: z.string().min(1).max(120).optional(),
        pid: z.number().int().positive().optional(),
        iface: z.string().max(120).optional(),
        format: z.enum(UDP_EXPORT_FORMATS).default('json'),
        frames: z.array(udpFrameSchema).max(20_000),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.frames.length === 0) return { saved: false, error: '没有可导出的数据报' };

      const meta = {
        tool: 'weq-udp-capture',
        version: 1,
        exportedAt: new Date().toISOString(),
        pid: input.pid ?? null,
        iface: input.iface ?? null,
        datagramCount: input.frames.length,
      };

      let bytes: Buffer;
      if (input.format === 'pcapng') {
        bytes = buildPcapng(input.frames, input.iface ?? 'udp');
      } else if (input.format === 'jsonl') {
        const lines = input.frames.map((f) =>
          JSON.stringify({
            cursor: f.cursor,
            time: new Date(f.ts).toISOString(),
            ts: f.ts,
            direction: f.direction,
            src: f.src,
            srcPort: f.srcPort,
            dst: f.dst,
            dstPort: f.dstPort,
            length: Math.floor(f.payloadHex.length / 2),
            payloadHex: f.payloadHex,
            rawHex: f.rawHex,
          }),
        );
        bytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
      } else {
        bytes = Buffer.from(
          JSON.stringify(
            {
              meta,
              datagrams: input.frames.map((f) => ({
                cursor: f.cursor,
                time: new Date(f.ts).toISOString(),
                ts: f.ts,
                direction: f.direction,
                src: f.src,
                srcPort: f.srcPort,
                dst: f.dst,
                dstPort: f.dstPort,
                length: Math.floor(f.payloadHex.length / 2),
                payloadHex: f.payloadHex,
                rawHex: f.rawHex,
              })),
            },
            null,
            2,
          ),
          'utf8',
        );
      }

      const defaultName = `${safeName(input.name ?? '', `udp_${fileStamp()}`)}.${input.format}`;

      try {
        const target = await getHost().pickSaveTarget({
          locationKey: 'udp-capture',
          defaultName,
          extension: input.format,
        });
        if (!target) return { saved: false, canceled: true };
        await writeFile(target.path, bytes);
        return {
          saved: true,
          path: target.path,
          downloadId: target.downloadId,
          bytes: bytes.length,
          datagrams: input.frames.length,
        };
      } catch (error) {
        return { saved: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
});
