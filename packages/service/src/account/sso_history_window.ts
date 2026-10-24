import {
  decodeMessage,
  extractPath,
  type fetchGroupHistoryRaw,
  type fetchC2cHistoryRaw,
} from '@weq/protocol';
import { assertRoamingPageIdentity, toGapMessage, type GapFetchedMessage } from './gap_history';
import type { RoamingTarget } from './roaming_backfill';

export interface ProtocolHistoryObservation {
  kind: 'group' | 'c2c';
  conv: string;
  msgSeq: number;
  protocolRaw: string;
  /**
   * - `missing_message_identity`：槽位有 peer/seq 但没有任何消息身份（群里的空槽）。
   * - `duplicate_message_identity`：同一窗内出现两条 `${seq}:${id}` 相同的记录。
   *   典型来源是私聊通话记录 —— 它挂靠在宿主消息上、复用宿主的 seq 与 newId，
   *   所以服务端会为同一个 seq 回两条（见 `docs/database/nt_msg/row.md` 的同 seq 约定）。
   */
  reason: 'missing_message_identity' | 'duplicate_message_identity';
}

/**
 * 群里的「空槽位」：有 peer/seq，但没有任何消息身份。
 *
 * 保持群专属 —— 私聊走 `assertRoamingPageIdentity` 严格核验，不放松。
 */
function isIncompleteGroupSlot(
  conv: string,
  decoded: ReturnType<typeof decodeMessage>,
  newId: bigint,
  window: { start: number; end: number },
): boolean {
  return (
    decoded.head.msgType === 82 &&
    String(decoded.session.uin) === conv &&
    Number.isSafeInteger(decoded.head.sequence) &&
    decoded.head.sequence >= window.start &&
    decoded.head.sequence <= window.end &&
    decoded.head.timestamp === 0 &&
    decoded.head.msgId === 0 &&
    newId === 0n &&
    decoded.sender.uin === 0 &&
    decoded.sender.uid === ''
  );
}

type HistoryResponse =
  | Awaited<ReturnType<typeof fetchGroupHistoryRaw>>
  | Awaited<ReturnType<typeof fetchC2cHistoryRaw>>;

/** 产品使用的单窗解码器；调度、预算与断点由调用方负责。 */
export function decodeSsoHistoryWindow(
  response: HistoryResponse,
  target: RoamingTarget,
  selfUin: string,
  window: { start: number; end: number },
) {
  if (
    (target.kind === 'group' ? String(response.peer.groupUin) : response.peer.friendUid) !==
    target.conv
  )
    throw Error('SSO 历史响应会话不一致。');
  if (response.rawResponse.length > 16 * 1024 * 1024 || response.messages.length > 500)
    throw Error('SSO 历史小窗响应超过安全上限。');
  const observations: ProtocolHistoryObservation[] = [];
  const messages: GapFetchedMessage[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < response.messages.length; i++) {
    const raw = extractPath(
      response.rawResponse,
      target.kind === 'group' ? [{ tag: 3 }, { tag: 6, index: i }] : [{ tag: 7, index: i }],
    );
    if (!raw) throw Error('纯协议历史消息原始字节不完整。');
    const decoded = decodeMessage(raw);
    const header = response.messages[i]!.responseHead as { toUin?: number } | undefined;
    // Group records can omit the recipient; the authenticated session and group still bind them.
    if (
      target.kind === 'group' &&
      header?.toUin !== undefined &&
      header.toUin !== 0 &&
      String(header.toUin) !== selfUin
    )
      throw Error('纯协议群历史响应账号不一致。');
    const content = response.messages[i]!.contentHead as { newId?: bigint } | undefined;
    // Some group slots have a valid peer/seq but no message identity. Keep evidence, not coverage.
    if (
      target.kind === 'group' &&
      isIncompleteGroupSlot(target.conv, decoded, content?.newId ?? 0n, window)
    ) {
      observations.push({
        kind: 'group',
        conv: target.conv,
        msgSeq: decoded.head.sequence,
        protocolRaw: Buffer.from(raw).toString('base64'),
        reason: 'missing_message_identity',
      });
      continue;
    }
    assertRoamingPageIdentity(target.kind, target.conv, selfUin, decoded, window.start, window.end);
    const id =
      content?.newId && content.newId > 0n ? content.newId.toString() : String(decoded.head.msgId);
    if (!/^[1-9]\d*$/.test(id)) throw Error('纯协议历史消息缺少精确标识。');
    const key = `${decoded.head.sequence}:${id}`;
    if (ids.has(key)) {
      // 同 seq 同 ID 的第二条：服务端确实会回（私聊通话记录挂靠宿主消息，复用宿主的
      // seq 与 newId）。缓存表主键本来就是 (kind,conv,msg_seq,msg_id)，两条存不下，
      // 所以这里去重并留证据，而不是让一条挂靠记录把整窗 30 条一起判失败。
      observations.push({
        kind: target.kind,
        conv: target.conv,
        msgSeq: decoded.head.sequence,
        protocolRaw: Buffer.from(raw).toString('base64'),
        reason: 'duplicate_message_identity',
      });
      continue;
    }
    ids.add(key);
    messages.push({
      ...toGapMessage(target.kind, target.conv, decoded),
      sourceFormat: 'protocol',
      msgId: id,
      msgRandom: String(decoded.head.msgId),
      protocolRaw: Buffer.from(raw).toString('base64'),
    });
  }

  return { messages, observations };
}
