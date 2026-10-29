import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

const segmentSchema = z.object({ type: z.string(), data: z.record(z.unknown()) });
export type Segment = z.infer<typeof segmentSchema>;
export interface BridgeMessage {
  key: string;
  peerType: 'c2c' | 'group';
  targetId: string;
  senderUin: number;
  nickname: string;
  time: number;
  sequence: number;
  message: Segment[];
}
export interface OneBotBackend {
  status(): { online: boolean; good: boolean };
  self(): Promise<{ user_id: number; nickname: string }>;
  group(id: string): Promise<{ group_id: number; group_name: string }>;
  send(
    target: { peerType: 'c2c' | 'group'; targetId: string },
    segments: Segment[],
    reply?: BridgeMessage,
  ): Promise<BridgeMessage>;
  typing(id: string, event: number): Promise<void>;
  subscribe(deliver: (message: BridgeMessage) => void): () => void;
}
const requestSchema = z.object({
  action: z.string(),
  params: z.record(z.unknown()).nullish(),
  echo: z.unknown().optional(),
});

function positiveId(value: unknown): string {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0)
    throw new Error('QQ 号或群号无效');
  return text;
}

function unescapeCq(text: string): string {
  return text
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

/** cc-connect 的文本回复含 CQ:reply；先分段再反转义，避免把正文转义符误作控制段。 */
export function parseSegments(value: unknown, autoEscape = false): Segment[] {
  if (typeof value !== 'string') return z.array(segmentSchema).min(1).max(256).parse(value);
  if (autoEscape) return [{ type: 'text', data: { text: value } }];
  const segments: Segment[] = [];
  let offset = 0;
  for (const match of value.matchAll(/\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index > offset)
      segments.push({ type: 'text', data: { text: unescapeCq(value.slice(offset, match.index)) } });
    const data: Record<string, string> = {};
    for (const part of (match[2] ?? '').split(',').filter(Boolean)) {
      const equals = part.indexOf('=');
      if (equals < 1) throw new Error('CQ 参数无效');
      data[part.slice(0, equals)] = unescapeCq(part.slice(equals + 1));
    }
    segments.push({ type: match[1]!, data });
    offset = match.index + match[0].length;
  }
  if (offset < value.length)
    segments.push({ type: 'text', data: { text: unescapeCq(value.slice(offset)) } });
  if (!segments.length || segments.length > 256) throw new Error('消息不能为空或超过 256 段');
  return segments;
}

/** 仅提供 cc-connect 使用的 OneBot v11 子集，账号切换时整个实例销毁。 */
export class OneBotServer {
  private readonly server: http.Server;
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });
  private readonly records = new Map<number, BridgeMessage>();
  private readonly keys = new Map<string, number>();
  private readonly media = new Map<string, { path: string; expires: number }>();
  private unsubscribe: (() => void) | null = null;
  private active = false;
  private selfId = 0;
  private port = 0;
  private clients = new Set<WebSocket>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly backend: OneBotBackend,
    private readonly token: string,
  ) {
    this.server = http.createServer((req, res) => {
      void this.serveMedia(req, res);
    });
    this.server.on('upgrade', (req, socket, head) => {
      if (!this.active || req.headers.authorization !== `Bearer ${this.token}`) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      this.sockets.handleUpgrade(req, socket, head, (ws) => {
        this.clients.add(ws);
        ws.on('error', () => ws.terminate());
        ws.on('close', () => this.clients.delete(ws));
        let pending = 0;
        ws.on('message', (raw) => {
          if (++pending > 32) {
            ws.close(1008, 'Too many requests');
            return;
          }
          void this.handle(raw.toString())
            .then((reply) => {
              this.write(ws, reply);
            })
            .finally(() => {
              pending--;
            });
        });
        this.write(ws, {
          time: Math.floor(Date.now() / 1000),
          self_id: this.selfId,
          post_type: 'meta_event',
          meta_event_type: 'lifecycle',
          sub_type: 'connect',
        });
      });
    });
  }

  async start(port: number): Promise<number> {
    if (!this.token) throw new Error('OneBot 访问令牌不能为空');
    this.selfId = (await this.backend.self()).user_id;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('OneBot 监听地址无效');
    this.port = address.port;
    this.active = true;
    this.unsubscribe = this.backend.subscribe((msg) => {
      if (!this.active || msg.senderUin === this.selfId) return;
      const existing = this.keys.has(msg.key);
      const id = this.remember(msg);
      if (existing) return;
      const event = {
        ...this.wire(msg, id),
        post_type: 'message',
        self_id: this.selfId,
        sub_type: msg.peerType === 'group' ? 'normal' : 'friend',
        font: 0,
      };
      for (const ws of this.clients) this.write(ws, event);
    });
    this.heartbeat = setInterval(() => {
      for (const ws of this.clients)
        this.write(ws, {
          time: Math.floor(Date.now() / 1000),
          self_id: this.selfId,
          post_type: 'meta_event',
          meta_event_type: 'heartbeat',
          status: this.backend.status(),
          interval: 15000,
        });
    }, 15000);
    this.heartbeat.unref();
    return this.port;
  }

  stop(): void {
    this.active = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    this.sockets.close();
    this.server.close();
    this.server.closeAllConnections();
    this.records.clear();
    this.keys.clear();
    this.media.clear();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  reference(msg: BridgeMessage): number {
    for (const [id, record] of this.records) {
      if (
        record.peerType === msg.peerType &&
        record.targetId === msg.targetId &&
        record.senderUin === msg.senderUin &&
        record.sequence === msg.sequence
      )
        return id;
    }
    return this.remember(msg);
  }

  mediaUrl(path: string): string {
    const key = randomBytes(24).toString('hex');
    this.media.set(key, { path, expires: Date.now() + 10 * 60 * 1000 });
    while (this.media.size > 512) this.media.delete(this.media.keys().next().value!);
    return `http://127.0.0.1:${this.port}/media/${key}`;
  }

  private async serveMedia(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const item = this.media.get((req.url ?? '').replace(/^\/media\//, ''));
    if (
      !this.active ||
      req.method !== 'GET' ||
      !req.url?.startsWith('/media/') ||
      !item ||
      item.expires < Date.now()
    ) {
      res.writeHead(404).end();
      return;
    }
    try {
      const info = await stat(item.path);
      if (!this.active || !info.isFile() || info.size > 64 * 1024 * 1024) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-length': info.size,
        'cache-control': 'no-store',
      });
      const stream = createReadStream(item.path);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  }

  private write(ws: WebSocket, data: unknown): void {
    if (!this.active || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 4 * 1024 * 1024) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(data), (error) => {
      if (error) ws.terminate();
    });
  }

  private remember(msg: BridgeMessage): number {
    const known = this.keys.get(msg.key);
    if (known !== undefined) return known;
    // cc-connect 的引用上下文是 int32；不能把 QQ 的 64 位 msgId 直接转为 JS number。
    let id = -((createHash('sha256').update(msg.key).digest().readUInt32BE(0) % 2147483647) + 1);
    while (this.records.has(id)) id = id === -2147483647 ? -1 : id - 1;
    // get_msg 只需定位/展示信息，不把每次回传的 Base64 附件长驻消息缓存。
    let remaining = 16384;
    const message = msg.message.slice(0, 256).map((segment): Segment => {
      const data: Record<string, string> = {};
      for (const key of ['text', 'qq', 'id', 'name', 'url', 'file']) {
        if (remaining <= 0) break;
        const value = segment.data[key];
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        const text = String(value);
        data[key] = (text.startsWith('base64://') ? '[附件]' : text).slice(
          0,
          Math.min(remaining, key === 'text' ? 16384 : 2048),
        );
        remaining -= data[key]!.length;
      }
      return { type: segment.type, data };
    });
    this.records.set(id, { ...msg, message });
    this.keys.set(msg.key, id);
    if (this.records.size > 4096) {
      const oldest = this.records.entries().next().value!;
      this.records.delete(oldest[0]);
      this.keys.delete(oldest[1].key);
    }
    return id;
  }

  private wire(msg: BridgeMessage, id: number): Record<string, unknown> {
    return {
      time: msg.time,
      message_type: msg.peerType === 'group' ? 'group' : 'private',
      message_id: id,
      user_id: msg.senderUin,
      ...(msg.peerType === 'group' ? { group_id: Number(msg.targetId) } : {}),
      sender: { user_id: msg.senderUin, nickname: msg.nickname, card: '' },
      message: msg.message,
      raw_message: msg.message
        .filter((s) => s.type === 'text')
        .map((s) => s.data.text)
        .join(''),
    };
  }

  private async handle(raw: string): Promise<unknown> {
    let echo: unknown = null;
    try {
      const request = requestSchema.parse(JSON.parse(raw));
      echo = request.echo ?? null;
      if (!this.active) throw new Error('OneBot 服务已停止');
      const p = request.params ?? {};
      let data: unknown;
      switch (request.action) {
        case 'get_login_info':
          data = await this.backend.self();
          break;
        case 'get_status':
          data = this.backend.status();
          break;
        case 'get_version_info':
          data = { app_name: 'WeQ', app_version: 'OneBot bridge', protocol_version: 'v11' };
          break;
        case 'get_group_info':
          data = await this.backend.group(positiveId(p.group_id));
          break;
        case 'get_msg': {
          const id = Number(p.message_id);
          const msg = this.records.get(id);
          if (!msg) throw new Error('消息不在当前 OneBot 会话缓存中');
          data = { ...this.wire(msg, id), real_id: id };
          break;
        }
        case 'set_input_status':
          await this.backend.typing(
            positiveId(p.user_id),
            z
              .number()
              .int()
              .min(0)
              .max(10)
              .parse(p.event_type ?? 1),
          );
          data = {};
          break;
        case 'send_private_msg':
        case 'send_group_msg':
        case 'send_msg':
        case 'upload_group_file':
        case 'upload_private_file': {
          const group =
            request.action === 'send_group_msg' ||
            request.action === 'upload_group_file' ||
            (request.action === 'send_msg' && p.message_type === 'group');
          const target = {
            peerType: group ? ('group' as const) : ('c2c' as const),
            targetId: positiveId(group ? p.group_id : p.user_id),
          };
          const segments = request.action.startsWith('upload_')
            ? [{ type: 'file', data: { file: p.file, name: p.name } }]
            : parseSegments(p.message, p.auto_escape === true);
          const replies = segments.filter((s) => s.type === 'reply');
          if (replies.length > 1) throw new Error('只支持一个引用段');
          const reply = replies[0] ? this.records.get(Number(replies[0].data.id)) : undefined;
          if (
            replies.length &&
            (!reply || reply.peerType !== target.peerType || reply.targetId !== target.targetId)
          )
            throw new Error('引用消息已过期或属于其他会话');
          if (reply && reply.sequence <= 0) throw new Error('引用消息缺少 QQ 序号');
          const sent = await this.backend.send(
            target,
            segments.filter((s) => s.type !== 'reply'),
            reply,
          );
          if (!this.active) throw new Error('账号已关闭，发送结果未在当前会话登记');
          data = { message_id: this.remember(sent) };
          break;
        }
        default:
          return {
            status: 'failed',
            retcode: 1404,
            data: null,
            message: `不支持的 OneBot action：${request.action}`,
            echo,
          };
      }
      return { status: 'ok', retcode: 0, data, echo };
    } catch (error) {
      return {
        status: 'failed',
        retcode: 1400,
        data: null,
        message: error instanceof Error ? error.message : 'OneBot 请求失败',
        echo,
      };
    }
  }
}
