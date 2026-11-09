import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import {
  originalMessageClipboard,
  readOriginalMessageClipboard,
  prepareOriginalMessageClipboard,
} from '../src/renderer/src/lib/originalMessageClipboard';
import { composerTextToElements } from '../src/renderer/src/im-template/template/draftElements';
import * as repeat from '../src/renderer/src/lib/messageRepeat';
import {
  buildComposerSendPlan,
  buildOptimisticRender,
  composerNeedsStickerCatalog,
} from '../src/renderer/src/im-template/template/composerSend';
import { buildSendElems, type SendElement } from '@weq/protocol';
import { FaceSubType } from '@weq/codec';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const source = { account: 'synthetic-account', conversation: 'synthetic-conversation' };
const messages = [
  {
    body: '答复',
    createdAt: '2026-11-09T10:00:00+08:00',
    qqElements: [
      {
        type: 'reply',
        data: { origMsgSeq: 17, origElements: [{ type: 'text', data: { textContent: '原话' } }] },
      },
      { type: 'text', data: { textContent: '答复' } },
      {
        type: 'ark',
        data: { arkData: '{"app":"synthetic.app","config":{"token":"synthetic-secret"}}' },
      },
      { type: 'face', data: { faceId: 14, faceText: '[微笑]', reserve: new Uint8Array([1, 2]) } },
    ],
  },
];

it('WeQ 剪贴标识恢复原始引用与卡片，外部剪贴板不携带原始载荷', async () => {
  vi.stubGlobal('localStorage', new Storage());
  const value = originalMessageClipboard(messages, source, {
    text: '可读文本',
    html: '<div>可读文本</div>',
  });
  expect(value.text).toBe('可读文本');
  expect(value.html).not.toMatch(/synthetic-secret|origMsgSeq|arkData/);
  expect(new DOMParser().parseFromString(value.html, 'text/html').body.textContent).toBe(
    '可读文本',
  );
  const restored = readOriginalMessageClipboard(value.html, source.account)!;
  expect(restored.messages).toEqual(messages);
  const prepared = await prepareOriginalMessageClipboard(
    restored,
    source.conversation,
    new AbortController().signal,
  );
  expect(composerTextToElements(prepared.body)).toEqual([
    expect.objectContaining({
      kind: 'reply',
      origMsgSeq: 17,
      origElements: [{ kind: 'text', textContent: '原话' }],
    }),
    { kind: 'text', textContent: '答复' },
    expect.objectContaining({ kind: 'ark', arkData: messages[0]!.qqElements[2]!.data.arkData }),
    expect.objectContaining({ kind: 'face', reserve: new Uint8Array([1, 2]) }),
  ]);
});

it('批量粘贴按消息顺序恢复，不插入导出的作者和时间首行', async () => {
  vi.stubGlobal('localStorage', new Storage());
  const value = originalMessageClipboard(
    [
      { body: '第一条', createdAt: messages[0]!.createdAt },
      { body: '第二条', createdAt: messages[0]!.createdAt },
    ],
    source,
    { text: '作者 时间\n第一条\n\n作者 时间\n第二条', html: '' },
  );
  const prepared = await prepareOriginalMessageClipboard(
    readOriginalMessageClipboard(value.html, source.account)!,
    source.conversation,
    new AbortController().signal,
  );
  expect(prepared.body).toBe('第一条\n第二条');
});

it('伪造、旧剪贴标识和其他账号不能恢复私有原始记录', () => {
  vi.stubGlobal('localStorage', new Storage());
  const first = originalMessageClipboard(messages, source, { text: '一', html: '' });
  expect(readOriginalMessageClipboard(first.html, 'other-account')).toBeNull();
  expect(
    readOriginalMessageClipboard(
      '<div data-weq-message-clipboard="forged">一</div>',
      source.account,
    ),
  ).toBeNull();
  originalMessageClipboard(messages, source, { text: '二', html: '' });
  expect(readOriginalMessageClipboard(first.html, source.account)).toBeNull();
});

it('跨会话保留引用原文，不带错会话的引用指针', async () => {
  vi.stubGlobal('localStorage', new Storage());
  const value = originalMessageClipboard(messages, source, { text: '可读文本', html: '' });
  const prepared = await prepareOriginalMessageClipboard(
    readOriginalMessageClipboard(value.html, source.account)!,
    'other-conversation',
    new AbortController().signal,
  );
  expect(prepared.body).toContain('> 原话');
  expect(
    composerTextToElements(prepared.body).some(
      (item) => (item as { kind?: string }).kind === 'reply',
    ),
  ).toBe(false);
});

