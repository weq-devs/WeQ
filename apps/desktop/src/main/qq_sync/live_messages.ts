import { toGapMessage, type GapFetchedMessage } from '@weq/service/gap-history';
import { decodeMessageBodies, decodePushEnvelope } from '@weqbot/protocol';

const LIVE_WINDOW_MS = 30_000;
const LIMIT = 512;

export function decodeLiveMessages(
  body: Uint8Array,
  selfUid: string,
  selfUin: string,
  now: number,
) {
  const { messages } = decodePushEnvelope(body);
  const rows: GapFetchedMessage[] = [];
  if (!selfUid) return rows;
  for (const raw of messages) {
    const { contentHead: head, responseHead: peers } = raw;
    const group = peers?.grp?.groupUin;
    const age = now - (head?.timestamp ?? 0) * 1000;
    if (
      !head?.msgId ||
      !peers?.fromUid ||
      peers.fromUid === selfUid ||
      age < -5000 ||
      age > LIVE_WINDOW_MS ||
      !(group
        ? head.msgType === 82 && head.sequence
        : head.msgType === 166 &&
          !head.c2cCmd &&
          head.ntMsgSeq &&
          peers.toUid === selfUid &&
          String(peers.toUin) === selfUin) ||
      raw.body?.msgContent?.length ||
      raw.body?.richText?.notOnlineFile ||
      !raw.body?.richText?.elems?.length ||
      raw.body.richText.elems.some((element) =>
        Object.keys(element).some(
          (key) => key !== 'text' && key !== 'bubble' && key !== 'generalFlags',
        ),
      )
    )
      continue;
    const event = decodeMessageBodies([raw])[0];
    if (!event?.message.elements.length || event.message.elements.some((e) => e.kind !== 'text'))
      continue;
    const row = toGapMessage(
      group ? 'group' : 'c2c',
      group ? String(group) : peers.fromUid,
      event.message,
    );
    rows.push({ ...row, sourceFormat: 'protocol', msgRandom: String(head.msgId) });
  }
  return rows;
}

type IdentityRow = Pick<GapFetchedMessage, 'kind' | 'conv' | 'msgSeq' | 'msgRandom' | 'senderUid'>;

function key(row: IdentityRow) {
  if (!row.msgRandom || row.msgRandom === '0' || !row.senderUid) return undefined;
  return JSON.stringify([row.kind, row.conv, row.msgSeq, row.msgRandom, row.senderUid]);
}

export class LiveMessages {
  private readonly entries = new Map<string, { at: number; row?: GapFetchedMessage }>();

  private expire(now: number) {
    for (const [id, entry] of this.entries) {
      if (now - entry.at <= LIVE_WINDOW_MS && this.entries.size <= LIMIT) break;
      this.entries.delete(id);
    }
  }

  accept(rows: GapFetchedMessage[], now: number) {
    this.expire(now);
    const accepted = rows.filter((row) => {
      const id = key(row);
      if (!id || this.entries.has(id)) return false;
      this.entries.set(id, { at: now, row });
      return true;
    });
    this.expire(now);
    return accepted;
  }

  confirm(row: IdentityRow, now: number) {
    const id = key(row);
    if (!id) return;
    this.entries.delete(id);
    this.entries.set(id, { at: now });
    this.expire(now);
  }

  forConversation(kind: GapFetchedMessage['kind'], conv: string, now: number) {
    this.expire(now);
    return [...this.entries.values()].flatMap(({ row }) =>
      row?.kind === kind && row.conv === conv ? [row] : [],
    );
  }
}
