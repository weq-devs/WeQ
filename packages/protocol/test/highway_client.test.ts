/**
 * highway TCP 上传客户端测试 —— 起一个**本地假 highway 节点**（net 服务端），
 * 按真实帧格式收分块、回响应帧。这样分块顺序 / 偏移 / 每块 md5 / DelayRetry /
 * 硬错误这些最容易写错的地方都能离线验证，不需要连腾讯的服务器。
 *
 * 假节点做的事（每个分块都是一次独立的 `POST /cgi-bin/httpconn?... HTTP/1.1`，
 * 同一个 TCP 连接上 keep-alive 复用）：
 *   1. 先跳过 HTTP 请求头，再解析 `0x28 | headLen | bodyLen | head | body | 0x29`；
 *   2. 用 `REQ_DATA_HIGHWAY_HEAD` 解出 dataOffset / dataLength / md5；
 *   3. 回一帧 `RESP_DATA_HIGHWAY_HEAD { errorCode }`（由 handler 决定）。
 */

import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BufferChunkSource,
  decode,
  encode,
  REQ_DATA_HIGHWAY_HEAD,
  RESP_DATA_HIGHWAY_HEAD,
  type HighwaySession,
  packHighwayFrame,
  unpackHighwayFrame,
  uploadHighwayHttp,
} from '../src/index';

interface ReceivedChunk {
  offset: number;
  length: number;
  md5: Uint8Array;
  fileMd5: Uint8Array;
  ticket: Uint8Array;
  uin: string;
  commandId: number;
  body: Uint8Array;
}

interface FakeNode {
  session: HighwaySession;
  received: ReceivedChunk[];
  close(): Promise<void>;
}

