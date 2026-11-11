export const CONTACT_CARD_FIELDS = [
  ['qqShow', '当前 QQ 秀', true],
  ['pendant', '头像挂件', true],
  ['signature', '当前签名', true],
  ['signatureUpdated', '签名更新时间', false],
  ['gender', '性别', true],
  ['age', '年龄', true],
  ['birthday', '生日', true],
  ['constellation', '星座', false],
  ['zodiac', '生肖', false],
  ['bloodType', '血型', false],
  ['region', '所在地', true],
  ['occupation', '职业', false],
  ['school', '学校', true],
  ['labels', '标签', true],
  ['photos', '精选图片', false],
  ['status', '在线状态', true],
  ['common', '共同关系', true],
  ['category', '好友分组', true],
  ['intimacy', 'QQ 亲密度', false],
  ['relations', '关系标签', true],
  ['marks', '互动标识摘要', false],
  ['privileges', '已开通特权', true],
  ['level', 'QQ 等级', true],
  ['likes', '累计获赞', false],
  ['energy', 'QQ 能量值', false],
  ['qid', 'QID', true],
  ['uid', 'NT UID', false],
  ['description', '个人说明', false],
  ['company', '公司', true],
  ['email', '邮箱', false],
  ['friendClue', '好友添加信息', false],
  ['notes', '我的备注资料', false],
  ['botDescription', '机器人简介', true],
  ['botFeatures', '机器人功能', true],
] as const;
export const CONTACT_GROUP_FIELDS = [
  ['groupLevel', '群等级', true],
  ['joinedAt', '入群时间', true],
  ['lastSpeakAt', '最后群发言时间', true],
] as const;
export type ContactCardField = (typeof CONTACT_CARD_FIELDS)[number][0];
export type ContactGroupField = (typeof CONTACT_GROUP_FIELDS)[number][0];
export type ContactCardContent = ContactCardField | ContactGroupField;
export interface ContactCardSettings {
  visible: Record<ContactCardContent, boolean>;
  order: ContactCardField[];
  groupOrder: ContactGroupField[];
}
const fields = [...CONTACT_CARD_FIELDS, ...CONTACT_GROUP_FIELDS];
export const DEFAULT_CONTACT_CARD: ContactCardSettings = {
  visible: Object.fromEntries(fields.map(([key, , enabled]) => [key, enabled])) as Record<
    ContactCardContent,
    boolean
  >,
  order: CONTACT_CARD_FIELDS.map(([key]) => key),
  groupOrder: CONTACT_GROUP_FIELDS.map(([key]) => key),
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function order<T extends string>(value: unknown, defaults: readonly T[]): T[] {
  const known = new Set<string>(defaults);
  const selected = Array.isArray(value)
    ? value.filter((key): key is T => typeof key === 'string' && known.has(key))
    : [];
  return [...new Set([...selected, ...defaults])];
}
/** 旧配置缺项补默认，未知及已移除字段不重新进入设置。 */
export function normalizeContactCard(value: unknown): ContactCardSettings {
  const source = record(value) ? value : {};
  const visible = record(source.visible) ? source.visible : {};
  return {
    visible: Object.fromEntries(
      fields.map(([key, , fallback]) => [
        key,
        typeof visible[key] === 'boolean' ? visible[key] : fallback,
      ]),
    ) as Record<ContactCardContent, boolean>,
    order: order(source.order, DEFAULT_CONTACT_CARD.order),
    groupOrder: order(source.groupOrder, DEFAULT_CONTACT_CARD.groupOrder),
  };
}
export function moveContactCardField<T extends string>(keys: T[], key: T, offset: number): T[] {
  const index = keys.indexOf(key);
  const next = index + offset;
  if (index < 0 || next < 0 || next >= keys.length) return keys;
  const result = [...keys];
  result.splice(index, 1);
  result.splice(next, 0, key);
  return result;
}
