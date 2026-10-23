import type { Message } from '../im-template/template/types';
import { failedOutgoingRemoval, type OutgoingRemoval } from '../lib/localOutgoing';
import { useOutgoingRemoval } from './useOutgoingRemoval';

/** 明确失败、且没有任何确认信号的本机占位 —— 右键「移除失败消息」/ 多选清理走这条。 */
export function useFailedOutgoingRemoval(
  apply: (remove: OutgoingRemoval) => void,
  refresh: (conversations: ReadonlySet<string>) => Promise<unknown>,
) {
  const remove = useOutgoingRemoval(apply, refresh);
  return (message: Message, convId: string) =>
    remove(failedOutgoingRemoval(message, convId), convId);
}
