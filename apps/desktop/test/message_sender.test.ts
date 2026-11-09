import { describe, expect, it } from 'vitest';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { GroupMember } from '../src/renderer/src/im-template/template/types';
import {
  mergeMessageMembers,
  messageSender,
  optimisticMessageSender,
} from '../src/renderer/src/lib/messageSender';

const demo = createTemplateDemoData();
const group = demo.conversations.find((conversation) => conversation.type === 'group')!;
const direct = demo.conversations.find((conversation) => conversation.type === 'direct')!;
const user = { ...demo.user, id: 'self:10001', uid: 'u_self', identityValue: '10001' };
const member: GroupMember = {
  ...user,
  id: 'u_self',
  uin: '10001',
  card: '我的群名片',
  displayName: '我的群名片',
  role: 'admin',
  joinedAt: '',
  customTitle: '专属头衔',
  memberLevel: 42,
  levelName: '活跃成员',
};
const members = new Map([[member.id, member]]);

describe('群消息发送者资料', () => {
  it('刚发送的消息和真实回声使用同一份群名片、等级与头衔', () => {
    const optimistic = optimisticMessageSender(group, user, members);
    const real = messageSender(
      { senderUid: user.uid, senderUin: user.identityValue, elements: [] },
      group,
      user,
      members,
    );
    expect(optimistic).toEqual(real);
    expect(optimistic).toMatchObject({
      id: user.id,
      displayName: member.displayName,
      role: member.role,
      customTitle: member.customTitle,
      memberLevel: member.memberLevel,
      levelName: member.levelName,
    });
  });

  it.each(['', '10001'])('发送者 UID 为 %j 时仍通过账号身份匹配自己的群资料', (senderUid) => {
    expect(
      messageSender({ senderUid, senderUin: '10001', elements: [] }, group, user, members),
    ).toMatchObject({ displayName: member.displayName, memberLevel: member.memberLevel });
  });

  it('只带 QQ 号的其他发言人也能匹配群资料，不误判成自己', () => {
    const peer = { ...member, id: 'u_peer', uin: '20002', displayName: '其他成员' };
    expect(
      messageSender(
        { senderUid: '', senderUin: '20002', elements: [] },
        group,
        user,
        new Map([[peer.id, peer]]),
      ),
    ).toMatchObject({ id: 'sender:20002', displayName: peer.displayName, memberLevel: 42 });
  });

  it('其他群没有对应成员时不会借用本群的身份资料', () => {
    expect(optimisticMessageSender(group, user, new Map())).not.toHaveProperty('memberLevel', 42);
    expect(optimisticMessageSender(direct, user, members)).toBe(user);
  });

  it('分页替换时展示快照保留离屏发送者，新资料完整替换旧值（包括清空头衔）', () => {
    const previous = [
      { uid: 'u_self', customTitle: '旧头衔' },
      { uid: 'u_peer', customTitle: '历史头衔' },
    ];
    const updates = [{ uid: 'u_self', customTitle: '' }];
    expect(mergeMessageMembers(previous, updates)).toEqual([updates[0], previous[1]]);
    expect(previous[0].customTitle).toBe('旧头衔');
  });
});
