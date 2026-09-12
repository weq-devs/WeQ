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

  /**
   * 连接（含断线重连的统一入口）：只在首次 open 时 resolve，之后断线由内部
   * 自愈重试——初始连接失败（napcat 还没起 / ws 地址暂时不可达）不会 reject，
   * 否则导出的 bot 会因一次 ECONNREFUSED 直接退出，用户 `pnpm start` 就报错。
   * 只有主动 close()（this.closed=true）才停。
   */
  connect(): Promise<void> {
    this.closed = false;
    return new Promise((resolve) => {
      const attempt = (): void => {
        if (this.closed) return;
        const headers: Record<string, string> = {};
        if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
        const ws = new WebSocket(this.cfg.wsUrl, { headers });
        this.ws = ws;
        let settled = false;
        const cleanup = (): void => {
          ws.off('open', onOpen);
          ws.off('message', onMessage);
          ws.off('close', onClose);
          ws.off('error', onError);
        };
        const onOpen = (): void => {
          if (settled) return;
          settled = true;
          // 注意：这里不能 cleanup()——message/close/error 监听器要继续存活到断线为止。
          resolve();
        };
        const onMessage = (data: RawData): void => this.onRaw(data.toString());
        const onClose = (): void => {
          cleanup();
          this.ws = null;
          this.rejectAllPending('ws 连接已关闭');
          // 初始连接失败 / 断线统一走重连（幂等：已有定时器则不重复排）。
          if (!this.closed && !this.reconnectTimer) {
            if (!settled) {
              console.warn(
                `[bot] ws 连接 ${this.cfg.wsUrl} 失败，${(this.cfg.reconnectDelayMs ?? 3000) / 1000}s 后自动重试…`,
              );
            }
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              attempt();
            }, this.cfg.reconnectDelayMs ?? 3000);
          }
        };
        const onError = (): void => {
          // error 后通常跟着 close；保险起见把未关闭的 ws 关掉，让 close 统一收尾重连。
          if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
            ws.close();
          }
        };
        ws.on('open', onOpen);
        ws.on('message', onMessage);
        ws.on('close', onClose);
        ws.on('error', onError);
      };
      attempt();
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

  abstract sendMessage(
    target: SendTarget,
    segments: OneBotSegment[],
  ): Promise<{ messageId?: string }>;

  /** 子类发消息后统一解析回包里的 message_id。 */
  protected async send(
    action: string,
    params: Record<string, unknown>,
  ): Promise<{ messageId?: string }> {
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
      target.chatType === 'group'
        ? { group_id: Number(target.peerId) }
        : { user_id: Number(target.peerId) };
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
