import { describe, expect, it, vi } from 'vitest';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { GroupMember } from '../src/renderer/src/im-template/template/types';
import {
  mergeMessageMembers,
  localProfileUser,
  messageSender,
  optimisticMessageSender,
  createMemberUinLookup,
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
  it('私聊正式消息和预览均使用本地备注或昵称，不沿用云端名片名称', () => {
    const peer = {
      ...direct.otherUser,
      id: 'u_peer',
      uid: 'u_peer',
      nick: '云端昵称',
      remark: '云端备注',
      displayName: '云端备注',
    };
    const conversation = { ...direct, otherUser: peer };
    const local = { remark: '本地备注', nick: '本地昵称' };
    const profiles = new Map([[peer.id, local]]);
    const message = { senderUid: peer.id, senderUin: peer.identityValue, elements: [] };
    expect(
      messageSender(message, conversation, user, undefined, undefined, profiles),
    ).toMatchObject({
      displayName: local.remark,
      nick: local.nick,
      remark: local.remark,
    });
    expect(localProfileUser(peer, local).displayName).toBe(local.remark);
    profiles.set(peer.id, { ...local, remark: '' });
    expect(
      messageSender(message, conversation, user, undefined, undefined, profiles).displayName,
    ).toBe(local.nick);
    profiles.set(peer.id, { nick: '', remark: '' });
    expect(
      messageSender(message, conversation, user, undefined, undefined, profiles).displayName,
    ).toBe(peer.identityValue);
    expect(peer.displayName).toBe('云端备注');
  });
  it('已退出的群缺少成员行时，使用资料库的备注或昵称，不附加群身份', () => {
    const message = { senderUid: 'u_history', senderUin: '20002', elements: [] };
    const profile = { uid: 'u_history', remark: '本地备注', nick: '缓存昵称' };
    const profiles = new Map([[profile.uid, profile]]);
    const sender = messageSender(message, group, user, new Map(), undefined, profiles);
    expect(sender).toMatchObject({
      id: profile.uid,
      displayName: profile.remark,
      remark: profile.remark,
      nick: profile.nick,
    });
    expect(sender.role).toBeUndefined();
    expect(sender.memberLevel).toBeUndefined();
    profiles.set(profile.uid, { ...profile, remark: ' ' });
    expect(messageSender(message, group, user, undefined, undefined, profiles).displayName).toBe(
      profile.nick,
    );
  });

  it('历史群名片优先于资料备注，空群资料由备注和昵称补全，不借用其他人的资料', () => {
    const peer = { ...member, id: 'u_peer', uin: '20002', nick: '', remark: '' };
    const message = { senderUid: peer.id, senderUin: peer.uin, elements: [] };
    const profile = { uid: peer.id, remark: '好友备注', nick: '资料昵称' };
    const profiles = new Map([[profile.uid, profile]]);
    const directory = new Map([
      [peer.id, { ...peer, card: '历史群昵称', displayName: '历史群昵称' }],
    ]);
    expect(messageSender(message, group, user, directory, undefined, profiles).displayName).toBe(
      '历史群昵称',
    );
    directory.set(peer.id, { ...peer, card: '', displayName: peer.uin });
    expect(messageSender(message, group, user, directory, undefined, profiles).displayName).toBe(
      profile.remark,
    );
    expect(
      messageSender(
        { ...message, senderUid: 'u_unknown' },
        group,
        user,
        undefined,
        undefined,
        profiles,
      ).displayName,
    ).toBe(peer.uin);
    expect(messageSender(message, direct, user, undefined, undefined, profiles)).toBe(
      direct.otherUser,
    );
  });

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

  it('历史成员缺少 QQ 号时仍以 UID 匹配群昵称，资料全缺时显示 UID', () => {
    const message = { senderUid: 'u_history', senderUin: '0', elements: [] };
    const historical = {
      ...member,
      id: message.senderUid,
      uin: '0',
      card: '旧群昵称',
      displayName: '旧群昵称',
    };
    expect(
      messageSender(message, group, user, new Map([[historical.id, historical]])),
    ).toMatchObject({
      id: historical.id,
      displayName: historical.displayName,
      identityLabel: 'UID',
      identityValue: historical.id,
    });
    expect(messageSender(message, group, user).displayName).toBe(message.senderUid);
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

  it('一批 QQ 号回退只遍历一次成员表，UID 命中不建索引，重复号码保留首项', () => {
    let reads = 0;
    const rows = Array.from({ length: 200 }, (_, index) => ({
      ...member,
      id: `u_member_${index}`,
      get uin() {
        reads++;
        return String(20000 + (index === 1 ? 0 : index));
      },
      card: `群名片 ${index}`,
      displayName: `群名片 ${index}`,
    }));
    const directory = new Map(rows.map((row) => [row.id, row]));
    const values = vi.spyOn(directory, 'values');
    const lookup = createMemberUinLookup(directory);
    const sender = (senderUid: string, senderUin: string) =>
      messageSender(
        { senderUid, senderUin, elements: [] },
        group,
        user,
        directory,
        undefined,
        undefined,
        lookup,
      );
    expect(sender(rows[0]!.id, '20000').displayName).toBe('群名片 0');
    expect(reads).toBe(0);
    expect(values).not.toHaveBeenCalled();
    for (let index = 0; index < rows.length; index++) {
      const position = index === 1 ? 0 : index;
      expect(sender('', String(20000 + position)).displayName).toBe(`群名片 ${position}`);
    }
    expect(sender('', '99999').displayName).toBe('99999');
    expect(sender('', '99999').displayName).toBe('99999');
    expect(reads).toBe(rows.length);
    expect(values).toHaveBeenCalledOnce();
    const updated = { ...rows[0]!, card: '更新后的群名片', displayName: '更新后的群名片' };
    const next = new Map(directory).set(updated.id, updated);
    const nextLookup = createMemberUinLookup(next);
    expect(nextLookup('20000')).toBe(updated);
    expect(lookup('20000')).toBe(rows[0]);
    values.mockRestore();
  });

  it('未传批次索引的单条回退仍读取当前 Map，不跨调用缓存旧群名片', () => {
    const peer = { ...member, id: 'u_peer', uin: '20002', displayName: '旧群名片' };
    const directory = new Map([[peer.id, peer]]);
    const message = { senderUid: '', senderUin: '20002', elements: [] };
    expect(messageSender(message, group, user, directory).displayName).toBe('旧群名片');
    directory.set(peer.id, { ...peer, displayName: '新群名片' });
    expect(messageSender(message, group, user, directory).displayName).toBe('新群名片');
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
