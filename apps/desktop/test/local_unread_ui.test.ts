// @vitest-environment node
import { expect, it } from 'vitest';
import { buildUnreadDock } from '../src/renderer/src/im-template/template/unreadDock';
import { ChatType, unreadChatType } from '@weq/codec';

it('设备未读目标不归一成好友，兼容普通与临时私聊', () => {
  expect(unreadChatType(ChatType.KCHATTYPEDATALINE)).toBe(ChatType.KCHATTYPEDATALINE);
  expect(unreadChatType('KCHATTYPEDATALINEMQQ')).toBe(ChatType.KCHATTYPEDATALINEMQQ);
  expect(unreadChatType(ChatType.KCHATTYPETEMPC2CFROMGROUP)).toBe(ChatType.KCHATTYPEC2C);
});

it('跳转使用服务端未读数，不以序号差猜测，缺水位不伪造起点', () => {
  expect(
    buildUnreadDock({ readSeq: '5000', unread: 2, highlights: [], visibleSeqs: ['5020'] }),
  ).toEqual({ unread: 2, stops: [{ kind: 'unread', seq: '5001' }] });
  expect(
    buildUnreadDock({ readSeq: null, unread: 2, highlights: [], visibleSeqs: ['5020'] }),
  ).toBeNull();
});

it('安静基线不生成跳转，实时未读跳到首条，明确提醒在缺少 QQ 水位时仍可跳转', () => {
  expect(
    buildUnreadDock({ readSeq: '5000', unread: 0, highlights: [], visibleSeqs: ['5000'] }),
  ).toBeNull();
  const live = buildUnreadDock({
    readSeq: '5000',
    unread: 2,
    highlights: [],
    visibleSeqs: ['5003'],
  });
  expect(live?.stops).toEqual([{ kind: 'unread', seq: '5001' }]);
  const reminder = buildUnreadDock({
    readSeq: '4998',
    unread: 1,
    visibleSeqs: ['5000'],
    highlights: [{ kind: 'atMe', msgSeq: '4999', senderUid: 'u_fixture', sendTime: '1', text: '' }],
  });
  expect(reminder?.stops.some((stop) => stop.kind === 'atMe' && stop.seq === '4999')).toBe(true);
});
