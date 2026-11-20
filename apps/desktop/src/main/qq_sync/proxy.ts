import { createServer, connect, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  buildServerFrame,
  buildServerPlain,
  parseServerFrame,
  parseServerPlain,
} from '@weqbot/protocol/qq-sync';

export interface SyncCredential {
  uin: string;
  key: string;
  generation: string;
}
type Template = {
  outer: ReturnType<typeof parseServerFrame>;
  inner: ReturnType<typeof parseServerPlain>;
  generation: string;
};
interface Tunnel {
  id: number;
  client: Socket;
  upstream?: Socket;
  framer: FrameBuffer;
  template?: Template;
  waiting: Set<() => void>;
}

/** 登录前导字节透传，已识别的完整 MSF 帧供解密和边界判断。 */
export class FrameBuffer {
  private buffer: Buffer = Buffer.alloc(0);
  private aligned = false;
  get atBoundary() {
    return this.aligned && this.buffer.length === 0;
  }
  feed(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    while (this.buffer.length >= 9) {
      const length = this.buffer.readUInt32BE();
      const protocol = this.buffer.readUInt32BE(4);
      if (
        length < 14 ||
        length > 16 * 1024 * 1024 ||
        ![12, 13].includes(protocol) ||
        this.buffer[8]! > 2
      ) {
        this.aligned = false;
        const positions = [Buffer.from([0, 0, 0, 12]), Buffer.from([0, 0, 0, 13])]
          .map((signature) => this.buffer.indexOf(signature, 5))
          .filter((position) => position >= 5);
        this.buffer = this.buffer.subarray(
          positions.length ? Math.min(...positions) - 4 : this.buffer.length - 8,
        );
        continue;
      }
      if (this.buffer.length < length) break;
      frames.push(this.buffer.subarray(0, length));
      this.buffer = this.buffer.subarray(length);
      this.aligned = true;
    }
    return frames;
  }
}

export class QqSyncProxy {
  private server?: Server;
  private readonly tunnels = new Map<number, Tunnel>();
  private readonly credentials = new Map<string, SyncCredential>();
  private readonly delivered = new Set<string>();
  private nextId = 0;
  private deliveredCount = 0;

