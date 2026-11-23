import type { UnreadInfoSnapshot } from '@weq/db';

type SnapshotField = Exclude<
  keyof UnreadInfoSnapshot,
  'decreasedSeqs' | 'highlights' | 'recalledSeqs'
>;
type Highlight = NonNullable<UnreadInfoSnapshot['highlights']>[number];

const snapshotFields = Object.keys({
  peer: true,
  chatType: true,
  uid: true,
  msgSeq: true,
  localReadSeq: true,
  markUnread: true,
  storedUnreadCount: true,
  localUnreadCount: true,
  deviceRead: true,
  deviceIncomingTime: true,
  latestSeq: true,
  deviceLatest: true,
  latestSenderUid: true,
  latestSeqNonMessage: true,
  readError: true,
} satisfies Record<SnapshotField, true>) as SnapshotField[];

const highlightFields = Object.keys({
  kind: true,
  rawKind: true,
  msgSeq: true,
  senderUid: true,
  sendTime: true,
  text: true,
} satisfies Record<keyof Highlight, true>) as (keyof Highlight)[];

function sameItems<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
  equal: (a: T, b: T) => boolean,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++)
    if (!equal(left[index]!, right[index]!)) return false;
  return true;
}

const sameSequence = (a: string, b: string) => a === b;
function sameHighlight(a: Highlight, b: Highlight): boolean {
  if (a === b) return true;
  for (const key of highlightFields) if (a[key] !== b[key]) return false;
  return true;
}

export function sameUnreadSequences(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return sameItems(left, right, sameSequence);
}

/** 对账按实际水位和提醒字段比较，不为每一行重复构造 JSON。 */
export function sameUnreadSnapshot(
  left: UnreadInfoSnapshot | undefined,
  right: UnreadInfoSnapshot,
): boolean {
  if (left === right) return true;
  if (!left) return false;
  for (const key of snapshotFields) if (left[key] !== right[key]) return false;
  return (
    sameUnreadSequences(left.decreasedSeqs, right.decreasedSeqs) &&
    sameUnreadSequences(left.recalledSeqs, right.recalledSeqs) &&
    sameItems(left.highlights, right.highlights, sameHighlight)
  );
}
