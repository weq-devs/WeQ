/**
 * 43002 — the payload column of `draft_storage_table_v1`（草稿：输入了但还没
 * 点发送的内容）。行键是同表的 TEXT 列 `43001`。
 *
 * 表结构与字段含义见 `docs/database/nt_msg/draft-storage.md`。与同构的
 * `hidden_session_storage_table_v1`（同样是「外层 tag = 列号，内层一个子消息」）
 * 不同，这里的 43002 内层是**一条半成品消息**，tag 直接沿用消息行的约定：
 *
 *   40001  msgId      草稿恒为 0（没发送，还没有真实 msgId）
 *   40010  chatType   会话类型，枚举同 recent_contact 的 ChatType
 *   40021  targetUid  会话标识：c2c 是对端 uid，群是群号
 *   40022  —          观测到恒为空串，含义未定，原样保留
 *   40050  sendTime   草稿写入时间，unix 秒
 *   40800  elements   **直接是 `ElementWire`，可重复** —— 与消息行的
 *                     `{40800: {40800: ElementWire}}` 差一层，见下
 *   49079  —          观测到恒为 0，含义未定，原样保留
 *
 * `40800` 这层差异是实测出来的（2026-09-25，三条真实草稿）：草稿里的 40800
 * 外层就是 element 本体，不套 `MsgBody`。一条草稿可以带多个元素 —— 实测到
 * 「文本 + 图片」「文本 + 表情」「纯文本」三种组合，所以这里必须按 `repeated`
 * 声明，而不是只支持文档早期样本里的单段纯文本。
 */

import { ProtoField, ScalarType } from '../../core';
import { ElementWire } from './element';

export const DraftEntry = {
  /** 40001 — 草稿恒为 0。 */
  msgId: ProtoField(40001, ScalarType.UINT64, { optional: true }),
  /** 40010 — 会话类型（ChatType）。 */
  chatType: ProtoField(40010, ScalarType.UINT32, { optional: true }),
  /** 40021 — 会话标识：c2c 为对端 uid，群为群号。 */
  targetUid: ProtoField(40021, ScalarType.STRING, { optional: true }),
  /** 40022 — 观测恒为空串，含义未定。 */
  reserved40022: ProtoField(40022, ScalarType.STRING, { optional: true }),
  /** 40050 — 草稿写入时间，unix 秒。 */
  sendTime: ProtoField(40050, ScalarType.UINT64, { optional: true }),
  /**
   * 40800 — 草稿正文，**每个 tag-40800 就是一条完整的 element**（不套 MsgBody）。
   * 与消息行的 40800 同构（扁平信封，elementType 在 45002 判别）。
   */
  elements: ProtoField(40800, () => ElementWire, { optional: true, repeat: true }),
  /** 49079 — 观测恒为 0，含义未定。 */
  reserved49079: ProtoField(49079, ScalarType.UINT32, { optional: true }),
};

export const DraftBody = {
  entry: ProtoField(43002, () => DraftEntry, { optional: true }),
};