/** 起一个假 highway 节点；`respond` 决定每块的错误码。 */
async function startFakeNode(
  respond: (chunk: ReceivedChunk, index: number) => number | Promise<number> = () => 0,
): Promise<FakeNode> {
  const received: ReceivedChunk[] = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    // 每个请求 = HTTP 头 + 一帧；帧读完就回到「等下一个 HTTP 头」。
    let expectingHeaders = true;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (expectingHeaders) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          buffer = buffer.subarray(end + 4);
          expectingHeaders = false;
        }
        if (buffer.length < 9) return;
        const headLen = buffer.readUInt32BE(1);
        const bodyLen = buffer.readUInt32BE(5);
        const total = 9 + headLen + bodyLen + 1;
        if (buffer.length < total) return;
        const frame = new Uint8Array(buffer.subarray(0, total));
        buffer = buffer.subarray(total);
        expectingHeaders = true;

        const { head, body } = unpackHighwayFrame(frame);
        const parsed = decode(REQ_DATA_HIGHWAY_HEAD, head) as {
          msgBaseHead?: { uin?: string; commandId?: number };
          msgSegHead?: {
            dataOffset?: bigint;
            dataLength?: number;
            md5?: Uint8Array;
            fileMd5?: Uint8Array;
            serviceTicket?: Uint8Array;
          };
        };
        const record: ReceivedChunk = {
          offset: Number(parsed.msgSegHead?.dataOffset ?? 0),
          length: parsed.msgSegHead?.dataLength ?? 0,
          md5: parsed.msgSegHead?.md5 ?? new Uint8Array(0),
          fileMd5: parsed.msgSegHead?.fileMd5 ?? new Uint8Array(0),
          ticket: parsed.msgSegHead?.serviceTicket ?? new Uint8Array(0),
          uin: parsed.msgBaseHead?.uin ?? '',
          commandId: parsed.msgBaseHead?.commandId ?? 0,
          body,
        };
        received.push(record);

        const index = received.length - 1;
        Promise.resolve(respond(record, index))
          .then((errorCode) => {
            const head2 = encode(RESP_DATA_HIGHWAY_HEAD, { errorCode });
            const respFrame = packHighwayFrame(head2, new Uint8Array(0));
            const httpHeader = `HTTP/1.1 200 OK\r\nContent-Length: ${respFrame.length}\r\n\r\n`;
            socket.write(Buffer.concat([Buffer.from(httpHeader, 'ascii'), Buffer.from(respFrame)]));
          })
          .catch(() => socket.destroy());
      }
    });
    socket.on('error', () => {
      /* 客户端收完就会 destroy 连接，忽略 */
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  return {
    session: {
      sigSession: new Uint8Array([0xaa, 0xbb]),
      sessionKey: new Uint8Array(0),
      host: '127.0.0.1',
      port: address.port,
    },
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const nodes: FakeNode[] = [];
afterEach(async () => {
  while (nodes.length > 0) await nodes.pop()!.close();
});

const MB = 1024 * 1024;

describe('uploadHighwayHttp（本地假节点）', () => {
  it('按 1 MiB 顺序分块上传：偏移正确、每块 md5 正确、拼回来等于原文件', async () => {
    const node = await startFakeNode();
    nodes.push(node);

    // 2.5 MiB → 三块（1M / 1M / 0.5M）
    const bytes = new Uint8Array(2 * MB + MB / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;

    const { createHash } = await import('node:crypto');
    const fileMd5 = new Uint8Array(createHash('md5').update(Buffer.from(bytes)).digest());

    await uploadHighwayHttp({
      session: node.session,
      uin: '10001',
      commandId: 1004,
      source: new BufferChunkSource(bytes),
      fileMd5,
      extend: new Uint8Array([1, 2, 3]),
    });

    expect(node.received.map((c) => c.offset)).toEqual([0, MB, 2 * MB]);
    expect(node.received.map((c) => c.length)).toEqual([MB, MB, MB / 2]);
    for (const chunk of node.received) {
      const expected = createHash('md5')
        .update(Buffer.from(bytes.subarray(chunk.offset, chunk.offset + chunk.length)))
        .digest();
      expect(Buffer.from(chunk.md5).toString('hex')).toBe(expected.toString('hex'));
      expect(Buffer.from(chunk.fileMd5).toString('hex')).toBe(Buffer.from(fileMd5).toString('hex'));
      expect(Array.from(chunk.ticket)).toEqual([0xaa, 0xbb]);
      expect(chunk.uin).toBe('10001');
      expect(chunk.commandId).toBe(1004);
    }

    // 拼回来的字节必须与原文件一致（顺序 + 内容都对）。
    const joined = new Uint8Array(bytes.length);
    for (const chunk of node.received) joined.set(chunk.body, chunk.offset);
    expect(Buffer.from(joined).equals(Buffer.from(bytes))).toBe(true);
  });

  it('DelayRetry（102902）会等一会儿重发同一块，最终成功', async () => {
    const node = await startFakeNode((_chunk, index) => (index === 0 ? 102902 : 0));
    nodes.push(node);

    const bytes = new Uint8Array(1024).fill(9);
    await uploadHighwayHttp({
      session: node.session,
      uin: '1',
      commandId: 1003,
      source: new BufferChunkSource(bytes),
      fileMd5: new Uint8Array([1]),
      extend: new Uint8Array(0),
    });

    // 第 0 块发了两次（第二次才是成功），两次偏移都是 0。
    expect(node.received.length).toBeGreaterThanOrEqual(2);
    expect(node.received[0]!.offset).toBe(0);
    expect(node.received[1]!.offset).toBe(0);
    expect(Buffer.from(node.received[1]!.body).equals(Buffer.from(bytes))).toBe(true);
  });

  it('硬错误码（101）直接抛错，不重试', async () => {
    const node = await startFakeNode(() => 101);
    nodes.push(node);

    await expect(
      uploadHighwayHttp({
        session: node.session,
        uin: '1',
        commandId: 1004,
        source: new BufferChunkSource(new Uint8Array(2048).fill(1)),
        fileMd5: new Uint8Array([1]),
        extend: new Uint8Array(0),
      }),
    ).rejects.toThrow(/error_code=101/);
    expect(node.received).toHaveLength(1);
  });

  it('连不上节点 → 重试到上限后抛传输错误', async () => {
    // 关掉一个刚起来的服务端，拿一个必然连不上的端口。
    const dead = await startFakeNode();
    const { port } = (await new Promise<net.AddressInfo>((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as net.AddressInfo;
        server.close(() => resolve(address));
      });
    })) as net.AddressInfo;
    void dead;

    await expect(
      uploadHighwayHttp({
        session: {
          sigSession: new Uint8Array([1]),
          sessionKey: new Uint8Array(0),
          host: '127.0.0.1',
          port,
        },
        uin: '1',
        commandId: 1004,
        source: new BufferChunkSource(new Uint8Array(16).fill(1)),
        fileMd5: new Uint8Array([1]),
        extend: new Uint8Array(0),
      }),
    ).rejects.toThrow(/highway 上传传输失败/);
  }, 20_000);
});
