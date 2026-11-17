import type { Message } from './types';

const messageTimeDividerIntervalMs = 5 * 60 * 1000;

export function shouldShowMessageTime(previous: Message | undefined, current: Message) {
  if (!previous) {
    return true;
  }

  const previousTime = new Date(previous.createdAt).getTime();
  const currentTime = new Date(current.createdAt).getTime();
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) {
    return false;
  }

  return currentTime - previousTime >= messageTimeDividerIntervalMs;
}
