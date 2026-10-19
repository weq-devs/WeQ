import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildUnreadDock } from '../src/renderer/src/im-template/template/unreadDock';

it('列表与跳转使用同一服务端结果，不再把缺失水位替换为零', () => {
  const source = readFileSync('src/renderer/src/views/MainView.tsx', 'utf8');
  expect(source.includes('counts[info.uid] = info.unreadCount ?? 0')).toBe(true);
  expect(source.includes('const readSeq = info.readSeq ?? null')).toBe(true);
  expect(source.includes('const unread = info.unreadCount ?? 0')).toBe(true);
  expect(source.includes('const unread = latest > read ? Number(latest - read) : 0')).toBe(false);
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
