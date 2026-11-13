import { expect, it } from 'vitest';
import {
  selectProfileContacts,
  conversationProfileTargets,
} from '../src/renderer/src/lib/visibleConversationProfiles';

const direct = (id: string, sender = '') => ({
  targetUid: id,
  senderUid: sender,
  chatType: 1,
  preview: null,
});

it('可见行选择按实际视口，不默认扫描最新三十条或全目录，滚动后只选新可见行', () => {
  const rows = Array.from({ length: 600 }, (_, index) => direct(`u_${index}`));
  expect(selectProfileContacts(rows, ['u_200', 'u_201'])).toEqual(rows.slice(200, 202));
  expect(selectProfileContacts(rows, ['u_500'])).toEqual([rows[500]]);
  expect(selectProfileContacts(rows, [])).toEqual([]);
  expect(selectProfileContacts(rows)).toBe(rows);
});

it('补全私聊对方而不只补最后发送者，去重并忽略设备及非 UID', () => {
  const targets = conversationProfileTargets([
    direct('u_peer', 'u_self'),
    direct('u_peer', 'u_self'),
    direct('device', '12345'),
  ]);
  expect(targets.uids).toEqual(['u_self', 'u_peer']);
  expect(targets.groups.size).toBe(0);
});

it('群名片按群隔离，只查询可见群的预览身份，不把群号当用户 UID', () => {
  const rows = [
    { ...direct('12345', 'u_sender'), chatType: 2 },
    { ...direct('67890', 'u_sender'), chatType: 2 },
    { ...direct('99999', 'u_offscreen'), chatType: 2 },
  ];
  const targets = conversationProfileTargets(selectProfileContacts(rows, ['12345', '67890']));
  expect(targets.uids).toEqual(['u_sender']);
  expect([...targets.groups]).toEqual([
    ['12345', ['u_sender']],
    ['67890', ['u_sender']],
  ]);
});
