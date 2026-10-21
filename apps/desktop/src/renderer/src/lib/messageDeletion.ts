import type { Message } from '../im-template/template/types';

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
