import { expect, it } from 'vitest';
import { ChatType } from '@weq/codec';
import { contactSenderName, contactTitle } from '../src/renderer/src/lib/contactTitle';
import { chatHeaderTitle } from '../src/renderer/src/im-template/template/conversationDisplay';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

const contact = {
  chatType: ChatType.KCHATTYPEC2C,
  targetUid: 'u_peer',
  targetUin: '10002',
  senderUid: 'u_peer',
  senderRemark: '旧备注',
  targetDisplayName: '旧标题',
  senderDisplayName: '旧发送人',
};
it('私聊标题使用读回的备注，清除后回到昵称，不沿用最近联系人的旧备注', () => {
  expect(contactTitle(contact, { remark: '新备注', nick: '昵称' })).toBe('新备注');
  expect(contactTitle(contact, { remark: '', nick: '昵称' })).toBe('昵称');
  expect(contactTitle(contact, { remark: '', nick: '' })).toBe(contact.targetUin);
});
it('群临时会话保留群名片，群标题和数据线不使用好友备注', () => {
  expect(
    contactTitle(
      { ...contact, chatType: ChatType.KCHATTYPETEMPC2CFROMGROUP, targetGroupNick: '本群名片' },
      { nick: '全局昵称', remark: '' },
    ),
  ).toBe('本群名片');
  expect(
    contactTitle(
      { ...contact, chatType: ChatType.KCHATTYPEGROUP, targetDisplayName: '群名' },
      { nick: '昵称', remark: '好友备注' },
    ),
  ).toBe('群名');
  expect(
    contactTitle(
      {
        ...contact,
        chatType: ChatType.KCHATTYPEDATALINE,
        senderRemark: '',
        targetDisplayName: '我的电脑',
      },
      { nick: '昵称', remark: '好友备注' },
    ),
  ).toBe('我的电脑');
});
it('群预览发送人使用新的群名片或资料，私聊发送人保持原语义', () => {
  const profiles = new Map([[contact.senderUid, '新备注']]);
  const members = new Map([[contact.senderUid, '新名片']]);
  expect(
    contactSenderName({ ...contact, chatType: ChatType.KCHATTYPEGROUP }, profiles, members),
  ).toBe('新名片');
  expect(contactSenderName({ ...contact, chatType: ChatType.KCHATTYPEGROUP }, profiles)).toBe(
    '新备注',
  );
  expect(contactSenderName(contact, profiles, members)).toBe(contact.senderDisplayName);
});
it('更新名称后，数字形态的群临时会话仍保留来源说明', () => {
  const direct = createTemplateDemoData().conversations.find((row) => row.type === 'direct')!;
  const updated = {
    ...direct,
    chatType: ChatType.KCHATTYPETEMPC2CFROMGROUP,
    tempSourceGroupName: '来源群',
    otherUser: { ...direct.otherUser, displayName: '新备注' },
  };
  expect(chatHeaderTitle(updated)).toBe('来自 来源群 的 新备注 临时会话');
  expect(chatHeaderTitle({ ...updated, chatType: ChatType.KCHATTYPEC2C })).toBe('新备注');
});
