import * as timeFormat from '@weq/time';

/** "3 小时 / 12 分钟后过期" or "已过期", from create + ttl (both unix seconds). */
export function formatExpiry(
  createTime: number,
  ttlSeconds: number,
): { text: string; expired: boolean } {
  const at = (createTime + ttlSeconds) * 1000;
  const expired = at <= Date.now();
  if (!Number.isFinite(at) || createTime <= 0) return { text: '到期时间未知', expired };
  return {
    text: `${timeFormat.formatDateTime(at)}（${expired ? '已过期' : timeFormat.formatRelativeTime(at)}）`,
    expired,
  };
}
