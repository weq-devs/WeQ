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
  forwardId?: string;
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

export type OneBotNetworkType = 'ws' | 'http';

/** 一个监听器实际使用的启动参数。 */
export interface OneBotNetworkListenConfig {
  id: string;
  port: number;
  token: string;
  enableCors?: boolean;
}

export interface OneBotNetworkConfig {
  webSocketServers: OneBotNetworkListenConfig[];
  httpServers: OneBotNetworkListenConfig[];
}

/** 单个监听器的实时状态；`port` 是实际端口，端口冲突时会自动顺延。 */
export interface OneBotNetworkStatus {
  id: string;
  type: OneBotNetworkType;
  requestedPort: number;
  port: number;
  running: boolean;
  clients: number;
  error?: string;
}

interface NetworkListener {
  id: string;
  type: OneBotNetworkType;
  requestedPort: number;
  port: number;
  token: string;
  enableCors: boolean;
  server: http.Server;
  sockets: WebSocketServer | null;
  clients: Set<WebSocket>;
}

const PORT_FALLBACK_ATTEMPTS = 20;

/**
 * OneBot v11 服务集合。
 *
 * 动作分发、消息登记和媒体索引由本实例共享；每个 WS / HTTP 监听器独立
 * 绑定端口、独立鉴权，也独立出现在状态列表里。账号切换时整个实例销毁。
 */
