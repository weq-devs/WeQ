/**
 * highway 上传客户端 —— NTV2 富媒体的实际字节通道。
 *
 * 流程（对照 SnowLuma `highway/highway-client.ts`）：
 *   1. `fetchHighwaySession` 发 `HttpConn.0x6ff_501` 拿 `sig_session` + 上传节点 ip/port；
 *   2. 每个子文件按 1 MiB 分块，走 TCP 明文 HTTP POST
 *      `/cgi-bin/httpconn?htcmd=0x6FF0087&uin=<自己uin>`，body 是
 *      `0x28 | len(head) | len(body) | head | body | 0x29` 的自定义帧；
 *   3. 响应同样是这种帧，解出 `RespDataHighwayHead.errorCode`；非 0 视为服务端拒绝。
 *
 * 与仓库里已有的闪传 `sliceupload` 的关系：**不是同一条通道**。闪传走的是
 * `multimedia.qfile.qq.com/sliceupload`（HTTP + rkey + Sha1StateV，见 `./sliceupload`），
 * 媒体上传走的是这里的 highway TCP + NTV2 uKey。两者只共享哈希能力
 * （`./hash-file` 的 `computeHashes` / `./sha1-stream`），传输层不复用。
 *
 * 设计取舍（与 SnowLuma 一致并简化掉它那些 trace 埋点）：
 *   - **单连接、按 offset 顺序** PUT，HTTP keep-alive 复用连接（省掉每块一次慢启动）；
 *   - 传输层失败（对端 FIN / ECONNRESET / 连接超时）丢连接重连并**重发同一块**（幂等）；
 *   - `102902 / 302902` 是官方的 DelayRetry：换连接 + 等 250ms 再重发；
 *   - 大文件用 `FileChunkSource` 流式读，内存里始终只有一块。
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import { decode, encode } from '../protobuf';
import { sendPacket, type TrpcNative } from '../transport';
import {
  HTTP_CONN_REQ,
  HTTP_CONN_RESP,
  NTV2_RICH_MEDIA_HIGHWAY_EXT,
  type Ntv2IPv4,
  type Ntv2UploadMsgInfo,
  REQ_DATA_HIGHWAY_HEAD,
  RESP_DATA_HIGHWAY_HEAD,
} from './ntv2-schemas';

/** highway 固定 appId（与 NapCat / SnowLuma 一致）。 */
export const HIGHWAY_APP_ID = 1600001604;
/** 每块 1 MiB。 */
export const HIGHWAY_BLOCK_SIZE = 1024 * 1024;
/** 单块传输层最大尝试次数。 */
const MAX_CHUNK_ATTEMPTS = 3;
/** 传输失败后的退避基数。 */
const RETRY_BASE_MS = 300;
/** 官方 DelayTryNext 的 250ms 下限。 */
const DELAY_RETRY_MS = 250;
/** DelayRetry 连续次数上限。 */
const MAX_DELAY_RETRIES = 8;
/** 服务端返回这些 error_code 时按「稍后重试」处理。 */
const DELAY_RETRY_CODES = new Set([102902, 302902]);
/** 响应读到一半卡住的上限。 */
const READ_IDLE_MS = 30_000;
/** TCP 连接超时。 */
const CONNECT_TIMEOUT_MS = 10_000;

export const HIGHWAY_SESSION_CMD = 'HttpConn.0x6ff_501';

export interface HighwaySession {
  sigSession: Uint8Array;
  sessionKey: Uint8Array;
  /** 上传节点（拿不到 serverInfos 时退回默认域名）。 */
  host: string;
  port: number;
}

/**
 * `ServerAddr.ip` / `IPv4.outIP` 是 **FIXED32**（线上小端），所以解出来的数字里
 * **最低字节是点分串的第一个八位组** —— 转换必须小端在前。
 *
 * 这里曾在真机上踩过坑：写成大端（`>>> 24` 开头）会把地址字节序整个反过来，
 * highway 的 `NTV2RichMediaHighwayExt.network.ipv4s[].domain.ip` 于是带着一个
 * 不存在的节点地址发给服务端 —— 上传帧本身能拿到 `error_code=0`，但文件不会真正
 * 落到该 uKey 上，收端统统显示「图片/语音/视频已过期」。
 * 两个独立参考实现都取小端：NapCat `packet/highway/utils.ts:int32ip2str`、
 * Lagrange.Core `Utility/ProtocolHelper.cs:UInt32ToIPV4Addr`。
 */
export function ipv4ToString(value: number): string {
  const n = value >>> 0;
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.');
}

/**
 * 申请 highway 会话：`HttpConn.0x6ff_501` 返回的 `sig_session` 要放进每块的
 * `serviceTicket`，serverInfos 里 serviceType=1 的那组是上传节点。
 */
