export const NOTICE_SEEN_LIMIT = 4096;
export type NoticeSeenState = { seen: string[]; readThrough: number };

/** 使用原始记录时间，不受昵称、资料补齐或申请状态影响。 */
export function noticeTimestamp(id: string): number | null {
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
