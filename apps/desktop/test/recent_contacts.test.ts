// @vitest-environment node
import { expect, it } from 'vitest';
import {
  mergeRecentContactPages,
  recentContactPreviewIsBehind,
  applyObservedContactPreview,
  observeContactPreview,
} from '../src/renderer/src/lib/recentContacts';
import { previewNodes, previewNodesToText } from '../src/renderer/src/lib/conversationPreview';

it('正文补齐摘要与发送者，沿用表情和媒体解析，不覆盖会话资料且同水位交还给 QQ', () => {
  const contact = {
    targetUid: 'peer',
    msgSeq: '1',
    sendTime: '200',
    targetRemark: '本地备注',
    senderUid: 'u_old',
    senderRemark: '旧发送者',
    preview: null,
  };
  const message = {
    msgSeq: '2',
    sendTime: '201',
    senderUid: 'u_new',
    elements: [
      { type: 'text', data: { textContent: '最新正文' } },
      { type: 'face', data: { faceId: 14, faceText: '微笑' } },
      { type: 'pic', data: {} },
    ],
  };
  const previews = observeContactPreview(new Map(), contact, message);
  const result = applyObservedContactPreview(contact, previews);
  expect(result.targetRemark).toBe('本地备注');
  expect(result.senderUid).toBe('u_new');
  expect(result.senderRemark).toBe('');
  expect(result.msgSeq).toBe('2');
  expect(previewNodesToText(previewNodes(result.preview))).toBe('最新正文微笑[图片]');
  expect(observeContactPreview(previews, contact, message)).toBe(previews);
  expect(observeContactPreview(previews, contact, { ...message, sendTime: '199' })).toBe(previews);
  expect(
    observeContactPreview(previews, contact, { ...message, sendTime: '202', source: 'roaming' }),
  ).toBe(previews);
  const caughtUp = { ...contact, msgSeq: '2', sendTime: '201' };
  expect(applyObservedContactPreview(caughtUp, previews)).toBe(caughtUp);
  const newer = { ...caughtUp, msgSeq: '3', sendTime: '202' };
  expect(applyObservedContactPreview(newer, previews)).toBe(newer);
  expect(
    applyObservedContactPreview({ ...contact, targetRemark: '新备注' }, previews).targetRemark,
  ).toBe('新备注');
});

it('正文摘要只保留有界的最近访问会话，不持有整页消息', () => {
  let previews = observeContactPreview(
    new Map(),
    { targetUid: '0', sendTime: '0' },
    {
      msgSeq: '1',
      sendTime: '1',
      senderUid: 'sender',
      elements: [],
    },
  );
  for (let index = 1; index <= 500; index++)
    previews = observeContactPreview(
      previews,
      { targetUid: String(index), sendTime: '0' },
      {
        msgSeq: '1',
        sendTime: '1',
        senderUid: 'sender',
        elements: [],
      },
    );
  expect(previews.size).toBe(500);
  expect(previews.has('0')).toBe(false);
  expect(previews.has('500')).toBe(true);
});

it('正文校准比较时间和同秒序号，不因旧历史、未对账漫游或发送摘要反复刷新', () => {
  const summary = { targetUid: 'peer', msgSeq: '9007199254740992', sendTime: '200' };
  expect(recentContactPreviewIsBehind(summary, { msgSeq: '1', sendTime: '201' })).toBe(true);
  expect(
    recentContactPreviewIsBehind(summary, { msgSeq: '9007199254740993', sendTime: '200' }),
  ).toBe(true);
  expect(recentContactPreviewIsBehind(summary, summary)).toBe(false);
  expect(
    recentContactPreviewIsBehind(summary, { msgSeq: '9007199254740993', sendTime: '199' }),
  ).toBe(false);
  expect(
    recentContactPreviewIsBehind(summary, { msgSeq: '9007199254740991', sendTime: '200' }),
  ).toBe(false);
  expect(
    recentContactPreviewIsBehind(summary, { msgSeq: '2', sendTime: '201', source: 'roaming' }),
  ).toBe(false);
});

it('分页重叠保留最新副本，64 位序号不丢精度，同水位优先最新页', () => {
  const fresh = { targetUid: 'peer', msgSeq: '9007199254740993', sendTime: '200', body: '新预览' };
  const old = { ...fresh, msgSeq: '9007199254740992', sendTime: '100', body: '旧预览' };
  expect(mergeRecentContactPages([[fresh], [old]])).toEqual([fresh]);
  expect(mergeRecentContactPages([[old], [fresh]])).toEqual([fresh]);
  expect(mergeRecentContactPages([[fresh], [{ ...fresh, body: '旧分页' }]])).toEqual([fresh]);
});