  setCredential(value: SyncCredential) {
    if (!/^\d{4,16}$/.test(value.uin) || !/^[a-f\d]{32}$/i.test(value.key))
      throw new Error('账号会话无效');
    this.credentials.set(value.uin, value);
  }
  forget(uin: string) {
    this.credentials.delete(uin);
    for (const tunnel of this.tunnels.values())
      if (tunnel.template?.outer.uin === uin) tunnel.template = undefined;
  }
  status() {
    return {
      running: Boolean(this.server?.listening),
      tunnels: this.tunnels.size,
      accounts: [
        ...new Set(
          [...this.tunnels.values()]
            .filter((tunnel) => {
              const template = tunnel.template;
              return (
                template &&
                template.generation === this.credentials.get(template.outer.uin)?.generation
              );
            })
            .map((tunnel) => tunnel.template!.outer.uin),
        ),
      ],
      delivered: this.deliveredCount,
    };
  }
  async start(port: number) {
    const server = createServer({ allowHalfOpen: true }, (client) => this.accept(client));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.server = server;
  }
  async close() {
    for (const tunnel of this.tunnels.values()) {
      tunnel.client.destroy();
      tunnel.upstream?.destroy();
      for (const wake of tunnel.waiting) wake();
    }
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(client: Socket) {
    const tunnel: Tunnel = {
      id: ++this.nextId,
      client,
      framer: new FrameBuffer(),
      waiting: new Set(),
    };
    this.tunnels.set(tunnel.id, tunnel);
    let buffer: Buffer = Buffer.alloc(0);
    let phase: 'hello' | 'socks' | 'connecting' | 'stream' = 'hello';
    const timeout = setTimeout(() => client.destroy(), 15000);
    const cleanup = () => {
      clearTimeout(timeout);
      this.tunnels.delete(tunnel.id);
      tunnel.upstream?.destroy();
      for (const wake of tunnel.waiting) wake();
    };
    client.on('close', cleanup);
    client.on('error', () => client.destroy());
    const establish = (
      host: string,
      port: number,
      protocol: 'http' | 'socks',
      consumed: number,
    ) => {
      phase = 'connecting';
      client.pause();
      client.removeListener('data', handshake);
      const tail = buffer.subarray(consumed);
      buffer = Buffer.alloc(0);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        client.destroy();
        return;
      }
      const upstream = connect({ host, port, allowHalfOpen: true });
      tunnel.upstream = upstream;
      upstream.setNoDelay(true);
      client.setNoDelay(true);
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => {
        client.destroy();
        for (const wake of tunnel.waiting) wake();
      });
      upstream.once('connect', () => {
        clearTimeout(timeout);
        phase = 'stream';
        client.write(
          protocol === 'http'
            ? 'HTTP/1.1 200 Connection Established\r\n\r\n'
            : Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
        );
        if (tail.length) upstream.write(tail);
        client.pipe(upstream);
        client.resume();
      });
      upstream.on('data', (data: Buffer) => {
        if (!client.write(data)) upstream.pause();
        for (const frame of tunnel.framer.feed(data)) this.observe(tunnel, frame);
        if (tunnel.framer.atBoundary) for (const wake of tunnel.waiting) wake();
      });
      client.on('drain', () => upstream.resume());
      upstream.on('end', () => client.end());
    };
    const handshake = (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 65536) {
        client.destroy();
        return;
      }
      if (phase === 'hello' && buffer[0] === 5) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        const count = buffer[1]!;
        if (!buffer.subarray(2, 2 + count).includes(0)) {
          client.end(Buffer.from([5, 255]));
          return;
        }
        client.write(Buffer.from([5, 0]));
        buffer = buffer.subarray(2 + count);
        phase = 'socks';
      }
      if (phase === 'socks') {
        if (buffer.length < 4) return;
        if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0) {
          client.destroy();
          return;
        }
        const type = buffer[3];
        const size =
          type === 1 ? 4 : type === 4 ? 16 : type === 3 && buffer.length >= 5 ? buffer[4]! : 0;
        if (!size || ![1, 3, 4].includes(type!)) {
          if (buffer.length >= 5) client.destroy();
          return;
        }
        const offset = type === 3 ? 5 : 4;
        if (buffer.length < offset + size + 2) return;
        const address = buffer.subarray(offset, offset + size);
        const host =
          type === 1
            ? [...address].join('.')
            : type === 3
              ? address.toString()
              : Array.from({ length: 8 }, (_, index) =>
                  address.readUInt16BE(index * 2).toString(16),
                ).join(':');
        establish(host, buffer.readUInt16BE(offset + size), 'socks', offset + size + 2);
      } else if (phase === 'hello') {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const match = /^CONNECT (\[[^\]]+\]|[^\s:]+):(\d+) HTTP\/1\.[01]\r\n/.exec(
          buffer.toString(),
        );
        if (!match) {
          client.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        establish(match[1]!.replace(/^\[|\]$/g, ''), Number(match[2]), 'http', end + 4);
      }
    };
    client.on('data', handshake);
  }

  private observe(tunnel: Tunnel, frame: Buffer) {
    try {
      const size = frame.readUInt32BE(10);
      if (size < 4 || size > 20 || 10 + size > frame.length) return;
      const uin = frame.subarray(14, 10 + size).toString();
      const credential = this.credentials.get(uin);
      if (!credential) return;
      const outer = parseServerFrame(frame, Buffer.from(credential.key, 'hex'));
      const inner = parseServerPlain(outer.plain);
      if (inner.command === 'trpc.msg.olpush.OlPushService.MsgPush')
        tunnel.template = { outer, inner, generation: credential.generation };
    } catch {
      /* 转发先完成，无法识别的事件等待下一条可解析模板。 */
    }
  }

  async deliver(uin: string, generation: string, identity: string, body: Buffer) {
    if (body.length > 8 * 1024 * 1024) throw new Error('同步事件过大');
    const tunnel = [...this.tunnels.values()]
      .reverse()
      .find((item) => item.template?.outer.uin === uin && item.template.generation === generation);
    if (!tunnel) throw new Error('等待 QQ 通过代理连接');
    const key = `${uin}:${generation}:${tunnel.id}:${identity}`;
    if (this.delivered.has(key)) return { delivered: true, duplicate: true };
    const started = Date.now();
    while (!tunnel.framer.atBoundary && !tunnel.client.destroyed && Date.now() - started < 10000)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          tunnel.waiting.delete(done);
          resolve();
        };
        const timer = setTimeout(done, 500);
        tunnel.waiting.add(done);
      });
    const credential = this.credentials.get(uin);
    const template = tunnel.template;
    if (
      !credential ||
      credential.generation !== generation ||
      !template ||
      template.generation !== generation ||
      !tunnel.framer.atBoundary ||
      tunnel.client.destroyed
    )
      throw new Error('QQ 会话已变化，等待重连');
    if (this.delivered.has(key)) return { delivered: true, duplicate: true };
    const plain = buildServerPlain({
      ...template.inner,
      sequence: 0x60000000 + (randomBytes(4).readUInt32BE() & 0x0fffffff),
      body,
      dataFlag: 0,
      retCode: 0,
    });
    const frame = buildServerFrame({
      ...template.outer,
      plain,
      key: Buffer.from(credential.key, 'hex'),
    });
    // 单线程同步 write 与上游 data 回调按事件循环串行，整帧追加在已识别边界。
    tunnel.client.write(frame);
    this.delivered.add(key);
    this.deliveredCount++;
    if (this.delivered.size > 10000) this.delivered.delete(this.delivered.values().next().value!);
    return { delivered: true, duplicate: false };
  }
}
