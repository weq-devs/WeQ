import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../shared/router';
import { resolveAvatar } from './avatarResolver';

export interface GroupBulletinImage {
  id: string;
  width: number;
  height: number;
}
export interface GroupBulletinWire {
  fid: string;
  publisherUid: string;
  textContent: string;
  ctime: string;
  msgTime: string;
  publisherName?: string;
  publisherAvatar?: string;
  images?: GroupBulletinImage[];
  readNum?: number;
}
type OnlineNotice = inferRouterOutputs<AppRouter>['account']['qqActions']['notices'][number];
export interface GroupNoticeEntry {
  key: string;
  noticeId?: string;
  publisherUid: string;
  publisherUin?: string;
  publisherName?: string;
  publisherAvatar?: string;
  text: string;
  date: string;
  images: GroupBulletinImage[];
  readNum?: number;
}
function localDate(value: string): string {
  // 无时区的本地格式保留原日期，不猜成 UTC 再做时区平移。
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]|$)/.exec(value);
  if (local && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return `${local[1]}/${local[2]}/${local[3]}`;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? dateText(time) : '';
}
function dateText(time: number): string {
  if (!Number.isFinite(time) || time <= 0 || time > 8.64e15) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(time));
}
export function decodeGroupBulletinText(text: string): string {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text;
  return textarea.value;
}
/** 在线页只覆盖本次返回的公告；缺项不等于本地历史已被远端删除。 */
export function mergeGroupNotices(
  local: GroupBulletinWire[],
  online?: OnlineNotice[],
): GroupNoticeEntry[] {
  const originals = new Map(local.filter((item) => item.fid).map((item) => [item.fid, item]));
  const seen = new Set<string>();
  const rows: GroupNoticeEntry[] = [];
  for (const [index, item] of (online ?? []).entries()) {
    if (item.noticeId && seen.has(item.noticeId)) continue;
    if (item.noticeId) seen.add(item.noticeId);
    const original = originals.get(item.noticeId);
    rows.push({
      key: item.noticeId ? `notice:${item.noticeId}` : `remote:${index}`,
      noticeId: item.noticeId || undefined,
      publisherUid: original?.publisherUid || String(item.senderId || ''),
      publisherUin: item.senderId > 0 ? String(item.senderId) : undefined,
      publisherName: original?.publisherName,
      publisherAvatar: original?.publisherAvatar,
      text: decodeGroupBulletinText(item.text),
      date:
        Number.isFinite(item.publishTime) && item.publishTime > 0
          ? dateText(item.publishTime * 1000)
          : original
            ? localDate(original.ctime || original.msgTime)
            : '',
      images: item.images,
      readNum: item.readNum,
    });
  }
  for (const [index, item] of local.entries()) {
    if (item.fid && seen.has(item.fid)) continue;
    if (item.fid) seen.add(item.fid);
    rows.push({
      key: item.fid ? `notice:${item.fid}` : `local:${index}`,
      publisherUid: item.publisherUid,
      publisherName: item.publisherName,
      publisherAvatar: item.publisherAvatar,
      text: decodeGroupBulletinText(item.textContent),
      date: localDate(item.ctime || item.msgTime),
      images: item.images ?? [],
      readNum: item.readNum,
    });
  }
  return rows;
}

interface NoticeMember {
  uid: string;
  uin: string;
  card: string;
  nick: string;
}
interface NoticeProfile {
  uid: string;
  uin: string;
  nick: string;
  remark: string;
  avatarUrl: string;
}
export function resolveGroupNoticePublishers(
  entries: GroupNoticeEntry[],
  members: NoticeMember[],
  profiles: NoticeProfile[],
): GroupNoticeEntry[] {
  const memberByIdentity = new Map<string, NoticeMember>();
  const profileByIdentity = new Map<string, NoticeProfile>();
  for (const member of members) {
    memberByIdentity.set(member.uid, member);
    if (member.uin !== '0') memberByIdentity.set(member.uin, member);
  }
  for (const profile of profiles) {
    profileByIdentity.set(profile.uid, profile);
    if (profile.uin !== '0') profileByIdentity.set(profile.uin, profile);
  }
  return entries.map((entry) => {
    const member =
      memberByIdentity.get(entry.publisherUid) || memberByIdentity.get(entry.publisherUin || '');
    const profile =
      profileByIdentity.get(member?.uid || entry.publisherUid) ||
      profileByIdentity.get(entry.publisherUin || '');
    const uin = [member?.uin, profile?.uin, entry.publisherUin, entry.publisherUid].find(
      (value) => value && /^[1-9]\d{4,19}$/.test(value),
    );
    return {
      ...entry,
      publisherUin: uin,
      publisherName:
        entry.publisherName?.trim() ||
        profile?.remark?.trim() ||
        member?.card?.trim() ||
        member?.nick?.trim() ||
        profile?.nick?.trim() ||
        undefined,
      publisherAvatar:
        entry.publisherAvatar ||
        resolveAvatar({ uin, profileAvatarUrl: profile?.avatarUrl, size: 100 }) ||
        undefined,
    };
  });
}
