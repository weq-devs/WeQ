// @vitest-environment node
import { expect, it } from 'vitest';
import {
  contactToConversation,
  groupDetailToConversation,
} from '../src/renderer/src/views/workspace/identity';
import type { GroupDetailWire } from '../src/renderer/src/views/workspace/types';
import type { User } from '../src/renderer/src/im-template/template/types';

const user: User = {
  id: 'self:10001',
  uid: 'u_self',
  username: 'uin-10001',
  displayName: '本人昵称',
  identityLabel: 'UIN',
  identityValue: '10001',
  avatarUrl: null,
};

function recentGroup() {
  return contactToConversation(
    {
      chatType: 2,
      targetUid: '20001',
      targetDisplayName: '群名',
      msgSeq: '1',
      senderUid: 'u_self',
      targetUin: '0',
      topTime: '0',
      pinned: false,
      senderDisplayName: '',
      senderNick: '',
      senderRemark: '',
      targetAvatar: '',
      targetRemark: '',
      targetGroupNick: '',
      notifyLevel: 1,
      tempSourceGroupCode: '0',
      sendTime: '1700000000',
      preview: {
        kind: 'grayTipPoke',
        grayTipXmlContent:
          '<gtip><qq uin="u_self" nm=""/><nor txt="戳了戳"/><qq uin="u_self" nm=""/></gtip>',
      },
    },
    user,
    new Map(),
    new Set(),
  )!;
}
const detail: GroupDetailWire = {
  groupCode: '20001',
  groupName: '群名',
  ownerUid: 'u_self',
  customLabels: [],
  pinnedAnnounce: '',
  description: '',
  remark: '',
  createTime: 0,
  maxMemberCount: 100,
  memberCount: 0,
  labels: '',
  entranceQ: '',
};

it('最近群会话不预填本人，消息预览仍独立识别自己的身份', () => {
  const conversation = recentGroup();
  expect(conversation.type).toBe('group');
  expect(conversation.members).toEqual([]);
  expect(conversation.lastMessage?.body).toBe('你戳了戳你');
});

it.each([undefined, null])(
  '从群详情打开时不虚构成员，包括已退群记录（directory=%s）',
  (directory) => {
    const conversation = groupDetailToConversation({ ...detail, directory }, null, user);
    expect(conversation.members).toEqual([]);
    expect(conversation.group?.role).toBe('owner');
  },
);

it('有最近会话但尚无成员时，群详情补全仍保持空列表', () => {
  const conversation = groupDetailToConversation(detail, recentGroup(), user);
  expect(conversation.members).toEqual([]);
});

it('群详情补全保留已经读到的实际成员，包括真实名单中的自己', () => {
  const members = [
    { ...user, id: user.uid!, role: 'owner' as const, joinedAt: '2020-01-01T00:00:00Z' },
  ];
  const conversation = groupDetailToConversation(detail, { ...recentGroup(), members }, user);
  expect(conversation.members).toBe(members);
});
