import {
  moveContactCardField,
  type ContactCardContent,
  type ContactCardField,
} from '@weq/service/contact-card';

export const CONTACT_CARD_SECTIONS = [
  { key: 'identity', title: '身份区' },
  { key: 'basic', title: '个人资料' },
  { key: 'social', title: '与我的关系' },
  { key: 'display', title: '个性展示' },
  { key: 'account', title: 'QQ 账号' },
  { key: 'bot', title: '机器人信息' },
] as const;
export type ContactCardGroup = (typeof CONTACT_CARD_SECTIONS)[number]['key'] | 'tech';

const FIELD_GROUPS: Record<ContactCardField, ContactCardGroup> = {
  pendant: 'identity',
  status: 'identity',
  category: 'identity',
  qid: 'identity',
  uid: 'identity',
  signature: 'identity',
  signatureUpdated: 'identity',
  gender: 'basic',
  age: 'basic',
  birthday: 'basic',
  constellation: 'basic',
  zodiac: 'basic',
  bloodType: 'basic',
  region: 'basic',
  occupation: 'basic',
  school: 'basic',
  description: 'basic',
  company: 'basic',
  email: 'basic',
  common: 'social',
  intimacy: 'social',
  relations: 'social',
  marks: 'social',
  friendClue: 'social',
  qqShow: 'display',
  labels: 'display',
  photos: 'display',
  level: 'account',
  likes: 'account',
  privileges: 'account',
  energy: 'account',
  botDescription: 'bot',
  botFeatures: 'bot',
};

/** 名片与设置页共用分区；群内字段由独立的 groupOrder 管理。 */
export function contactCardFieldGroup(key: ContactCardContent): ContactCardGroup {
  return key in FIELD_GROUPS ? FIELD_GROUPS[key as ContactCardField] : 'basic';
}

/** 仅重排同分区的槽位，保留其他分区及旧配置的相对位置。 */
export function moveContactCardSectionField(
  order: ContactCardField[],
  key: ContactCardField,
  offset: number,
): ContactCardField[] {
  const group = contactCardFieldGroup(key);
  const fields = order.filter((field) => contactCardFieldGroup(field) === group);
  const moved = moveContactCardField(fields, key, offset);
  if (moved === fields) return order;
  let index = 0;
  return order.map((field) => (contactCardFieldGroup(field) === group ? moved[index++]! : field));
}