export class OneBotServer {
  private readonly records = new Map<number, BridgeMessage>();
  private readonly registry: MessageRegistry;
  private readonly media = new Map<string, { path: string; expires: number }>();
  private readonly listeners = new Map<string, NetworkListener>();
  private lastStatuses: OneBotNetworkStatus[] = [];
  private unsubscribe: (() => void) | null = null;
  private active = false;
  private selfId = 0;
  private clients = new Set<WebSocket>();
  private readonly paths = new WeakMap<WebSocket, string>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly backend: OneBotBackend,
    private readonly legacyToken = '',
  ) {
    this.registry = backend.registry ?? new MessageRegistry();
  }

  /** 兼容旧调用：启动一个使用构造器令牌的正向 WS 服务器。 */
  async start(port: number): Promise<number> {
    const [status] = await this.startConfigured({
      webSocketServers: [{ id: 'legacy-ws', port, token: this.legacyToken }],
      httpServers: [],
    });
    if (!status?.running) throw new Error(status?.error ?? 'OneBot WebSocket 启动失败');
    return status.port;
  }

  /** 启动全部启用的监听器；单项端口冲突会顺延，不阻断其他服务器。 */
  async startConfigured(config: OneBotNetworkConfig): Promise<OneBotNetworkStatus[]> {
    if (this.active) throw new Error('OneBot 服务已经启动');
    this.selfId = (await this.backend.self()).user_id;
    this.active = true;
    const statuses: OneBotNetworkStatus[] = [];
    for (const [type, servers] of [
      ['ws', config.webSocketServers],
      ['http', config.httpServers],
    ] as const) {
      for (const item of servers) {
        const status = await this.startListener(type, item);
        statuses.push(status);
      }
    }
    this.lastStatuses = statuses;
    this.unsubscribe = statuses.some((status) => status.running && status.type === 'ws')
      ? this.backend.subscribe((msg) => {
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
        })
      : null;
    if (statuses.some((status) => status.running && status.type === 'ws')) {
      this.heartbeat = setInterval(() => {
        void this.serviceStatus()
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
    }
    return statuses;
  }

  stop(): void {
    this.active = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    for (const listener of this.listeners.values()) {
      for (const ws of listener.clients) ws.terminate();
      listener.sockets?.close();
      listener.server.close();
      listener.server.closeAllConnections();
    }
    this.listeners.clear();
    this.lastStatuses = [];
    this.records.clear();
    try {
      this.registry.flush();
    } catch (error) {
      console.error('OneBot 关闭时索引保存失败', error);
    }
    this.media.clear();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  networkStatus(): OneBotNetworkStatus[] {
    return this.lastStatuses.map((status) => {
      const listener = this.listeners.get(`${status.type}:${status.id}`);
      return {
        ...status,
        port: listener?.port ?? status.port,
        running: this.active && Boolean(listener),
        clients: listener?.clients.size ?? 0,
      };
    });
  }

  private async startListener(
    type: OneBotNetworkType,
    item: OneBotNetworkListenConfig,
  ): Promise<OneBotNetworkStatus> {
    const sockets =
      type === 'ws' ? new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 }) : null;
    const listener: NetworkListener = {
      id: item.id,
      type,
      requestedPort: item.port,
      port: item.port,
      token: item.token,
      enableCors: item.enableCors ?? true,
      server: http.createServer((req, res) => {
        if (type === 'http') void this.serveHttp(listener, req, res);
        else void this.serveMedia(req, res);
      }),
      sockets,
      clients: new Set(),
    };
    if (sockets) {
      listener.server.on('upgrade', (req, socket, head) => {
        this.handleUpgrade(listener, req, socket, head);
      });
    }
    try {
      listener.port = await this.listenWithFallback(listener.server, item.port);
      this.listeners.set(`${type}:${item.id}`, listener);
      return {
        id: item.id,
        type,
        requestedPort: item.port,
        port: listener.port,
        running: true,
        clients: 0,
      };
    } catch (error) {
      sockets?.close();
      listener.server.close();
      listener.server.closeAllConnections();
      return {
        id: item.id,
        type,
        requestedPort: item.port,
        port: item.port,
        running: false,
        clients: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async listenWithFallback(server: http.Server, requested: number): Promise<number> {
    const attempts = requested === 0 ? 1 : PORT_FALLBACK_ATTEMPTS;
    for (let offset = 0; offset < attempts; offset += 1) {
      const port = requested === 0 ? 0 : requested + offset;
      if (port > 65535) break;
      if (!(await tryListen(server, port))) continue;
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('OneBot 监听地址无效');
      return address.port;
    }
    throw new Error(
      `端口 ${requested}–${Math.min(requested + attempts - 1, 65535)} 都被占用，无法启动`,
    );
  }

  private handleUpgrade(
    listener: NetworkListener,
    req: http.IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): void {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (!['/', '/api', '/event'].includes(path)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!this.active || !this.authorized(listener, req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    listener.sockets!.handleUpgrade(req, socket, head, (ws) => {
      this.clients.add(ws);
      listener.clients.add(ws);
      this.paths.set(ws, path);
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        this.clients.delete(ws);
        listener.clients.delete(ws);
      });
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
            pending -= 1;
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

  forwardMessage(id: string): BridgeMessage | undefined {
    return this.registry.forward(id);
  }

  sourcePath(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return value;
    }
    if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/media/')) return value;
    const item = this.media.get(url.pathname.slice('/media/'.length));
    if (!item || item.expires < Date.now()) throw new ActionError('媒体引用已过期');
    return item.path;
  }

  prepare(target: { peerType: 'c2c' | 'group'; targetId: string }): string {
    if (!this.registry.healthy) throw new ActionError('消息索引无法持久化，尚未派发发送', 1500);
    const key = `outgoing:${randomBytes(16).toString('hex')}`;
    this.remember({
      ...target,
      key,
      senderUin: this.selfId,
      nickname: '',
      time: Math.floor(Date.now() / 1000),
      sequence: 0,
      message: [],
    });
    return key;
  }

  mediaUrl(path: string): string {
    const key = randomBytes(24).toString('hex');
    this.media.set(key, { path, expires: Date.now() + 10 * 60 * 1000 });
    while (this.media.size > 512) this.media.delete(this.media.keys().next().value!);
    const listener =
      [...this.listeners.values()].find((item) => item.type === 'ws') ??
      [...this.listeners.values()].find((item) => item.type === 'http');
    if (!listener) throw new Error('OneBot 没有运行中的监听器');
    return `http://127.0.0.1:${listener.port}/media/${key}`;
  }

  private authorized(listener: NetworkListener, req: http.IncomingMessage): boolean {
    if (!listener.token) return true;
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    let query = '';
    try {
      query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('access_token') ?? '';
    } catch {
      // URL 无效时按未鉴权处理。
    }
    return bearer === listener.token || query === listener.token;
  }

  private async serveHttp(
    listener: NetworkListener,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/media/')) {
      await this.serveMedia(req, res);
      return;
    }
    if (listener.enableCors) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(listener.enableCors ? 204 : 405).end();
      return;
    }
    if (!this.active) {
      sendJson(res, 503, {
        status: 'failed',
        retcode: 1500,
        data: null,
        message: 'OneBot 服务已停止',
      });
      return;
    }
    if (!this.authorized(listener, req)) {
      sendJson(res, 401, {
        status: 'failed',
        retcode: 1401,
        data: null,
        message: 'token 验证失败',
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      sendJson(res, 200, {
        status: 'ok',
        retcode: 0,
        data: { message: 'WeQ OneBot 服务正在运行' },
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, {
        status: 'failed',
        retcode: 1405,
        data: null,
        message: '仅支持 GET / POST',
      });
      return;
    }
    try {
      const query = Object.fromEntries(url.searchParams.entries());
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const pathParts = url.pathname.split('/').filter(Boolean);
      const envelopeAction = typeof body.action === 'string' ? body.action : '';
      const pathAction = pathParts.length === 1 ? decodeURIComponent(pathParts[0]!) : '';
      const action = envelopeAction || pathAction;
      if (!action) {
        sendJson(res, 404, {
          status: 'failed',
          retcode: 1404,
          data: null,
          message: '缺少 OneBot action',
        });
        return;
      }
      const rawParams = envelopeAction ? body.params : pathAction ? body : {};
      const params =
        rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
          ? { ...query, ...(rawParams as Record<string, unknown>) }
          : query;
      const echo = body.echo ?? query.echo ?? null;
      sendJson(res, 200, await this.respond(action, params, echo));
    } catch (error) {
      sendJson(res, 400, {
        status: 'failed',
        retcode: 1400,
        data: null,
        message: error instanceof Error ? error.message : 'OneBot 请求无效',
      });
    }
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

  private async serviceStatus(): Promise<{ online: boolean; good: boolean }> {
    const status = await this.backend.status();
    return { ...status, good: status.good && this.registry.healthy };
  }

  private async handle(raw: string): Promise<unknown> {
    let echo: unknown = null;
    try {
      const request = requestSchema.parse(JSON.parse(raw));
      echo = request.echo ?? null;
      if (!this.active) throw new Error('OneBot 服务已停止');
      return await this.respond(request.action, request.params ?? {}, echo);
    } catch (error) {
      return failedResponse(error, echo);
    }
  }

  private async respond(
    action: string,
    p: Record<string, unknown>,
    echo: unknown,
  ): Promise<unknown> {
    try {
      if (!this.active) throw new Error('OneBot 服务已停止');
      let data: unknown;
      switch (action) {
        case 'get_login_info':
          data = await this.backend.self();
          break;
        case 'get_status':
          data = await this.serviceStatus();
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
          if (action === 'delete_msg') {
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
          const target = sendTarget(action, p);
          const segments = action.startsWith('upload_')
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
          const pendingKey = this.prepare(target);
          const sent = await this.backend.send(
            target,
            segments.filter((s) => s.type !== 'reply'),
            reply,
          );
          if (!this.active) throw new Error('账号已关闭，发送结果未在当前会话登记');
          data = {
            message_id: this.remember({ ...sent, key: pendingKey }),
            ...(action.startsWith('upload_') ? { file_id: sent.fileId } : {}),
          };
          break;
        }
        default:
          if (!this.backend.action)
            throw new ActionError(`不支持的 OneBot action：${action}`, 1404);
          data = await this.backend.action(action, p);
      }
      return { status: 'ok', retcode: 0, data, echo };
    } catch (error) {
      return failedResponse(error, echo);
    }
  }
}

function tryListen(server: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: unknown, value?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value ?? {});
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 24 * 1024 * 1024) {
        finish(new Error('请求正文超过 24 MiB'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => finish(error));
    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        finish(undefined, {});
        return;
      }
      try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('请求正文必须是 JSON 对象');
        finish(undefined, value as Record<string, unknown>);
      } catch (error) {
        finish(error);
      }
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function failedResponse(error: unknown, echo: unknown): Record<string, unknown> {
  return {
    status: 'failed',
    retcode: error instanceof ActionError ? error.retcode : 1400,
    data: null,
    message: error instanceof Error ? error.message : 'OneBot 请求失败',
    echo,
  };
}
