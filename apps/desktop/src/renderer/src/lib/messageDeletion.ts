import type { Message } from '../im-template/template/types';
import { timelineSeq } from '../../../shared/roaming_timeline';

export function deletionIdentity(id: string): string {
  return id.replace(/^roaming:(?:native:|protocol:)/, 'roaming:');
}

/** 隐藏缓存重开后已不在消息页内，仍可从完整身份取回其序号。 */
export function hiddenDeletionSequences(
  messages: readonly Message[],
  hidden: ReadonlySet<string>,
): string[] {
  const sequences = new Set<string>();
  for (const id of hidden) {
    const match = /^roaming:(?:(?:native|protocol):)?([1-9]\d*):-?\d+$/.exec(id);
    if (match) sequences.add(match[1]!);
  }
  for (const message of messages) {
    if (hidden.has(message.id) && message.msgSeq && /^[1-9]\d*$/.test(message.msgSeq))
      sequences.add(message.msgSeq);
  }
  return [...sequences];
}

/** 隐藏记录只随消息／删除快照建一次索引，每行缺口不再扫描整份删除列表。 */
export function hiddenDeletionLookup(messages: readonly Message[], hidden: ReadonlySet<string>) {
  const sequences = hiddenDeletionSequences(messages, hidden)
    .map(BigInt)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return (previousSeq: unknown, currentSeq: unknown): boolean => {
    if (!sequences.length || typeof previousSeq !== 'string' || typeof currentSeq !== 'string')
      return false;
    const previous = timelineSeq(previousSeq),
      current = timelineSeq(currentSeq);
    if (previous === null || current === null || current <= previous) return false;
    let low = 0,
      high = sequences.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (sequences[middle]! <= previous) low = middle + 1;
      else high = middle;
    }
    return low < sequences.length && sequences[low]! < current;
  };
}
