// @vitest-environment node
import { expect, it } from 'vitest';
import { buildUnreadDock } from '../src/renderer/src/im-template/template/unreadDock';
import { matchesUnreadMessage } from '../src/renderer/src/lib/unreadNavigation';
import { ChatType, unreadChatType } from '@weq/codec';

it('设备未读目标不归一成好友，兼容普通与临时私聊', () => {
  expect(unreadChatType(ChatType.KCHATTYPEDATALINE)).toBe(ChatType.KCHATTYPEDATALINE);
  expect(unreadChatType('KCHATTYPEDATALINEMQQ')).toBe(ChatType.KCHATTYPEDATALINEMQQ);
  expect(unreadChatType(ChatType.KCHATTYPETEMPC2CFROMGROUP)).toBe(ChatType.KCHATTYPEC2C);
});

it('跳转使用服务端未读数，不以序号差猜测，缺水位不伪造起点', () => {
  expect(buildUnreadDock({ readSeq: '5000', unread: 2, highlights: [] })).toEqual({
    stops: [{ kind: 'unread', seq: '5001' }],
    firstUnreadSeq: '5001',
  });
  expect(buildUnreadDock({ readSeq: null, unread: 2, highlights: [] })).toBeNull();
});

it('排除已读的重要消息，首条未读本身是重要消息时只保留一个跳转', () => {
  const atMe = { kind: 'atMe' as const, msgSeq: '4999', senderUid: 'u_fixture', rawKind: 1 };
  expect(buildUnreadDock({ readSeq: '4999', unread: 0, highlights: [atMe] })).toBeNull();
  expect(buildUnreadDock({ readSeq: '4998', unread: 1, highlights: [atMe] })?.stops).toEqual([
    { kind: 'atMe', seq: '4999', identity: { senderUid: 'u_fixture' } },
  ]);
  expect(buildUnreadDock({ readSeq: '4998', unread: 1, highlights: [atMe] })?.firstUnreadSeq).toBe(
    '4999',
  );
  expect(buildUnreadDock({ readSeq: null, unread: 0, highlights: [atMe] })?.stops).toEqual([
    { kind: 'atMe', seq: '4999', identity: { senderUid: 'u_fixture' } },
  ]);
});

it('群文件提醒只匹配同序号的原消息，不匹配后来插入的灰条', () => {
  const file = {
    msgSeq: '120',
    senderUid: 'u_fixture',
    sendTime: '1000',
    qqElements: [{ type: 'file' }],
  };
  const sameSenderTip = { ...file, qqElements: [{ type: 'grayTipXml' }] };
  const otherSender = { ...file, senderUid: 'u_other' };
  const stop = buildUnreadDock({
    readSeq: '100',
    unread: 130,
    highlights: [{ ...file, kind: 'newFile', rawKind: 2001 }],
  })?.stops[0];
  expect(
    [sameSenderTip, otherSender, file].find((row) =>
      matchesUnreadMessage(row, stop!.seq, stop!.identity),
    ),
  ).toBe(file);
});

it('群文件提醒缺少发送者且时间晚一秒时，仍能定位同序号的文件', () => {
  const stop = buildUnreadDock({
    readSeq: '100',
    unread: 2,
    highlights: [
      { kind: 'newFile', rawKind: 2001, msgSeq: '102', senderUid: '', sendTime: '1001' },
    ],
  })?.stops[0];
  const file = {
    msgSeq: '102',
    senderUid: 'u_fixture',
    sendTime: '1000',
    elements: [{ type: 'file' }],
  };
  expect(matchesUnreadMessage(file, stop!.seq, stop!.identity)).toBe(true);
  expect(matchesUnreadMessage({ ...file, sendTime: '999' }, stop!.seq, stop!.identity)).toBe(false);
  expect(matchesUnreadMessage({ ...file, msgSeq: '101' }, stop!.seq, stop!.identity)).toBe(false);
  expect(matchesUnreadMessage(file, stop!.seq, { sendTime: '1001' })).toBe(false);
});
