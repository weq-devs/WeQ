import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { MessageRegistry, type MessageLocation } from './registry';
import {
  ActionError,
  bool,
  id as positiveId,
  integer,
  parseSegments,
  sendTarget,
  serializeSegments,
  type Params,
  type Segment,
} from './contracts';
export { parseSegments } from './contracts';
export type { Segment } from './contracts';

export interface BridgeMessage {
  key: string;
  peerType: 'c2c' | 'group';
  targetId: string;
  senderUin: number;
  nickname: string;
  time: number;
  sequence: number;
  message: Segment[];
  fileId?: string;
  fileName?: string;
  fileSize?: number;
  location?: MessageLocation;
}
export interface OneBotBackend {
  status(): { online: boolean; good: boolean } | Promise<{ online: boolean; good: boolean }>;
  self(): Promise<{ user_id: number; nickname: string }>;
  group(id: string, noCache?: boolean): Promise<{ group_id: number; group_name: string }>;
  version?(): string;
  action?(action: string, params: Params): Promise<unknown>;
  registry?: MessageRegistry;
  readMessage?(message: BridgeMessage): Promise<BridgeMessage | null>;
  recall?(message: BridgeMessage): Promise<void>;
  reaction?(message: BridgeMessage, code: string, isSet: boolean): Promise<void>;
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

/** 正向 WebSocket 与媒体服务；账号切换时整个实例销毁。 */
export class OneBotServer {
  private readonly server: http.Server;
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });
  private readonly records = new Map<number, BridgeMessage>();
  private readonly registry: MessageRegistry;
  private readonly media = new Map<string, { path: string; expires: number }>();
  private unsubscribe: (() => void) | null = null;
  private active = false;
  private selfId = 0;
  private port = 0;
  private clients = new Set<WebSocket>();
  private readonly paths = new WeakMap<WebSocket, string>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly backend: OneBotBackend,
    private readonly token: string,
  ) {
    this.registry = backend.registry ?? new MessageRegistry();
    this.server = http.createServer((req, res) => {
      void this.serveMedia(req, res);
    });
    this.server.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (!['/', '/api', '/event'].includes(path)) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      if (!this.active || req.headers.authorization !== `Bearer ${this.token}`) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      this.sockets.handleUpgrade(req, socket, head, (ws) => {
        this.clients.add(ws);
        this.paths.set(ws, path);
        ws.on('error', () => ws.terminate());
        ws.on('close', () => this.clients.delete(ws));
        let pending = 0;
        ws.on('message', (raw) => {
          if (path === '/event') return;
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
        if (path !== '/api')
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
      if (!this.active) return;
      const existing = this.registry.find(msg) !== undefined;
      const id = this.remember(msg);
      if (existing || msg.senderUin === this.selfId) return;
      const event = {
        ...this.wire(msg, id),
        post_type: 'message',
        self_id: this.selfId,
        sub_type: msg.peerType === 'group' ? 'normal' : 'friend',
        font: 0,
      };
      for (const ws of this.clients) if (this.paths.get(ws) !== '/api') this.write(ws, event);
    });
    this.heartbeat = setInterval(() => {
      void Promise.resolve(this.backend.status())
        .catch(() => ({ online: false, good: false }))
        .then((status) => {
          for (const ws of this.clients)
            if (this.paths.get(ws) !== '/api')
              this.write(ws, {
                time: Math.floor(Date.now() / 1000),
                self_id: this.selfId,
                post_type: 'meta_event',
                meta_event_type: 'heartbeat',
                status,
                interval: 15000,
              });
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
    this.registry.flush();
    this.media.clear();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  reference(msg: BridgeMessage): number {
    return this.remember(msg);
  }

  register(msg: BridgeMessage): number {
    return this.remember(msg);
  }

  async resolve(id: number): Promise<BridgeMessage> {
    const known = this.registry.get(id);
    const hot = this.records.get(id);
    if (!known) throw new ActionError('消息 ID 不存在或已过期', 1404);
    if (this.backend.readMessage && (known.location || !hot?.message.length)) {
      const full = await this.backend.readMessage(known);
      if (!this.active) throw new ActionError('账号已关闭');
      if (full) {
        this.remember(full);
        return full;
      }
      throw new ActionError('原消息不可回查', 1404);
    }
    return hot ?? known;
  }

  messageData(msg: BridgeMessage): Record<string, unknown> {
    return this.wire(msg, this.remember(msg));
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
    const id = this.registry.remember(msg);
    // get_msg 只需定位/展示信息，不把每次回传的 Base64 附件长驻消息缓存。
    let remaining = 16384;
    const message = msg.message.slice(0, 256).map((segment): Segment => {
      const data: Record<string, string> = {};
      for (const key of ['text', 'qq', 'id', 'name', 'url', 'file', 'file_id', 'file_size']) {
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
    const previous = this.records.get(id);
    this.records.set(id, { ...msg, message: message.length ? message : (previous?.message ?? []) });
    if (this.records.size > 4096) {
      const oldest = this.records.entries().next().value!;
      this.records.delete(oldest[0]);
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
      ...(msg.peerType === 'group' ? { anonymous: null } : {}),
      message: msg.message,
      raw_message: serializeSegments(msg.message),
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
          data = await this.backend.status();
          break;
        case 'get_version_info':
          data = {
            app_name: 'WeQ',
            app_version: this.backend.version?.() ?? 'unknown',
            protocol_version: 'v11',
          };
          break;
        case 'get_group_info':
          data = await this.backend.group(positiveId(p.group_id), bool(p.no_cache));
          break;
        case 'get_msg': {
          const id = integer(p.message_id, undefined, -2147483647, 2147483647);
          const msg = await this.resolve(id);
          data = { ...this.wire(msg, id), real_id: id };
          break;
        }
        case 'delete_msg':
        case 'set_msg_emoji_like': {
          const msg = await this.resolve(integer(p.message_id, undefined, -2147483647, 2147483647));
          if (request.action === 'delete_msg') {
            if (!this.backend.recall) throw new ActionError('撤回不可用', 1404);
            await this.backend.recall(msg);
          } else {
            if (!this.backend.reaction) throw new ActionError('表情回应不可用', 1404);
            await this.backend.reaction(msg, String(p.emoji_id ?? ''), bool(p.set, true));
          }
          data = null;
          break;
        }
        case 'set_input_status':
          await this.backend.typing(positiveId(p.user_id), integer(p.event_type, 1, 1, 1));
          data = {};
          break;
        case 'send_private_msg':
        case 'send_group_msg':
        case 'send_msg':
        case 'upload_group_file':
        case 'upload_private_file': {
          const target = sendTarget(request.action, p);
          const segments = request.action.startsWith('upload_')
            ? [
                {
                  type: 'file',
                  data: { file: p.file, name: p.name, folder: p.folder ?? p.folder_id },
                },
              ]
            : parseSegments(p.message, bool(p.auto_escape));
          const replies = segments.filter((s) => s.type === 'reply');
          if (replies.length > 1) throw new Error('只支持一个引用段');
          const reply = replies[0]
            ? await this.resolve(integer(replies[0].data.id, undefined, -2147483647, 2147483647))
            : undefined;
          if (
            replies.length &&
            (!reply || reply.peerType !== target.peerType || reply.targetId !== target.targetId)
          )
            throw new Error('引用消息已过期或属于其他会话');
          if (reply && reply.sequence <= 0) throw new Error('引用消息缺少 QQ 序号');
          // 先预留可持久化的 ID，索引无法写入时不派发 QQ 发送。
          const pendingKey = `outgoing:${randomBytes(16).toString('hex')}`;
          this.remember({
            ...target,
            key: pendingKey,
            senderUin: this.selfId,
            nickname: '',
            time: Math.floor(Date.now() / 1000),
            sequence: 0,
            message: [],
          });
          const sent = await this.backend.send(
            target,
            segments.filter((s) => s.type !== 'reply'),
            reply,
          );
          if (!this.active) throw new Error('账号已关闭，发送结果未在当前会话登记');
          data = {
            message_id: this.remember({ ...sent, key: pendingKey }),
            ...(request.action.startsWith('upload_') ? { file_id: sent.fileId } : {}),
          };
          break;
        }
        default:
          if (!this.backend.action)
            throw new ActionError(`不支持的 OneBot action：${request.action}`, 1404);
          data = await this.backend.action(request.action, p);
      }
      return { status: 'ok', retcode: 0, data, echo };
    } catch (error) {
      return {
        status: 'failed',
        retcode: error instanceof ActionError ? error.retcode : 1400,
        data: null,
        message: error instanceof Error ? error.message : 'OneBot 请求失败',
        echo,
      };
    }
  }
}
