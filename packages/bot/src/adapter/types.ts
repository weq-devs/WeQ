/**
 * OneBot v11 适配层的传输无关类型。napcat 与 snowluma 都遵循 OneBot v11，
 * 差异只在少数 action 命名/字段，故用同一套 `OneBot11Adapter` 接口 + 两个实现。
 */
import type { AdapterType } from '../config';

/** OneBot 消息段：{ type, data }。收发通用（text/at/reply/image/record/face/...）。 */
export interface OneBotSegment {
  type: string;
  data: Record<string, unknown>;
}

/** 从 ws 收到的原始事件（OneBot v11 上报）。只声明我们会读的字段，其余透传。 */
export interface IncomingEvent {
  post_type?: string; // 'message' | 'meta_event' | 'notice' | 'request'
  message_type?: 'private' | 'group';
  sub_type?: string;
  message_id?: number | string;
  user_id?: number | string;
  group_id?: number | string;
  /** 段数组（array 上报格式）或纯字符串（string 上报格式）。 */
  message?: OneBotSegment[] | string;
  raw_message?: string;
  sender?: { user_id?: number | string; nickname?: string; card?: string };
  self_id?: number | string;
  [k: string]: unknown;
}

/** 发送目标：私聊或群，peerId = user_id 或 group_id。 */
export interface SendTarget {
  chatType: 'private' | 'group';
  peerId: string;
}

/**
 * OneBot v11 适配器统一接口。上层编排（Orchestrator）只依赖它，不关心 napcat/snowluma 差异。
 * 扩展点：新增主动能力时优先用 callAction（OneBot 原生 action），无需改接口。
 */
export interface OneBot11Adapter {
  readonly type: AdapterType;
  /** 建立连接（正向 ws 客户端）。resolve 表示已 open。 */
  connect(): Promise<void>;
  /** 主动关闭（停止重连）。 */
  close(): void;
  /** 发一条消息（内部按 adapter 选 send_msg / send_group_msg / send_private_msg）。 */
  sendMessage(target: SendTarget, segments: OneBotSegment[]): Promise<{ messageId?: string }>;
  /** 调任意 OneBot action（撤回 delete_msg / 戳一戳 send_poke / 查群成员 ... 的统一入口）。 */
  callAction(action: string, params: Record<string, unknown>): Promise<unknown>;
  /** 注册上报事件回调（message / notice / meta_event 等）。 */
  onEvent(handler: (event: IncomingEvent) => void): void;
}
