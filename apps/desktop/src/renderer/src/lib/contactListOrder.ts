import type { Contact, Conversation } from '../im-template/template/types';
import type { ContactMetric, ContactMetricRows } from '@weq/service';
import { intimateRelationOf } from './profileRelations';
import { contactBirth } from './contactBirth';

export const FRIEND_SORTS = {
  remark: '备注',
  nick: '昵称',
  uin: 'QQ 号',
  age: '年龄',
  birthday: '生日',
  intimacy: '亲密度',
  likeCount: '获赞数',
  level: 'QQ 等级',
  addedAt: '添加时间',
  commonFriends: '共同好友数',
  commonGroups: '共同群聊数',
};
export const FRIEND_GROUPS = {
  none: '不分组',
  qq: 'QQ 分组',
  birthYear: '出生年份',
  constellation: '星座',
  gender: '性别',
  location: '所在地',
  relation: '亲密关系',
  direction: '添加方向',
};
export const GROUP_SORTS = {
  remark: '备注',
  name: '群名',
  groupCode: '群号',
  memberCount: '人数',
  activityScore: '活跃度',
  createTime: '创建时间',
  friendCount: '群内好友数',
};
export const GROUP_GROUPS = {
  none: '不分组',
  notify: '消息提醒方式',
  identity: '我的身份',
  capacity: '群容量',
};
export type FriendSort = keyof typeof FRIEND_SORTS;
export type FriendGrouping = keyof typeof FRIEND_GROUPS;
export type GroupSort = keyof typeof GROUP_SORTS;
export interface DirectoryPreferences {
  sort: string;
  grouping: string;
  descending: boolean;
}
export interface RegionNode {
  code: string;
  name: string;
  children: RegionNode[];
}
const collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', {
  numeric: true,
  sensitivity: 'base',
});
const text = (value?: string | null) => value?.trim() || null;
const positive = (value?: number) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
export function defaultDescending(sort: string) {
  return !['remark', 'nick', 'name', 'birthday', 'uin', 'groupCode'].includes(sort);
}
export function directoryNumber(value: string) {
  const number = value.trim();
  return /^[1-9]\d*$/.test(number) ? number : null;
}
export function friendDirectoryNumber(contact: Contact) {
  return contact.identityLabel === 'QQ' ? directoryNumber(contact.identityValue) : null;
}
export function metricValue(rows: ContactMetricRows, id: string, metric: ContactMetric) {
  return rows[id]?.[metric]?.value ?? null;
}
export function friendMetric(rows: ContactMetricRows, contact: Contact, metric: ContactMetric) {
  if (metric === 'likeCount' && (contact.kind === 'bot' || contact.extInfo?.isEnterprise))
    return null;
  return (
    metricValue(rows, `friend:${contact.identityValue}`, metric) ??
    metricValue(rows, `friend:${contact.id}`, metric)
  );
}
function compareValue(a: number | string | null, b: number | string | null, descending: boolean) {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return (
    (typeof a === 'number' && typeof b === 'number'
      ? a - b
      : collator.compare(String(a), String(b))) * (descending ? -1 : 1)
  );
}
function birthday(month?: number, day?: number) {
  if (
    !month ||
    !day ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1
  )
    return null;
  const date = new Date(Date.UTC(2000, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? month * 100 + day : null;
}
export function zodiac(month?: number, day?: number) {
  if (birthday(month, day) === null) return null;
  const names = [
    '水瓶座',
    '双鱼座',
    '白羊座',
    '金牛座',
    '双子座',
    '巨蟹座',
    '狮子座',
    '处女座',
    '天秤座',
    '天蝎座',
    '射手座',
    '摩羯座',
  ];
  const cutoffs = [20, 19, 21, 20, 21, 22, 23, 23, 23, 24, 23, 22];
  const index = month! - 1;
  return names[day! < cutoffs[index]! ? (index + 11) % 12 : index]!;
}
export function sortFriends(
  items: readonly Contact[],
  sort: FriendSort,
  descending: boolean,
  rows: ContactMetricRows,
) {
  const now = new Date();
  const births = new Map(
    sort === 'age' || sort === 'birthday'
      ? items.map((contact) => [contact, contactBirth(contact, now)] as const)
      : [],
  );
  const value = (contact: Contact): string | number | null => {
    if (sort === 'remark') return text(contact.remark) ?? text(contact.nick);
    if (sort === 'nick') return text(contact.nick);
    if (sort === 'uin') return friendDirectoryNumber(contact);
    if (sort === 'age') return births.get(contact)!.ageOrder;
    if (sort === 'intimacy') return positive(contact.intimacy);
    if (sort === 'birthday') return birthday(contact.birthMonth, contact.birthDay);
    const result = friendMetric(rows, contact, sort);
    return Array.isArray(result) ? result.length : typeof result === 'number' ? result : null;
  };
  return items
    .map((contact) => ({
      contact,
      value: value(contact),
      age: sort === 'birthday' ? births.get(contact)!.ageOrder : null,
      name: contact.remark || contact.nick || contact.displayName,
      id: contact.id,
    }))
    .sort(
      (a, b) =>
        compareValue(a.value, b.value, descending) ||
        compareValue(a.age, b.age, descending) ||
        collator.compare(a.name, b.name) ||
        a.id.localeCompare(b.id),
    )
    .map(({ contact }) => contact);
}
type GroupRow = Extract<Conversation, { type: 'group' }>;
export function sortGroups(
  items: readonly GroupRow[],
  sort: GroupSort,
  descending: boolean,
  rows: ContactMetricRows,
  rawNames?: ReadonlyMap<string, string>,
) {
  const value = ({ group }: GroupRow): string | number | null => {
    const name = rawNames?.has(group.id)
      ? text(rawNames.get(group.id))
      : group.unnamed || group.name === group.id
        ? null
        : text(group.name);
    if (sort === 'remark') return text(group.remark) ?? name;
    if (sort === 'name') return name;
    if (sort === 'groupCode') return directoryNumber(group.identityValue);
    if (sort === 'memberCount') return positive(group.memberCount);
    if (sort === 'createTime') {
      const time = Date.parse(group.createTime ?? '');
      return time > 0 ? time : null;
    }
    const result = metricValue(rows, `group:${group.id}`, sort);
    return typeof result === 'number' ? result : null;
  };
  return items
    .map((row) => ({
      row,
      value: value(row),
      name: row.group.remark || row.group.name,
      id: row.id,
    }))
    .sort(
      (a, b) =>
        compareValue(a.value, b.value, descending) ||
        collator.compare(a.name, b.name) ||
        a.id.localeCompare(b.id),
    )
    .map(({ row }) => row);
}
export function locationGroup(ext: Contact['extInfo'], regions: RegionNode[]) {
  const country = text(ext?.country),
    province = text(ext?.province);
  const match = (nodes: RegionNode[], value: string | null) =>
    nodes.find((row) => row.code === value || row.name === value);
  const china = regions.find((row) => row.name === '中国' || row.code === '1');
  const countryNode = match(regions, country);
  const isChina =
    (countryNode === china && Boolean(china)) ||
    ['中国', '中华人民共和国', 'China', 'CN', '156', '86', '1'].includes(country ?? '');
  if (isChina || (!country && province)) {
    const node = match(china?.children ?? [], province);
    if (node) return node.name;
    if (province && !/^\d+$/.test(province)) return province;
    return '所在地未知';
  }
  if (countryNode) return countryNode.name;
  if (country && !/^\d+$/.test(country))
    return ['境外', '海外', '国外'].includes(country) ? '境外（国家未知）' : country;
  return country && country !== '0' ? '境外（国家未知）' : '所在地未知';
}
export function groupFriends(
  items: Contact[],
  basis: Exclude<FriendGrouping, 'qq' | 'none'>,
  rows: ContactMetricRows,
  regions: RegionNode[] = [],
) {
  const map = new Map<string, Contact[]>();
  for (const contact of items) {
    let name: string;
    switch (basis) {
      case 'birthYear':
        name =
          Number.isInteger(contact.birthYear) &&
          contact.birthYear! >= 1900 &&
          contact.birthYear! <= new Date().getFullYear()
            ? `${contact.birthYear} 年`
            : '出生年份未知';
        break;
      case 'constellation':
        name = zodiac(contact.birthMonth, contact.birthDay) ?? '星座未知';
        break;
      case 'gender':
        name = contact.gender === 1 ? '男' : contact.gender === 2 ? '女' : '性别未知';
        break;
      case 'location':
        name = locationGroup(contact.extInfo, regions);
        break;
      case 'relation':
        name = intimateRelationOf(contact)?.label ?? '无亲密关系';
        break;
      case 'direction': {
        const value = friendMetric(rows, contact, 'direction');
        name =
          value === 'incoming'
            ? '对方添加我'
            : value === 'outgoing'
              ? '我添加对方'
              : '添加方向未知';
        break;
      }
    }
    const list = map.get(name) ?? [];
    list.push(contact);
    map.set(name, list);
  }
  return [...map]
    .sort(([a], [b]) => {
      const unknownA = /未知|无亲密关系/.test(a),
        unknownB = /未知|无亲密关系/.test(b);
      return (
        Number(unknownA) - Number(unknownB) ||
        (basis === 'birthYear' ? Number.parseInt(b, 10) - Number.parseInt(a, 10) : 0) ||
        collator.compare(a, b)
      );
    })
    .map(([name, members]) => ({ id: `derived:${basis}:${name}`, name, items: members }));
}
