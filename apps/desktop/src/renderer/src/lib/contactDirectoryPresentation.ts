import type { ContactMetric, ContactMetricRows } from '@weq/service';
import type { Contact, GroupConversation } from '../im-template/template/types';
import { displayGroupName, displayUserName } from '../im-template/template/user';
import { contactBirth } from './contactBirth';
import {
  directoryNumber,
  friendDirectoryNumber,
  type FriendSort,
  type GroupSort,
} from './contactListOrder';

type SortDetail = { text: string; title?: string };
type MetricCell = NonNullable<ContactMetricRows[string][ContactMetric]>;
const numbers = new Intl.NumberFormat('zh-CN');
const dates = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const updatedTimes = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'short',
  timeStyle: 'short',
});
const addedTimes = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
function dateLabel(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = dates.formatToParts(date);
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join('-');
}
function numericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function metricDetail(
  label: string,
  cell: MetricCell | undefined,
  format: (value: MetricCell['value']) => string | null,
): SortDetail {
  const text = format(cell?.value);
  if (text === null)
    return {
      text: `${label}${cell?.state === 'failed' ? '读取失败' : '未读取'}`,
      title: cell?.error,
    };
  const updatedAt = cell?.updatedAt;
  const title = [
    cell?.state === 'stale' ? '缓存已过期' : cell?.state === 'failed' ? '上次更新失败' : '',
    updatedAt && dateLabel(updatedAt) ? `更新于 ${updatedTimes.format(updatedAt)}（北京时间）` : '',
  ]
    .filter(Boolean)
    .join('；');
  return { text, title: title || undefined };
}
function countDetail(label: string, value: unknown, unit = '') {
  const number = numericValue(value);
  return number === null ? null : `${label}：${numbers.format(number)}${unit}`;
}

export function friendDirectoryTitle(contact: Contact, sort: FriendSort) {
  if (sort === 'nick') return contact.nick?.trim() || '昵称未读取';
  if (sort === 'remark')
    return contact.remark?.trim() || contact.nick?.trim() || displayUserName(contact);
  return displayUserName(contact);
}

export function groupDirectoryTitle(
  group: GroupConversation['group'],
  sort: GroupSort,
  rawNames?: ReadonlyMap<string, string>,
) {
  if (sort !== 'name') return displayGroupName(group);
  const name = rawNames?.has(group.id)
    ? rawNames.get(group.id)
    : group.unnamed || group.name === group.id
      ? undefined
      : group.name;
  return name?.trim() || '群名未读取';
}

function birthDetail(contact: Contact): SortDetail {
  const { year, month, day, age } = contactBirth(contact);
  const date = `${year ?? '????'}-${month === null ? '??' : String(month).padStart(2, '0')}-${day === null ? '??' : String(day).padStart(2, '0')}`;
  return { text: `${date} （${age ?? '??'} 岁）` };
}

export function friendSortDetail(
  contact: Contact,
  sort: FriendSort,
  rows: ContactMetricRows,
): SortDetail | null {
  if (sort === 'likeCount' && (contact.kind === 'bot' || contact.extInfo?.isEnterprise))
    return null;
  if (sort === 'remark' || sort === 'nick') return null;
  if (sort === 'uin') {
    const number = friendDirectoryNumber(contact);
    return { text: number ? `QQ 号：${number}` : 'QQ 号未读取' };
  }
  if (sort === 'age' || sort === 'birthday') return birthDetail(contact);
  if (sort === 'intimacy') {
    const intimacy = numericValue(contact.intimacy);
    return {
      text:
        intimacy !== null && intimacy > 0 ? `亲密度：${numbers.format(intimacy)}` : '亲密度未读取',
    };
  }
  const cell =
    rows[`friend:${contact.identityValue}`]?.[sort]?.value != null
      ? rows[`friend:${contact.identityValue}`]?.[sort]
      : (rows[`friend:${contact.id}`]?.[sort] ?? rows[`friend:${contact.identityValue}`]?.[sort]);
  if (sort === 'addedAt')
    return metricDetail('添加时间', cell, (value) => {
      const date = typeof value === 'number' ? dateLabel(value * 1000) : null;
      return date ? `${date} ${addedTimes.format(Number(value) * 1000)}` : null;
    });
  const label = {
    level: 'QQ 等级',
    likeCount: '获赞',
    commonFriends: '共同好友',
    commonGroups: '共同群聊',
  }[sort];
  return metricDetail(label, cell, (value) =>
    countDetail(
      label,
      sort === 'commonGroups' && Array.isArray(value) ? value.length : value,
      sort === 'commonFriends' ? ' 人' : sort === 'commonGroups' ? ' 个' : '',
    ),
  );
}

export function groupSortDetail(
  group: GroupConversation['group'],
  sort: GroupSort,
  rows: ContactMetricRows,
): SortDetail | null {
  if (sort === 'remark' || sort === 'name') return null;
  if (sort === 'groupCode') {
    const number = directoryNumber(group.identityValue);
    return { text: number ? `群号：${number}` : '群号未读取' };
  }
  if (sort === 'memberCount')
    return {
      text: group.memberCount > 0 ? `${numbers.format(group.memberCount)} 位成员` : '人数未读取',
    };
  if (sort === 'createTime') {
    const date = dateLabel(Date.parse(group.createTime ?? ''));
    return { text: date ? `创建于 ${date}` : '创建时间未读取' };
  }
  return metricDetail(
    sort === 'friendCount' ? '群内好友数' : '活跃度',
    rows[`group:${group.id}`]?.[sort],
    (value) => {
      const number = numericValue(value);
      if (number === null) return null;
      return sort === 'friendCount'
        ? `群内好友：${numbers.format(number)} / ${group.memberCount > 0 ? numbers.format(group.memberCount) : '未知'} 人`
        : `活跃度：${numbers.format(number)}`;
    },
  );
}
