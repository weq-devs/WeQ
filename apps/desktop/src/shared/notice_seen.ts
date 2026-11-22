import type { AccountNoticeRead } from '@weq/service';

export const NOTICE_SEEN_LIMIT = 4096;
export type NoticeSeenState = Pick<AccountNoticeRead, 'seen' | 'readThrough'>;
export type NoticeReadSnapshot = AccountNoticeRead;
export type GroupNoticeRead = NonNullable<NoticeReadSnapshot['qqGroupRead']>;

export function newerGroupNoticeRead(current?: string, incoming?: string): string | undefined {
  const valid = (value: string | undefined): value is string =>
    Boolean(value && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn);
  if (!valid(current)) return valid(incoming) ? incoming : undefined;
  return valid(incoming) && BigInt(incoming) > BigInt(current) ? incoming : current;
}

/** 使用原始记录时间，不受昵称、资料补齐或申请状态影响。 */
export function noticeTimestamp(id: string): number | null {
  const sequence = /^group-notify-seq:(?:normal|filtered):(\d{1,20})$/.exec(id)?.[1];
  if (sequence) {
    const time = Number(BigInt(sequence) / 1000n);
    return Number.isSafeInteger(time) && time > 0 ? time : null;
  }
  const match = /^(?:buddy-request:[^:]+|group-notify:[^:]+:[^:]*):(\d+)$/.exec(id);
  if (!match) return null;
  const time = Number(match[1]);
  return Number.isSafeInteger(time) && time > 0 ? time : null;
}

export function mergeNoticeSeen(
  previous: NoticeSeenState | null | undefined,
  incoming: NoticeSeenState,
): NoticeSeenState {
  const seen = [...new Set([...(previous?.seen ?? []), ...incoming.seen])].sort(
    (a, b) => (noticeTimestamp(a) ?? 0) - (noticeTimestamp(b) ?? 0) || a.localeCompare(b),
  );
  return {
    seen: seen.slice(-NOTICE_SEEN_LIMIT),
    readThrough: seen.reduce(
      (latest, id) => Math.max(latest, noticeTimestamp(id) ?? 0),
      Math.max(previous?.readThrough ?? 0, incoming.readThrough),
    ),
  };
}