export async function fetchHighwaySession(nt: TrpcNative, pid: number): Promise<HighwaySession> {
  const request = encode(HTTP_CONN_REQ, {
    httpConn: {
      field1: 0,
      field2: 0,
      field3: 16,
      field4: 1,
      field6: 3,
      serviceTypes: [1, 5, 10, 21],
      field9: 2,
      field10: 9,
      field11: 8,
      ver: '1.0.1',
    },
  });
  const bytes = await sendPacket(nt, pid, HIGHWAY_SESSION_CMD, request);
  const resp = decode(HTTP_CONN_RESP, bytes) as {
    httpConn?: {
      sigSession?: Uint8Array;
      sessionKey?: Uint8Array;
      serverInfos?: Record<string, unknown>[];
    };
  };
  const inner = resp.httpConn;
  if (!inner?.sigSession || inner.sigSession.length === 0) {
    throw new Error('HttpConn 响应缺少 sig_session');
  }

  const session: HighwaySession = {
    sigSession: inner.sigSession,
    sessionKey: inner.sessionKey ?? new Uint8Array(0),
    host: 'htdata3.qq.com',
    port: 80,
  };
  for (const info of inner.serverInfos ?? []) {
    const record = info as { serviceType?: number; serverAddrs?: Record<string, unknown>[] };
    if ((record.serviceType ?? 0) !== 1 || !record.serverAddrs?.length) continue;
    for (const addr of record.serverAddrs) {
      const ip = Number(addr.ip ?? 0);
      const port = Number(addr.port ?? 0);
      if (ip && port) {
        session.host = ipv4ToString(ip);
        session.port = port;
      }
    }
  }
  return session;
}

// ───────────────────────── 帧编解码 ─────────────────────────

/** 打包一帧：`0x28 | headLen(BE) | bodyLen(BE) | head | body | 0x29`。 */
export function packHighwayFrame(head: Uint8Array, body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(9 + head.length + body.length + 1);
  frame[0] = 0x28;
  const view = new DataView(frame.buffer, frame.byteOffset);
  view.setUint32(1, head.length, false);
  view.setUint32(5, body.length, false);
  frame.set(head, 9);
  frame.set(body, 9 + head.length);
  frame[frame.length - 1] = 0x29;
  return frame;
}

/** 解一帧；不是 highway 帧就报错。 */
export function unpackHighwayFrame(frame: Uint8Array): { head: Uint8Array; body: Uint8Array } {
  if (frame.length < 10 || frame[0] !== 0x28 || frame[frame.length - 1] !== 0x29) {
    throw new Error('highway 响应帧非法');
  }
  const view = new DataView(frame.buffer, frame.byteOffset);
  const headLen = view.getUint32(1, false);
  const bodyLen = view.getUint32(5, false);
  return {
    head: frame.subarray(9, 9 + headLen),
    body: frame.subarray(9 + headLen, 9 + headLen + bodyLen),
  };
}

/**
 * 每块的请求头。`serviceTicket` 必须是会话的 sig_session；`md5` 是本块 md5、
 * `fileMd5` 是整文件 md5（服务端据此把块拼起来）。
 */
export function buildHighwayHead(params: {
  uin: string;
  commandId: number;
  fileSize: number;
  offset: number;
  length: number;
  chunkMd5: Uint8Array;
  fileMd5: Uint8Array;
  sigSession: Uint8Array;
  extend: Uint8Array;
  retryTimes?: number;
}): Uint8Array {
  return encode(REQ_DATA_HIGHWAY_HEAD, {
    msgBaseHead: {
      version: 1,
      uin: params.uin,
      command: 'PicUp.DataUp',
      seq: 0,
      retryTimes: params.retryTimes ?? 0,
      appId: HIGHWAY_APP_ID,
      dataFlag: 16,
      commandId: params.commandId,
    },
    msgSegHead: {
      serviceId: 0,
      filesize: params.fileSize,
      dataOffset: params.offset,
      dataLength: params.length,
      retCode: 0,
      serviceTicket: params.sigSession,
      flag: 0,
      md5: params.chunkMd5,
      fileMd5: params.fileMd5,
      cacheAddr: 0,
      cachePort: 0,
    },
    bytesReqExtendInfo: params.extend,
    timestamp: 0,
    msgLoginSigHead: { loginSigType: 8, appId: HIGHWAY_APP_ID },
  });
}

/**
 * 载荷：`NTV2RichMediaHighwayExt` —— uKey + 上传节点 + msgInfoBody + 每 1 MiB 的
 * sha1 中间态（`fileSha1` 数组，最后一项是整文件 sha1）+ blockSize。
 */
