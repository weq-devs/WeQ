import { createServer, connect, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  buildServerFrame,
  buildServerPlain,
  parseServerFrame,
  parseServerPlain,
  decodedBody,
  inspectRecallPush,
} from '@weqbot/protocol/qq-sync';
import type { RecallJournal } from './recall_journal';

export interface SyncCredential {
  uin: string;
  key: string;
  generation: string;
  selfUid?: string;
}
export interface RecallPolicy {
  owner: string;
  enabled: boolean;
  block: boolean;
  all: boolean;
  targets: { kind: 'c2c' | 'group' | 'dataline'; id: string }[];
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
  filtering?: boolean;
  fragmentTimer?: ReturnType<typeof setTimeout>;
}

/** 登录前导字节透传，已识别的完整 MSF 帧供解密和边界判断。 */
export class FrameBuffer {
  private buffer: Buffer = Buffer.alloc(0);
  private aligned = false;
  get atBoundary() {
    return this.aligned && this.buffer.length === 0;
  }
  get pending(): Buffer {
    return this.buffer;
  }
  flush(): Buffer {
    const pending = this.buffer;
    this.buffer = Buffer.alloc(0);
    this.aligned = false;
    return pending;
  }
  feed(chunk: Buffer): Buffer[] {
    return this.parts(chunk)
      .filter((part) => part.frame)
      .map((part) => part.data);
  }
  parts(chunk: Buffer): { frame: boolean; data: Buffer }[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: { frame: boolean; data: Buffer }[] = [];
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
        const end = positions.length ? Math.min(...positions) - 4 : this.buffer.length;
        frames.push({ frame: false, data: this.buffer.subarray(0, end) });
        this.buffer = this.buffer.subarray(end);
        continue;
      }
      if (this.buffer.length < length) break;
      frames.push({ frame: true, data: this.buffer.subarray(0, length) });
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
  private readonly policies = new Map<
    string,
    { value: RecallPolicy; expires: number; generation: string }
  >();
  private lastRecallError = '';
  private filteredRecalls = 0;
  constructor(private readonly journal?: RecallJournal) {}

  setRecallPolicy(uin: string, generation: string, value: RecallPolicy) {
    if (this.credentials.get(uin)?.generation !== generation) throw new Error('QQ 会话已变化');
    this.policies.set(uin, { value, expires: Date.now() + 10000, generation });
  }
  takeRecallEvents(uin: string, generation: string, ack: string[]) {
    const policy = this.policies.get(uin);
    if (!policy || policy.generation !== generation) throw new Error('QQ 会话已变化');
    return this.journal?.take(policy.value.owner, ack) ?? [];
  }
  private recallPolicy(uin: string) {
    const policy = this.policies.get(uin);
    return policy &&
      policy.expires > Date.now() &&
      policy.value.enabled &&
      policy.generation === this.credentials.get(uin)?.generation
      ? policy.value
      : undefined;
  }

  setCredential(value: SyncCredential) {
    if (!/^\d{4,16}$/.test(value.uin) || !/^[a-f\d]{32}$/i.test(value.key))
      throw new Error('账号会话无效');
    this.credentials.set(value.uin, value);
  }
  forget(uin: string) {
    this.credentials.delete(uin);
    this.policies.delete(uin);
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
      recallError: this.lastRecallError,
      filteredRecalls: this.filteredRecalls,
    };
  }
  async start(port: number, persist?: () => Promise<void>) {
    const server = createServer({ allowHalfOpen: true }, (client) => {
      if (this.server === server) this.accept(client);
      else client.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address() as { port: number };
    try {
      await persist?.();
    } catch (error) {
      server.close();
      throw error;
    }
    const previous = this.server;
    this.server = server;
    // 已建立的 QQ 隧道继续转发，旧地址停止接收新连接。
    previous?.close();
    return address.port;
  }
  async close() {
    for (const tunnel of this.tunnels.values()) {
      clearTimeout(tunnel.fragmentTimer);
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
      clearTimeout(tunnel.fragmentTimer);
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
        clearTimeout(tunnel.fragmentTimer);
        if (tunnel.framer.atBoundary) {
          tunnel.filtering = Boolean(
            tunnel.template && this.recallPolicy(tunnel.template.outer.uin)?.block,
          );
        }
        if (tunnel.filtering) {
          for (const part of tunnel.framer.parts(data)) {
            const output = part.frame ? this.observe(tunnel, part.data, true) : part.data;
            if (output && !client.write(output)) upstream.pause();
          }
        } else {
          if (!client.write(data)) upstream.pause();
          for (const frame of tunnel.framer.feed(data)) this.observe(tunnel, frame);
        }
        if (tunnel.filtering && !tunnel.framer.atBoundary && tunnel.framer.pending.length) {
          tunnel.fragmentTimer = setTimeout(() => {
            // 无完整帧时保留观察缓冲并先透传已收字节，避免异常/慢分片堵住 QQ 连接。
            tunnel.filtering = false;
            if (!client.write(tunnel.framer.pending)) upstream.pause();
            this.lastRecallError = '推送分片等待超时，本帧已正常转发';
          }, 2000);
        }
        if (tunnel.framer.atBoundary) for (const wake of tunnel.waiting) wake();
      });
      client.on('drain', () => upstream.resume());
      upstream.on('end', () =>
        client.end(tunnel.filtering ? tunnel.framer.flush() : Buffer.alloc(0)),
      );
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

  private observe(tunnel: Tunnel, frame: Buffer, filtering = false): Buffer {
    try {
      const size = frame.readUInt32BE(10);
      if (size < 4 || size > 20 || 10 + size > frame.length) return frame;
      const uin = frame.subarray(14, 10 + size).toString();
      const credential = this.credentials.get(uin);
      if (!credential) return frame;
      const key = Buffer.from(credential.key, 'hex');
      const outer = parseServerFrame(frame, key);
      const inner = parseServerPlain(outer.plain);
      if (inner.command !== 'trpc.msg.olpush.OlPushService.MsgPush') return frame;
      tunnel.template = { outer, inner, generation: credential.generation };
      const policy = this.recallPolicy(uin);
      if (!policy || !credential.selfUid || !this.journal) return frame;
      const protects = (target: { kind: 'c2c' | 'group'; conv: string }) =>
        policy.all ||
        policy.targets.some((item) => item.kind === target.kind && item.id === target.conv);
      const inspected = inspectRecallPush(
        decodedBody(inner),
        credential.selfUid,
        protects,
        filtering && policy.block,
      );
      this.journal.append(policy.owner, inspected.observed);
      this.lastRecallError = '';
      if (!inspected.removed) return frame;
      const plain = buildServerPlain({ ...inner, body: inspected.body, dataFlag: 0 });
      const output = buildServerFrame({ ...outer, plain, key });
      this.filteredRecalls += inspected.removed;
      return output;
    } catch (error) {
      if (filtering) this.lastRecallError = (error as Error).message;
      return frame;
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
