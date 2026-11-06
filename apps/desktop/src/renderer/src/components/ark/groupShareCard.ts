import type { GroupConversation } from '../../im-template/template/types';
import type { ArkValues } from './arkCards';
import type { GroupShareTarget } from '@weq/service/group-share-target';
export { groupShareTarget, type GroupShareTarget } from '@weq/service/group-share-target';

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
