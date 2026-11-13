import { eventTimeFormatter } from '@weq/time';
import { bloodTypeText, chineseZodiacText, occupationText } from '@weq/protocol/profile-values';
import { educationDegree } from './profileEducation';
import { relationMeta } from './profileRelations';

export interface FieldHistoryRow {
  id: number;
  first_at: number;
  last_at: number;
  value: unknown;
}
export type FieldHistoryMode = 'trend' | 'changes' | 'collection' | 'gallery';
const trends = new Set([
  'level',
  'likes',
  'energy',
  'intimacy',
  'commonFriends',
  'memberCount',
  'maxMemberCount',
  'friendCount',
  'activityScore',
  'activeMemberCount',
  'grade',
  'groupLevel',
]);
const collections = new Set([
  'labels',
  'commonGroups',
  'school',
  'privileges',
  'marks',
  'dress',
  'questions',
  'relations',
]);
const dates = new Set(['addedAt', 'joinedAt', 'lastSpeakAt', 'muteUntil', 'createTime']);
const units: Record<string, string> = {
  level: '级',
  groupLevel: '级',
  grade: '级',
  likes: '次',
  commonFriends: '人',
  memberCount: '人',
  maxMemberCount: '人',
  friendCount: '人',
  activeMemberCount: '人',
  age: '岁',
};
export function fieldHistoryMode(field: string): FieldHistoryMode {
  if (trends.has(field)) return 'trend';
  if (['avatar', 'photos', 'qqShow'].includes(field)) return 'gallery';
  return collections.has(field) ? 'collection' : 'changes';
}
export function historyObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  if (value === undefined || historyObject(value).$type === 'undefined') return '未记录';
  if (value === null || value === '') return '已清空';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return '未识别的旧资料';
  return String(value);
}
export function historyNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
/** 索引只参与身份比较，媒体地址从同一原始观察补齐，不改变持久化内容。 */
export function fieldPhotoHistoryValue(value: unknown, original: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const album = historyObject(historyObject(original).extInfo).album;
  if (!Array.isArray(album)) return value;
  return value.map((item) => {
    const row = historyObject(item);
    const photo = album
      .map(historyObject)
      .find((v) => row.photoId != null && v.photoId === row.photoId);
    return photo ? { ...row, urls: photo.urls } : item;
  });
}
export function fieldHistoryText(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return text(value);
  if (dates.has(field) && typeof value === 'number') {
    if (value <= 1) return field === 'muteUntil' ? '未禁言' : '未记录';
    return value <= 253402271999 ? eventTimeFormatter.format(value * 1000) : '时间无效';
  }
  if (field === 'gender')
    return (
      ({ 0: '未设置', 1: '男', 2: '女', 255: '未设置' } as Record<string, string>)[String(value)] ??
      `性别编号 ${text(value)}`
    );
  if (field === 'age' && value === 0) return '未设置';
  if (field === 'role')
    return (
      ({ 0: '成员', 1: '群主', 2: '管理员' } as Record<string, string>)[String(value)] ??
      `角色编号 ${text(value)}`
    );
  if (field === 'freezeState')
    return value === 0 ? '正常' : value === 1 ? '已冻结' : `状态码 ${text(value)}`;
  if (field === 'relationship') return value ? '好友' : '非好友';
  if (field === 'category') return `分组编号 ${text(value)}`;
  if (field === 'direction')
    return value === 'incoming' ? '对方添加我' : value === 'outgoing' ? '我添加对方' : text(value);
  if (field === 'occupation') return occupationText(value) ?? '未设置';
  if (field === 'bloodType') return bloodTypeText(value) ?? '未设置';
  if (field === 'zodiac') return chineseZodiacText(value) ?? '未设置';
  const row = historyObject(value);
  if (field === 'birthday' && typeof value === 'object') {
    return (
      [
        row.birthYear ? `${row.birthYear} 年` : '',
        row.birthMonth ? `${row.birthMonth} 月` : '',
        row.birthDay ? `${row.birthDay} 日` : '',
      ]
        .filter(Boolean)
        .join(' ') || '未设置'
    );
  }
  if (field === 'region' && typeof value === 'object')
    return (
      [
        ...new Set([row.country, row.province, row.city].filter((v) => typeof v === 'string' && v)),
      ].join(' · ') || '未设置'
    );
  if (field === 'status' && typeof value === 'object') {
    const custom = historyObject(row.customStatus);
    const wording = custom.text ?? custom.desc;
    // 与现有 OnlineStatusService 的基础状态契约一致；未知扩展状态保留编号。
    const base =
      (
        {
          0: '离线',
          10: '在线',
          30: '离开',
          40: '隐身',
          50: '忙碌',
          60: 'Q我吧',
          70: '勿扰',
        } as Record<string, string>
      )[String(row.type)] ?? `状态编号 ${text(row.type)}`;
    return row.type === 10 && row.subType === 2000 && typeof wording === 'string' && wording
      ? `${base} · ${wording}`
      : `${base}${row.subType ? ` · 扩展状态 ${row.subType}` : ''}`;
  }
  if (typeof value === 'number')
    return `${value.toLocaleString('zh-CN')}${units[field] ? ` ${units[field]}` : ''}`;
  return text(value);
}

