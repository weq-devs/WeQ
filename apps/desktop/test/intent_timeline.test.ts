import { expect, it } from 'vitest';
import {
  intentTimelineTargets,
  messageHasIntentText,
} from '../src/renderer/src/lib/intentTimeline';

const self = new Set(['self:10000', '10000', 'u_self']);
const peer = { id: 'peer', senderId: 'u_peer', body: '对方正文' };
const system = (message: { id: string }) => message.id === 'system';

it('自己的 id／UIN／UID 都属于可分析消息，但都不是回复推荐目标', () => {
  for (const senderId of self)
    expect(
      intentTimelineTargets([peer, { id: 'own', senderId, body: '自己正文' }], self, system),
    ).toEqual({ latestMessageId: 'own', latestPeerMsgId: null, latestSuggestionId: 'own' });
  expect(intentTimelineTargets([peer], self, system)).toEqual({
    latestMessageId: 'peer',
    latestPeerMsgId: 'peer',
    latestSuggestionId: 'peer',
  });
});

it('灰条、撤回和删除不覆盖目标；自己的媒体与发送占位会立即隐藏旧建议', () => {
  const own = { id: 'own', senderId: 'u_self', body: '自己正文' };
  for (const extra of [
    { id: 'system' },
    { id: 'removed', recall: {} },
    { id: 'deleted', deletedKind: 'qq' },
  ]) {
    expect(intentTimelineTargets([peer, own, { ...peer, ...extra }], self, system)).toEqual({
      latestMessageId: 'own',
      latestPeerMsgId: null,
      latestSuggestionId: 'own',
    });
  }
  for (const optimistic of ['sending', 'sent', 'failed'])
    expect(intentTimelineTargets([peer, { ...own, optimistic }], self, system)).toEqual({
      latestMessageId: 'peer',
      latestPeerMsgId: null,
      latestSuggestionId: null,
    });
  expect(
    intentTimelineTargets(
      [peer, { ...own, qqElements: [{ type: 'pic', data: {} }] }],
      self,
      system,
    ),
  ).toEqual({ latestMessageId: 'peer', latestPeerMsgId: null, latestSuggestionId: 'own' });
  expect(intentTimelineTargets([own, { ...peer, id: 'new-peer' }], self, system)).toEqual({
    latestMessageId: 'new-peer',
    latestPeerMsgId: 'new-peer',
    latestSuggestionId: 'new-peer',
  });
});

it('只认正文文本和表情说明，不把引用、提及或媒体预览当成可分析文本', () => {
  expect(messageHasIntentText({ body: '正文' })).toBe(true);
  expect(
    messageHasIntentText({ qqElements: [{ type: 'text', data: { textContent: '正文' } }] }),
  ).toBe(true);
  expect(messageHasIntentText({ qqElements: [{ type: 'face', data: { faceText: '微笑' } }] })).toBe(
    true,
  );
  for (const type of ['reply', 'at', 'pic', 'file', 'ark'])
    expect(
      messageHasIntentText({
        body: '预览',
        qqElements: [{ type, data: { textContent: '只在预览中出现' } }],
      }),
    ).toBe(false);
  expect(intentTimelineTargets([peer], new Set(), system).latestPeerMsgId).toBeNull();
});