it('图文粘贴保留文字和图片顺序，并给重复粘贴重建独立可发送预览', async () => {
  vi.stubGlobal('localStorage', new Storage());
  vi.spyOn(repeat, 'repeatImageSources').mockImplementation(
    async (elements, _time, _signal, urls) => {
      urls?.set(elements[0]!, 'https://example.invalid/synthetic-image');
      return new Map([[elements[0]!, new Uint8Array([1, 2, 3])]]);
    },
  );
  const created = vi
    .spyOn(URL, 'createObjectURL')
    .mockReturnValueOnce('blob:paste-one')
    .mockReturnValueOnce('blob:paste-two');
  const value = originalMessageClipboard(
    [
      {
        createdAt: messages[0]!.createdAt,
        body: '图文',
        qqElements: [
          { type: 'text', data: { textContent: '前' } },
          { type: 'pic', data: { fileName: 'synthetic.png' } },
          { type: 'text', data: { textContent: '后' } },
        ],
      },
    ],
    source,
    { text: '前[图片]后', html: '' },
  );
  const snapshot = readOriginalMessageClipboard(value.html, source.account)!;
  for (const url of ['blob:paste-one', 'blob:paste-two']) {
    const prepared = await prepareOriginalMessageClipboard(
      snapshot,
      source.conversation,
      new AbortController().signal,
    );
    expect(composerTextToElements(prepared.body)).toEqual([
      { kind: 'text', textContent: '前' },
      { kind: 'pic', fileName: 'synthetic.png', localPreviewUrl: url },
      { kind: 'text', textContent: '后' },
    ]);
    expect(prepared.locals[0]).toMatchObject({ key: url, bytes: new Uint8Array([1, 2, 3]) });
    expect(prepared.objectUrls).toEqual([url]);
  }
  expect(created).toHaveBeenCalledTimes(2);
});

it('后续图片取回失败会释放已创建预览，不返回缺图的部分草稿', async () => {
  vi.stubGlobal('localStorage', new Storage());
  vi.spyOn(repeat, 'repeatImageSources')
    .mockImplementationOnce(async (elements, _time, _signal, urls) => {
      urls?.set(elements[0]!, 'https://example.invalid/synthetic-image');
      return new Map([[elements[0]!, new Uint8Array([1])]]);
    })
    .mockRejectedValueOnce(new Error('图片原文件不可用'));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:partial');
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  const value = originalMessageClipboard(
    [1, 2].map((index) => ({
      createdAt: messages[0]!.createdAt,
      body: '图文',
      qqElements: [{ type: 'pic', data: { fileName: `synthetic-${index}.png` } }],
    })),
    source,
    { text: '[图片]\n[图片]', html: '' },
  );
  await expect(
    prepareOriginalMessageClipboard(
      readOriginalMessageClipboard(value.html, source.account)!,
      source.conversation,
      new AbortController().signal,
    ),
  ).rejects.toThrow('图片原文件不可用');
  expect(revoke).toHaveBeenCalledWith('blob:partial');
});

it('粘贴后发送复用原消息转换器，随机表情与商城贴纸不退化，卡片正常乐观显示', async () => {
  vi.stubGlobal('localStorage', new Storage());
  const value = originalMessageClipboard(
    [
      {
        createdAt: messages[0]!.createdAt,
        body: '表情与卡片',
        qqElements: [
          {
            type: 'face',
            data: { faceId: 358, subType: FaceSubType.SUPER_EMOJI, innerId: 'synthetic-result' },
          },
          {
            type: 'mface',
            data: { emojiPackId: 42, marketEmoticonIdHex: 'a'.repeat(32), faceName: '[合成贴纸]' },
          },
          {
            type: 'ark',
            data: { arkData: '{"app":"synthetic.app","meta":{"news":{"title":"合成卡片"}}}' },
          },
        ],
      },
    ],
    source,
    { text: '[表情][卡片]', html: '' },
  );
  const prepared = await prepareOriginalMessageClipboard(
    readOriginalMessageClipboard(value.html, source.account)!,
    source.conversation,
    new AbortController().signal,
  );
  expect(composerNeedsStickerCatalog(prepared.body)).toBe(true);
  const superStickers = new Map([['358', { packId: '1', stickerId: '2' }]]);
  const input = { body: prepared.body, locals: [], superStickers };
  const plan = buildComposerSendPlan(input);
  expect(plan.kind).toBe('elements');
  if (plan.kind !== 'elements') throw new Error('预期元素计划');
  expect(plan.elements).toMatchObject([
    {
      kind: 'face',
      faceId: 358,
      superSticker: { packId: '1', stickerId: '2', resultId: 'synthetic-result' },
    },
    { kind: 'mface', emojiPackId: 42, marketEmoticonId: 'a'.repeat(32) },
    { kind: 'ark' },
  ]);
  expect(() => buildSendElems(plan.elements as SendElement[])).not.toThrow();
  const optimistic = buildOptimisticRender(input);
  expect(optimistic.elements).toMatchObject([
    { type: 'face', data: { innerId: 'synthetic-result' } },
    { type: 'mface' },
    { type: 'ark' },
  ]);
  expect(optimistic.body).toContain('合成卡片');
  expect(optimistic.body).not.toContain('[[chat:');
});