export interface HistoryItem {
  key: string;
  title: string;
  detail: string;
  image?: string;
}
const strings = (values: unknown[]) =>
  values.filter((v): v is string => typeof v === 'string' && Boolean(v));
/** 仅比较业务内容；头像地址、请求游标等元数据不作为条目变更。 */
export function fieldHistoryItems(field: string, value: unknown): HistoryItem[] {
  const root = historyObject(value);
  let items: unknown[] = Array.isArray(value) ? value : [];
  if (field === 'labels' && !Array.isArray(value))
    items = [root.labels, root.customLabels].flatMap((v) => (Array.isArray(v) ? v : []));
  if (field === 'dress') items = Array.isArray(root.items) ? root.items : items;
  if (field === 'marks' && Array.isArray(root.categories))
    items = root.categories.flatMap((v) => {
      const marks = historyObject(v).marks;
      return Array.isArray(marks)
        ? marks.filter((mark) => {
            const row = historyObject(mark);
            return row.isLightup || row.isWearing;
          })
        : [];
    });
  if (field === 'relations') {
    items = root.displayId == null ? [] : [{ id: root.displayId, display: true }];
    if (Array.isArray(root.preselectedIds))
      items.push(
        ...root.preselectedIds
          .filter((id) => id !== root.displayId)
          .map((id) => ({ id, display: false })),
      );
  }
  if (field === 'school' && typeof value === 'string' && value) items = [value];
  const mapped = items.map((item, index): HistoryItem => {
    if (typeof item !== 'object' || item === null)
      return { key: String(item), title: text(item), detail: '' };
    const row = historyObject(item);
    const key = String(
      row.id ??
        row.groupCode ??
        row.index ??
        row.bizId ??
        row.appId ??
        row.markId ??
        row.photoId ??
        index,
    );
    if (field === 'labels') return { key, title: text(row.text ?? row.content), detail: '' };
    if (field === 'commonGroups')
      return {
        key,
        title: text(row.name ?? row.groupName ?? row.groupCode),
        detail: row.groupCode ? `群号 ${row.groupCode}` : '',
      };
    if (field === 'school')
      return {
        key: String(row.schoolName ?? row.schoolId ?? key),
        title: text(row.schoolName ?? row.schoolId),
        detail: strings([
          row.departmentName,
          educationDegree(typeof row.degree === 'number' ? row.degree : null),
          row.enrollmentYear ? `${row.enrollmentYear} 年入学` : '',
          row.graduationYear ? `${row.graduationYear} 年毕业` : '',
          row.hidden === 1 ? '已隐藏' : '',
        ]).join(' · '),
      };
    if (field === 'privileges')
      return {
        key,
        title: `特权 ${row.bizId ?? key}`,
        detail: `${row.opened ? '已开通' : '未开通'}${typeof row.level === 'number' ? ` · ${row.level} 级` : ''}`,
      };
    if (field === 'dress')
      return {
        key,
        title: text(row.kind ?? row.name),
        detail: `${text(row.name)}${row.itemId ? ` · 编号 ${row.itemId}` : ' · 默认'}`,
      };
    if (field === 'marks')
      return {
        key,
        title: text(row.name ?? row.type ?? row.markId),
        detail: strings([
          typeof row.isLightup === 'boolean' ? (row.isLightup ? '已点亮' : '未点亮') : '',
          typeof row.level === 'number' ? `${row.level} 级` : '',
          typeof row.count === 'number' ? `进度 ${row.count}` : '',
          typeof row.lightupDays === 'number' ? `点亮 ${row.lightupDays} 天` : '',
          typeof row.actDays === 'number' && row.actDays > 0 ? `互动 ${row.actDays} 天` : '',
          row.isWearing ? '佩戴中' : '',
        ]).join(' · '),
      };
    if (field === 'relations')
      return {
        key,
        title: relationMeta(Number(row.id)).label,
        detail: row.display ? '当前展示' : '预选关系',
      };
    if (field === 'questions')
      return {
        key,
        title: text(row.question),
        detail: strings([
          row.answer == null ? '尚未回答' : `回答：${text(row.answer)}`,
          row.askedAt ? `提问于 ${fieldHistoryText('addedAt', row.askedAt)}` : '',
          row.answeredAt ? `回答于 ${fieldHistoryText('addedAt', row.answeredAt)}` : '',
          row.likes != null ? `${text(row.likes)} 人赞过` : '',
          row.comments != null ? `${text(row.comments)} 条评论` : '',
        ]).join('\n'),
      };
    if (field === 'photos') {
      const urls = Array.isArray(row.urls) ? row.urls.map(historyObject).map((v) => v.url) : [];
      const url = row.url ?? urls.find((v) => typeof v === 'string' && /^https?:\/\//i.test(v));
      return {
        key,
        title: `照片 ${index + 1}`,
        detail: url ? '' : `仅保存照片引用 ${text(row.photoId ?? row.id)}`,
        image: typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined,
      };
    }
    return { key, title: text(row.name ?? row.text ?? row.id), detail: '' };
  });
  // 同名标签跨两类来源重复时，只展示一项；其他集合保留同名不同身份的条目。
  if (field === 'labels') return [...new Map(mapped.map((v) => [v.title, v])).values()];
  const occurrences = new Map<string, number>();
  return mapped.map((item) => {
    const occurrence = occurrences.get(item.key) ?? 0;
    occurrences.set(item.key, occurrence + 1);
    return { ...item, key: `${item.key}:${occurrence}` };
  });
}
export function fieldItemChanges(current: HistoryItem[], previous: HistoryItem[]) {
  const before = new Map(previous.map((v) => [v.key, v]));
  const after = new Map(current.map((v) => [v.key, v]));
  return {
    added: current.filter((v) => !before.has(v.key)),
    removed: previous.filter((v) => !after.has(v.key)),
    changed: current.flatMap((v) => {
      const old = before.get(v.key);
      return old && (v.title !== old.title || v.detail !== old.detail)
        ? [{ before: old, after: v }]
        : [];
    }),
  };
}

/** 旧快照里的图片地址、目标昵称等元数据变化，不拆成新的业务条目版本。 */
export function presentFieldHistoryRows(field: string, rows: FieldHistoryRow[]): FieldHistoryRow[] {
  if (fieldHistoryMode(field) !== 'collection') return rows;
  const result: FieldHistoryRow[] = [];
  let previousIdentity: string | undefined;
  for (const row of rows) {
    const items = fieldHistoryItems(field, row.value);
    const identity = items.length
      ? JSON.stringify(
          items
            .map(({ key, title, detail }) => [key, title, detail])
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        )
      : JSON.stringify(row.value == null ? row.value : []);
    const last = result.at(-1);
    if (last && identity === previousIdentity) {
      last.first_at = Math.min(last.first_at, row.first_at);
      last.last_at = Math.max(last.last_at, row.last_at);
    } else result.push({ ...row });
    previousIdentity = identity;
  }
  return result;
}
