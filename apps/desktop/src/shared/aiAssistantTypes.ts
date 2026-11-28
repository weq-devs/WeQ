/**
 * AI 助手（小Q，chatType 45）的 IPC wire 类型。
 *
 * 主进程 serde 与渲染层共用；真正的形状由 `@weq/service` 的
 * `AiAssistantMessage` 决定（服务层已完成流式片段折叠与卡片切分）。
 */

import type { AiMarkdownSegment } from '@weq/codec';

export type AiSegmentWire = AiMarkdownSegment;

/** 会话列表行。 */
export interface AiAssistantSessionWire {
  sessionId: string;
  /** 是否小Q 主入口（sessionId 10000）。 */
  isMain: boolean;
  title: string;
  messageCount: number;
  sendTime: string;
  preview: string;
}

/** 一条 AI 消息。 */
export interface AiAssistantMessageWire {
  msgId: string;
  msgSeq: string;
  sendTime: string;
  /** true = 我发的，false = AI 发的。 */
  mine: boolean;
  senderUid: string;
  segments: AiSegmentWire[];
  /** 其余元素（推荐消息 / 操作栏 / 图片），已转 RenderElement。 */
  elements: unknown[];
  /** 该条回复带授权申请。 */
  needsAuth: boolean;
}
