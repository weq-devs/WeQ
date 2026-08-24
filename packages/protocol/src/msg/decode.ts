/**
 * 解码器：把一条消息的原始 protobuf 字节直接映射成业务需要的简化结构，
 * 不再保留 PUSH_MSG_BODY 的完整 proto 树，只保留：
 *   head      msgType / subType / c2cCmd / msgId / sequence / timestamp
 *   sender    发送者 uin / uid
 *   session   会话 uin / uid（群聊=群号，私聊=对方）
 *   elements  元素列表（按 ELEM schema 解码，原样保留）
 *   dress     装扮三件套：气泡 / 字体(1/2) / 挂件
 */

import { decode } from '../protobuf';
import { PUSH_MSG_BODY } from './schemas';

export interface DecodedDress {
  /** 气泡 itemId，无则为 0（elem tag 9.1）。 */
  bubbleId: number;
  /** 字体 id_1，无则为 0（generalFlags tag 19.56）。 */
  fontId1: number;
  /** 字体 id_2，无则为 0（generalFlags tag 19.15）。 */
  fontId2: number;
  /** 挂件 itemId，无则为 0（generalFlags tag 17）。 */
  widgetId: number;
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

  // 装扮三个 id 固定在固定 tag 上，散落在 elems 里，扫一遍即可。
  const dress: DecodedDress = { bubbleId: 0, fontId1: 0, fontId2: 0, widgetId: 0 };
  for (const elem of elems) {
    const gf = elem.generalFlags as
      | { widgetId?: number; font?: { fontId1?: number; fontId2?: number } }
      | undefined;
    if (gf) {
      dress.widgetId = gf.widgetId ?? dress.widgetId;
      dress.fontId1 = gf.font?.fontId1 ?? dress.fontId1;
      dress.fontId2 = gf.font?.fontId2 ?? dress.fontId2;
    }
    const bubble = elem.bubble as { id?: number } | undefined;
    if (bubble) dress.bubbleId = bubble.id ?? dress.bubbleId;
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
    elements: elems,
    dress,
  };
}
