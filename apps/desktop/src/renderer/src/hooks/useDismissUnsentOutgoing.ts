import type { Message } from '../im-template/template/types';
import { type OutgoingRemoval, rejectedOutgoingRemoval } from '../lib/localOutgoing';
import { useOutgoingRemoval } from './useOutgoingRemoval';

/**
 * 「可能未送达」占位（回执 seq=0）的一键移除。
 *
 * 这类占位没有可信序号，只能一直挂在时间线末尾；清掉它不影响对方是否收到，
 * 也不动原库 —— 迟到的真消息照样正常显示。
 */
export function useDismissUnsentOutgoing(
  apply: (remove: OutgoingRemoval) => void,
  refresh: (conversations: ReadonlySet<string>) => Promise<unknown>,
) {
  const remove = useOutgoingRemoval(apply, refresh);
  return (message: Message): boolean =>
    remove(rejectedOutgoingRemoval(message, message.conversationId), message.conversationId);
}
