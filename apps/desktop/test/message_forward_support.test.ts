import { afterEach, expect, it, vi } from 'vitest';
import {
  forwardUnsupportedReason,
  repeatImageSources,
  repeatSendPlan,
} from '../src/renderer/src/lib/messageRepeat';
import {
  failedForwardDraft,
  partitionForwardMessages,
  resolveFailedForwardMedia,
} from '../src/renderer/src/lib/sequentialForward';
import { elementsToComposerText } from '../src/renderer/src/im-template/template/draftElements';
import { buildComposerSendPlan } from '../src/renderer/src/im-template/template/composerSend';
import { createTemplateDemoData } from './support/templateDemoData';

afterEach(() => vi.unstubAllGlobals());

const base = createTemplateDemoData().messages[0]!;
const text = { type: 'text', data: { textContent: '正文' } };

it.each([
  'wallet',
  'call',
  'grayTipPoke',
  'grayTipRevoke',
  'grayTipGroup',
  'grayTipXml',
  'grayTipFileRecv',
  'grayTipTempSession',
  'onlineFile',
  'onlineFolder',
  'shareLocation',
  'qqDynamic',
  'inlineKeyboard',
  'structLongMsg',
  'unknown',
])('%s 不能混入可发送消息，也不能绕过发送计划预检', (type) => {
  const elements = [text, { type, data: {} }];
  expect(forwardUnsupportedReason(elements)).not.toBeNull();
  expect(() => repeatSendPlan(elements, new Map(), false)).toThrow();
  expect(partitionForwardMessages([{ ...base, qqElements: elements }]).sendable).toEqual([]);
});

it('圆形视频保留专用类型、模板、封面及视频尺寸，不降级普通视频', () => {
  const element = {
    type: 'bubbleVideo',
    data: {
      localPath: '/fixture/bubble.mp4',
      thumbLocalPath: '/fixture/cover.png',
      fileName: 'bubble.mp4',
      videoDuration: 4,
      videoWidth: 240,
      videoHeight: 240,
      templateName: 'fixture_template',
    },
  };
  expect(forwardUnsupportedReason([element])).toBeNull();
  expect(repeatSendPlan([element], new Map(), true)).toEqual({
    kind: 'elements',
    elements: [
      {
        kind: 'bubbleVideo',
        source: '/fixture/bubble.mp4',
        thumb: '/fixture/cover.png',
        fileName: 'bubble.mp4',
        duration: 4,
        width: 240,
        height: 240,
        templateName: 'fixture_template',
      },
    ],
  });
  expect(forwardUnsupportedReason([{ type: 'bubbleVideo', data: {} }])).not.toBeNull();
  expect(
    forwardUnsupportedReason([
      {
        type: 'video',
        data: {
          videoCoverLocalPath: '/fixture/cover.png',
        },
      },
    ]),
  ).not.toBeNull();
});

