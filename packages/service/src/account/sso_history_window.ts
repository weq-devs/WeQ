import {
  decodeMessage,
  extractPath,
  type fetchGroupHistoryRaw,
  type fetchC2cHistoryRaw,
} from '@weq/protocol';
import { assertRoamingPageIdentity, toGapMessage, type GapFetchedMessage } from './gap_history';
import type { RoamingTarget } from './roaming_backfill';

export interface ProtocolHistoryObservation {
  kind: 'group';
  conv: string;
  msgSeq: number;
  protocolRaw: string;
  reason: 'missing_message_identity';
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
      String(decoded.session.uin) === target.conv &&
      Number.isSafeInteger(decoded.head.sequence) &&
      decoded.head.sequence >= window.start &&
      decoded.head.sequence <= window.end &&
      decoded.head.msgType === 82 &&
      decoded.head.timestamp === 0 &&
      decoded.head.msgId === 0 &&
      (content?.newId ?? 0n) === 0n &&
      decoded.sender.uin === 0 &&
      decoded.sender.uid === ''
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
    if (ids.has(key)) throw Error('纯协议历史响应包含重复消息标识。');
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
