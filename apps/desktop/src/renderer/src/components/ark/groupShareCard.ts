import type { GroupConversation } from '../../im-template/template/types';
import type { ArkValues } from './arkCards';

export interface GroupShareTarget {
  code: string;
  name: string;
  avatar: string;
}

/** 只解析明确的群身份，不从标题、头像 URL 或不透明的加群口令猜群号。 */
export function groupShareTarget(
  app: string,
  meta: Record<string, Record<string, unknown>>,
): GroupShareTarget | null {
  const contact = meta.contact;
  if (!contact || typeof contact !== 'object' || Array.isArray(contact)) return null;
  const troop = app === 'com.tencent.troopsharecard';
  if (!troop && app !== 'com.tencent.contact.lua') return null;

  let code = '';
  const jump = contact.jumpUrl;
  if (typeof jump === 'string') {
    try {
      const url = new URL(jump);
      if (
        url.protocol === 'mqqapi:' &&
        url.hostname === 'card' &&
        url.pathname === '/show_pslcard' &&
        !url.username &&
        !url.password &&
        url.searchParams.get('card_type') === 'group'
      )
        code = url.searchParams.get('uin') ?? '';
    } catch {
      // 没有可解析的链接时仍可使用明确标记为群的结构化身份。
    }
  }
  if (!code && (contact.type === 'group' || troop)) {
    const id = contact.id;
    if (typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id)))
      code = String(id);
  }
  if (!/^[1-9]\d{4,19}$/.test(code)) return null;
  return {
    code,
    name: typeof contact.title === 'string' && contact.title.trim() ? contact.title : code,
    avatar:
      typeof contact.avatar === 'string' && contact.avatar
        ? contact.avatar
        : `https://p.qlogo.cn/gh/${code}/${code}/0`,
  };
}

/** 未收录的群也能按精确群号查看本地消息，不推断其成员关系。 */
export function sharedGroupConversation(target: GroupShareTarget): GroupConversation {
  return {
    id: target.code,
    type: 'group',
    otherUser: null,
    updatedAt: new Date(0).toISOString(),
    lastMessage: null,
    members: [],
    group: {
      id: target.code,
      identityLabel: 'Group',
      identityValue: target.code,
      name: target.name,
      avatarUrl: target.avatar,
      announcement: null,
      memberCount: 0,
      role: 'member',
      membershipKnown: false,
      roleKnown: false,
    },
  };
}

export function groupShareValues(target: GroupShareTarget, values: ArkValues | null): ArkValues {
  return {
    ...values,
    name: target.name,
    avatar: target.avatar,
    desc: values?.desc || `群号：${target.code}`,
    footerSource: values?.footerSource || values?.source || '推荐群聊',
  };
}
