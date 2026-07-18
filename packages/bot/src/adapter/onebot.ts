/**
 * OneBot v11 正向 ws 客户端基类 + napcat/snowluma 两实现 + 工厂。
 *
 * 连接：bot 作为 ws 客户端连 napcat/snowluma 的 ws 服务（Authorization: Bearer token），
 * 断线自动重连。RPC：发 { action, params, echo }，按 echo 匹配回包 resolve/reject（带超时）。
 * 差异（仅此一处）：napcat 发消息用 send_group_msg/send_private_msg 分离；snowluma 用 send_msg + message_type。
 */
import { WebSocket, type RawData } from 'ws';
import type { AdapterConfig, AdapterType } from '../config';
import type { IncomingEvent, OneBot11Adapter, OneBotSegment, SendTarget } from './types';

interface PendingCall {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export abstract class BaseOneBotAdapter implements OneBot11Adapter {
  abstract readonly type: AdapterType;

  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private readonly handlers: Array<(event: IncomingEvent) => void> = [];
  private echoSeq = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(protected readonly cfg: AdapterConfig) {}

  connect(): Promise<void> {
    this.closed = false;
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
      const ws = new WebSocket(this.cfg.wsUrl, { headers });
      this.ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        resolve();
      });
      ws.on('message', (data: RawData) => this.onRaw(data.toString()));
      ws.on('close', () => {
        this.ws = null;
        this.rejectAllPending('ws 连接已关闭');
        if (!this.closed) this.scheduleReconnect();
      });
      ws.on('error', (err: Error) => {
        if (!opened) reject(err);
        // open 之后的错误交给 close 事件触发重连
      });
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  callAction(action: string, params: Record<string, unknown>): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`ws 未连接，无法调用 action: ${action}`));
    }
    this.echoSeq += 1;
    const echo = `${action}-${this.echoSeq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = this.cfg.actionTimeoutMs ?? 15000;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`action ${action} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  onEvent(handler: (event: IncomingEvent) => void): void {
    this.handlers.push(handler);
  }

  abstract sendMessage(target: SendTarget, segments: OneBotSegment[]): Promise<{ messageId?: string }>;

  /** 子类发消息后统一解析回包里的 message_id。 */
  protected async send(action: string, params: Record<string, unknown>): Promise<{ messageId?: string }> {
    const data = (await this.callAction(action, params)) as { message_id?: number | string } | null;
    const id = data?.message_id;
    return { messageId: id != null ? String(id) : undefined };
  }

  private onRaw(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return; // 非 JSON 帧忽略
    }
    // action 回包（带 echo，匹配挂起的调用）。
    if (msg.echo !== undefined) {
      const key = String(msg.echo);
      const call = this.pending.get(key);
      if (call) {
        this.pending.delete(key);
        clearTimeout(call.timer);
        const ok = msg.retcode === 0 || msg.status === 'ok';
        if (ok) call.resolve(msg.data);
        else call.reject(new Error(`action 失败: ${text.slice(0, 300)}`));
        return;
      }
    }
    // 上报事件（message / notice / meta_event / request）。
    if (typeof msg.post_type === 'string') {
      const event = msg as IncomingEvent;
      for (const h of this.handlers) {
        try {
          h(event);
        } catch {
          /* 单个 handler 抛错不影响其它 */
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.cfg.reconnectDelayMs ?? 3000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private rejectAllPending(reason: string): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

/** napcat：发消息用 send_group_msg / send_private_msg 分离接口。 */
export class NapcatAdapter extends BaseOneBotAdapter {
  readonly type = 'napcat' as const;

  sendMessage(target: SendTarget, segments: OneBotSegment[]): Promise<{ messageId?: string }> {
    if (target.chatType === 'group') {
      return this.send('send_group_msg', { group_id: Number(target.peerId), message: segments });
    }
    return this.send('send_private_msg', { user_id: Number(target.peerId), message: segments });
  }
}

/** snowluma：发消息用统一的 send_msg + message_type 字段。 */
export class SnowLumaAdapter extends BaseOneBotAdapter {
  readonly type = 'snowluma' as const;

  sendMessage(target: SendTarget, segments: OneBotSegment[]): Promise<{ messageId?: string }> {
    const idField =
      target.chatType === 'group' ? { group_id: Number(target.peerId) } : { user_id: Number(target.peerId) };
    return this.send('send_msg', { message_type: target.chatType, ...idField, message: segments });
  }
}

/** 按 config.adapter.type 造对应适配器。 */
export function createAdapter(cfg: AdapterConfig): OneBot11Adapter {
  switch (cfg.type) {
    case 'napcat':
      return new NapcatAdapter(cfg);
    case 'snowluma':
      return new SnowLumaAdapter(cfg);
    default:
      throw new Error(`未知 adapter 类型: ${String((cfg as AdapterConfig).type)}`);
  }
}