export function buildHighwayExtend(
  uKey: string,
  msgInfo: Ntv2UploadMsgInfo,
  ipv4s: Ntv2IPv4[],
  sha1: Uint8Array | Uint8Array[],
  fileIndex = 0,
): Uint8Array {
  const bodies = msgInfo?.msgInfoBody ?? [];
  if (bodies.length === 0) throw new Error('上传响应缺少 msgInfoBody');

  const selected = bodies[fileIndex] ?? bodies[0];
  const networkIpv4s: { domain?: { isEnable?: boolean; ip?: string }; port?: number }[] = [];
  for (const ipv4 of ipv4s ?? []) {
    const ip = ipv4.outIp ?? 0;
    const port = ipv4.outPort ?? 0;
    if (ip && port) networkIpv4s.push({ domain: { isEnable: true, ip: ipv4ToString(ip) }, port });
  }

  return encode(NTV2_RICH_MEDIA_HIGHWAY_EXT, {
    fileUuid: selected?.index?.fileUuid ?? '',
    uKey,
    network: { ipv4s: networkIpv4s },
    msgInfoBody: bodies.map((body) => ({
      index: body.index,
      picture: body.picture,
      fileExist: body.fileExist,
      hashSum: body.hashSum,
    })),
    blockSize: HIGHWAY_BLOCK_SIZE,
    hash: { fileSha1: Array.isArray(sha1) ? sha1 : [sha1] },
  });
}

// ───────────────────────── ChunkSource ─────────────────────────

/**
 * 上传字节来源：图片/语音这种小文件用内存 buffer，大视频用磁盘流式读 ——
 * 上传器拥有 source，并在结束时 `close()` 恰好一次。
 */
export interface ChunkSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export class BufferChunkSource implements ChunkSource {
  constructor(private readonly bytes: Uint8Array) {}
  get size(): number {
    return this.bytes.length;
  }
  read(offset: number, length: number): Promise<Uint8Array> {
    return Promise.resolve(this.bytes.subarray(offset, offset + length));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 磁盘来源：`read` 循环到读满 `length`（FileHandle.read 允许短读）。 */
export class FileChunkSource implements ChunkSource {
  private constructor(
    private readonly handle: fsp.FileHandle,
    readonly size: number,
  ) {}

  static async open(filePath: string, size: number): Promise<FileChunkSource> {
    return new FileChunkSource(await fsp.open(filePath, 'r'), size);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await this.handle.read(buf, got, length - got, offset + got);
      if (bytesRead === 0) {
        throw new Error(
          `读文件提前 EOF: offset=${offset + got} 需要 ${length} 已读 ${got} (size=${this.size})`,
        );
      }
      got += bytesRead;
    }
    return new Uint8Array(buf);
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

// ───────────────────────── TCP PUT ─────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tcpConnect(
  host: string,
  port: number,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({ host, port }, () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeListener('timeout', onTimeout);
      socket.removeListener('error', onError);
      resolve(socket);
    });
    const onTimeout = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('highway TCP 连接超时'));
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', onTimeout);
    socket.once('error', onError);
  });
}

function socketWrite(socket: net.Socket, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (err) => (err ? reject(err) : resolve()));
  });
}

/** 读一个 HTTP 响应体：按 `Content-Length` 收，或在对端 FIN 后按剩余字节收。 */
function readHttpResponseBody(socket: net.Socket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let headerEnd = -1;
    let contentLength = 0;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const detach = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      detach();
      fn();
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => finish(() => reject(new Error('highway 响应读取超时（对端静默）'))),
        READ_IDLE_MS,
      );
    };
    const onData = (chunk: Buffer) => {
      armIdle();
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (headerEnd < 0) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx >= 0) {
          headerEnd = idx + 4;
          const header = buf.subarray(0, headerEnd).toString('ascii').toLowerCase();
          const match = header.match(/content-length:\s*(\d+)/);
          contentLength = match ? Number.parseInt(match[1]!, 10) : 0;
        }
      }
      if (headerEnd >= 0 && buf.length >= headerEnd + contentLength) {
        finish(() => resolve(new Uint8Array(buf.subarray(headerEnd, headerEnd + contentLength))));
      }
    };
    const onError = (err: Error) => finish(() => reject(err));
    const onClose = () => {
      const buf = Buffer.concat(chunks);
      finish(() => {
        // 有 Content-Length 却没读满 = 被截断（上游按可重试处理）；没有则视为 close 结束。
        if (headerEnd >= 0 && (contentLength === 0 || buf.length >= headerEnd + contentLength)) {
          resolve(new Uint8Array(buf.subarray(headerEnd)));
        } else {
          reject(new Error(`连接在响应读完前关闭（已收 ${buf.length}B）`));
        }
      });
    };

    armIdle();
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