it('闪照使用原图代理并保留 flashPhoto，不能在未取得原图时作为普通图片发送', async () => {
  const element = {
    type: 'pic',
    data: { isFlash: true, fileToken: '/fixture-offpic', fileName: 'flash.png' },
  };
  const fetcher = vi.fn(async (_url: RequestInfo | URL) => new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal('fetch', fetcher);
  const images = await repeatImageSources([element], 1);
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('flashpic');
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('spec=0');
  expect(repeatSendPlan([element], new Map(), false, images)).toEqual({
    kind: 'elements',
    elements: [{ kind: 'flashPhoto', source: new Uint8Array([1, 2, 3]) }],
  });
  expect(() => repeatSendPlan([element], new Map(), false)).toThrow('闪照原文件');
  fetcher.mockImplementation(async () => new Response(null, { status: 404 }));
  await expect(repeatImageSources([element], 1)).rejects.toThrow('原文件不可用');
});

it('闪传缺少文件集身份时不可降级 Markdown；普通 Markdown 不受影响', () => {
  expect(
    forwardUnsupportedReason([
      {
        type: 'markdown',
        data: {
          markdownContent: '正文',
          flashTransferInfo: {},
        },
      },
    ]),
  ).not.toBeNull();
  expect(
    forwardUnsupportedReason([{ type: 'markdown', data: { markdownContent: '正文' } }]),
  ).toBeNull();
});

it.each([false, true])(
  '闪传使用专用分享计划并保留同一文件集，不降级普通消息（群聊：%s）',
  (group) => {
    const element = {
      type: 'markdown',
      data: {
        markdownContent: '[闪传](mqqapi://fixture)',
        markdownTextSummary: '[QQ闪传]',
        flashTransferInfo: { fileSetId: 'fixture-fileset' },
      },
    };
    const plan = repeatSendPlan([element], new Map(), group);
    expect(plan).toEqual({ kind: 'flashTransfer', fileSetId: 'fixture-fileset' });
  },
);

it('批量分流保留原顺序和整条拒绝原因，保留正文不因撤回删除而禁用', () => {
  const messages = [
    { ...base, id: 'one', recall: {}, qqElements: [text] },
    { ...base, id: 'unsupported', qqElements: [text, { type: 'wallet', data: {} }] },
    { ...base, id: 'two', deletedKind: 'weq' as const, qqElements: [text] },
  ];
  const prepared = partitionForwardMessages(messages);
  expect(prepared.sendable.map((message) => message.id)).toEqual(['one', 'two']);
  expect(prepared.ignored).toEqual([{ message: messages[1], reason: expect.any(String) }]);
});

it.each(['queued', 'sending'] as const)('尚在 %s 的本机消息不能进入转发队列', (optimistic) => {
  const prepared = partitionForwardMessages([{ ...base, optimistic, qqElements: [text] }]);
  expect(prepared.sendable).toHaveLength(0);
  expect(prepared.ignored[0]?.reason).toBeTruthy();
});

it('失败稿的正文和本地附件进入新发送计划，来源引用不会跨会话发送', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const body = elementsToComposerText([
    { kind: 'reply', origMsgSeq: 13 },
    { kind: 'text', textContent: '原稿' },
    { kind: 'pic', localPreviewUrl: 'blob:fixture', fileName: 'image.png' },
  ]);
  const draft = { body, locals: [{ key: 'blob:fixture', name: 'image.png', bytes }] };
  const failed = { ...base, optimistic: 'failed' as const, composerDraft: draft };
  const missing = { ...failed, id: 'missing', composerDraft: { body } };
  const result = partitionForwardMessages([failed, missing]);
  expect(result.sendable).toEqual([failed]);
  expect(result.ignored).toEqual([{ message: missing, reason: expect.any(String) }]);
  const prepared = failedForwardDraft(failed)!;
  expect(
    buildComposerSendPlan({
      body: prepared.body,
      locals: prepared.locals!,
      superStickers: new Map(),
    }),
  ).toMatchObject({
    kind: 'elements',
    elements: [
      { kind: 'text', textContent: '原稿' },
      { kind: 'image', source: bytes },
    ],
  });
  expect(
    partitionForwardMessages([{ ...base, optimistic: 'failed', qqElements: [text] }]).sendable,
  ).toHaveLength(1);
});

it('可明确确认丢失的本机附件在打开转发设置前报错', async () => {
  const body = elementsToComposerText([{ kind: 'file', localAttachmentId: 'original' }]);
  const fixture = {
    body,
    locals: [
      { key: 'original', name: '原文件', path: '/fixture/missing' },
      { key: 'removed', name: '已移除文件', path: '/fixture/unreferenced' },
    ],
  };
  const fetcher = vi.fn(async () => new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(resolveFailedForwardMedia(fixture)).rejects.toThrow('找不到本机附件');
  expect(fetcher).toHaveBeenCalledOnce();
});
