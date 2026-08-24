/**
 * 解码器：把一条消息的原始 protobuf 字节直接映射成业务需要的简化结构，
 * 不再保留 PUSH_MSG_BODY 的完整 proto 树，只保留：
 *   head      msgType / subType / c2cCmd / msgId / sequence / timestamp
 *   sender    发送者 uin / uid
 *   session   会话 uin / uid（群聊=群号，私聊=对方）
 *   elements  元素列表（按 ELEM schema 解码，装扮/发送者信息 elem 已剔除）
 *   dress     装扮：bubble / font / widget（font 优先 font1，回退 font2 字节交换转换）
 */

import { decode } from '../protobuf';
import { PUSH_MSG_BODY } from './schemas';

export interface DecodedDress {
  /** 气泡 itemId，无则为 0（elem tag 9.1）。 */
  bubble: number;
  /** 字体 itemId：优先 font1（generalFlags tag 19.56），回退 font2 字节交换转换（tag 19.15）。 */
  font: number;
  /** 挂件 itemId，无则为 0（generalFlags tag 17）。 */
  widget: number;
}

/** 41531 式回退字体：低 16 位字节序交换后才是真实 font_id。 */
function decodeFallbackFontId(stored: number): number {
  if (!stored) return 0;
  return ((stored & 0xff) << 8) | ((stored >>> 8) & 0xff);
}

export interface DecodedMessage {
  head: {
    msgType: number;
    subType: number;
    c2cCmd: number;
    msgId: number;
    sequence: number;
    timestamp: number;
  };
  sender: { uin: number; uid: string };
  session: { uin: number; uid: string };
  elements: Record<string, unknown>[];
  dress: DecodedDress;
}

/** 把原始消息字节解码成简化 Message。 */
export function decodeMessage(bytes: Uint8Array): DecodedMessage {
  const raw = decode(PUSH_MSG_BODY, bytes) as {
    responseHead?: {
      fromUin?: number;
      fromUid?: string;
      toUin?: number;
      toUid?: string;
      grp?: { groupUin?: number };
    };
    contentHead?: {
      msgType?: number;
      subType?: number;
      c2cCmd?: number;
      msgId?: number;
      sequence?: number;
      timestamp?: number;
    };
    body?: { richText?: { elems?: Record<string, unknown>[] } };
  };

  const head = raw.contentHead ?? {};
  const sender = raw.responseHead ?? {};
  const grp = raw.responseHead?.grp ?? {};
  const elems = raw.body?.richText?.elems ?? [];

  // 装扮和元素无关：散落在 elems 里的装扮 elem 只用于聚合 dress，不进 elements。
  const dress: DecodedDress = { bubble: 0, font: 0, widget: 0 };
  const elements: Record<string, unknown>[] = [];
  for (const elem of elems) {
    const gf = elem.generalFlags as
      | { widgetId?: number; font?: { fontId1?: number; fontId2?: number } }
      | undefined;
    if (gf) {
      dress.widget = gf.widgetId ?? dress.widget;
      const font1 = gf.font?.fontId1 ?? 0;
      const font2 = gf.font?.fontId2 ?? 0;
      dress.font = font1 !== 0 ? font1 : decodeFallbackFontId(font2);
      continue;
    }
    const bubble = elem.bubble as { id?: number } | undefined;
    if (bubble) {
      dress.bubble = bubble.id ?? dress.bubble;
      continue;
    }
    // extraInfo 是发送者昵称/名片等，也不需要。
    if (elem.extraInfo) continue;
    elements.push(elem);
  }

  return {
    head: {
      msgType: head.msgType ?? 0,
      subType: head.subType ?? 0,
      c2cCmd: head.c2cCmd ?? 0,
      msgId: head.msgId ?? 0,
      sequence: head.sequence ?? 0,
      timestamp: head.timestamp ?? 0,
    },
    sender: { uin: sender.fromUin ?? 0, uid: sender.fromUid ?? '' },
    session: { uin: grp.groupUin ?? sender.toUin ?? 0, uid: sender.toUid ?? '' },
    elements,
    dress,
  };
}