async function httpPostFrame(
  socket: net.Socket,
  host: string,
  path: string,
  body: Uint8Array,
): Promise<Uint8Array> {
  const header =
    `POST ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n` +
    `Accept-Encoding: identity\r\n` +
    'User-Agent: Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2)\r\n' +
    `Content-Length: ${body.length}\r\n\r\n`;
  await socketWrite(socket, Buffer.from(header, 'ascii'));
  if (body.length > 0) await socketWrite(socket, body);
  return readHttpResponseBody(socket);
}

export interface HighwayUploadParams {
  session: HighwaySession;
  /** 自己账号的 uin（字符串形式，进 head）。 */
  uin: string;
  /** highway 命令号：图片 1003/1004、语音 1007/1008、视频 1001/1005（缩略图 1002/1006）。 */
  commandId: number;
  source: ChunkSource;
  /** 整文件 md5。 */
  fileMd5: Uint8Array;
  /** `buildHighwayExtend` 的产物。 */
  extend: Uint8Array;
  /** 可选日志钩子（默认静默）。 */
  log?: (message: string) => void;
}

/**
 * 把 `source` 的全部字节按 1 MiB 分块顺序 PUT 到 highway 节点。成功返回，失败抛错。
 * 本函数拥有 `source`，无论成功失败都会 `close()` 它一次。
 */
/** 一块的 md5（服务端按块 md5 校验，整文件 md5 负责拼接）。 */
function md5Of(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('md5').update(Buffer.from(bytes)).digest());
}

export async function uploadHighwayHttp(params: HighwayUploadParams): Promise<void> {
  const { session, uin, commandId, source, fileMd5, extend, log } = params;
  const path = `/cgi-bin/httpconn?htcmd=0x6FF0087&uin=${uin}`;
  const totalSize = source.size;

  let socket: net.Socket | null = null;
  const dropSocket = (): void => {
    if (socket) {
      socket.destroy();
      socket = null;
    }
  };

  try {
    let offset = 0;
    while (offset < totalSize) {
      const chunkSize = Math.min(HIGHWAY_BLOCK_SIZE, totalSize - offset);
      const chunk = await source.read(offset, chunkSize);
      const chunkMd5 = md5Of(chunk);

      let transportAttempts = 0;
      let delayRetries = 0;
      for (;;) {
        const head = buildHighwayHead({
          uin,
          commandId,
          fileSize: totalSize,
          offset,
          length: chunkSize,
          chunkMd5,
          fileMd5,
          sigSession: session.sigSession,
          extend,
          retryTimes: transportAttempts + delayRetries,
        });
        const frame = packHighwayFrame(head, chunk);

        let responseBody: Uint8Array;
        try {
          if (!socket) {
            socket = await tcpConnect(session.host, session.port);
            log?.(`highway 连接 ${session.host}:${session.port}（cmdId=${commandId}）`);
          }
          responseBody = await httpPostFrame(socket, session.host, path, frame);
        } catch (err) {
          dropSocket();
          transportAttempts += 1;
          if (transportAttempts >= MAX_CHUNK_ATTEMPTS) {
            throw new Error(
              `highway 上传传输失败（已重试 ${transportAttempts} 次，cmdId=${commandId} ` +
                `offset=${offset} len=${chunkSize}/${totalSize}）: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          log?.(`highway 第 ${offset} 块传输失败，重连重发（第 ${transportAttempts} 次）`);
          await sleep(RETRY_BASE_MS * transportAttempts);
          continue;
        }

        const { head: respHeadBytes } = unpackHighwayFrame(responseBody);
        const resp = decode(RESP_DATA_HIGHWAY_HEAD, respHeadBytes) as {
          errorCode?: number;
          msgSegHead?: { retCode?: number };
        };
        const errorCode = resp.errorCode ?? 0;
        const segRetCode = resp.msgSegHead?.retCode ?? 0;
        // 与 NapCat 的 `httpUploadBlock` 同格式：errorCode / segRetCode / head hex。
        // 真机排查「上传成功但文件不存在」这类问题时，这行是唯一能看到服务端态度的地方。
        log?.(
          `highway 块 offset=${offset} len=${chunkSize}/${totalSize} cmdId=${commandId} ` +
            `errorCode=${errorCode} segRetCode=${segRetCode} head=${Buffer.from(respHeadBytes).toString('hex')}`,
        );
        if (errorCode === 0) break;

        if (DELAY_RETRY_CODES.has(errorCode) && delayRetries < MAX_DELAY_RETRIES) {
          delayRetries += 1;
          dropSocket();
          log?.(`highway error_code=${errorCode}，DelayRetry 第 ${delayRetries} 次`);
          await sleep(DELAY_RETRY_MS);
          continue;
        }

        throw new Error(
          `highway 上传被拒: error_code=${errorCode} (cmdId=${commandId} offset=${offset} ` +
            `len=${chunkSize}/${totalSize} segRetCode=${segRetCode})`,
        );
      }

      offset += chunkSize;
    }
  } finally {
    dropSocket();
    await source.close();
  }
}
