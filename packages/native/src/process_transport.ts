import type { NtHelperBinding } from './types';

type ProcessTransport = Pick<
  NtHelperBinding,
  | 'sendPacket'
  | 'sendOidbPacket'
  | 'sendPacketByPid'
  | 'sendOidbPacketByPid'
  | 'sendPacketBySession'
>;

export function withProcessTransport<T extends ProcessTransport>(binding: T): T {
  if (!binding.sendPacketByPid && !binding.sendOidbPacketByPid) return binding;
  // WeQ 的业务参数仍是 QQ PID；保留原始 addon 的会话 ID 接口供其他消费者使用。
  return {
    ...binding,
    sendPacketBySession: binding.sendPacketByPid ? binding.sendPacket.bind(binding) : undefined,
    sendPacket: (binding.sendPacketByPid ?? binding.sendPacket).bind(binding),
    sendOidbPacket: (binding.sendOidbPacketByPid ?? binding.sendOidbPacket).bind(binding),
  };
}
