import { afterEach, expect, it, vi } from 'vitest';
import {
  buildSendElems,
  decodeMessage,
  encode,
  PUSH_MSG_BODY,
  type SendElement,
} from '@weq/protocol';
import {
  forwardUnsupportedReason,
  repeatImageSources,
  repeatSendPlan,
} from '../src/renderer/src/lib/messageRepeat';
import { partitionForwardMessages } from '../src/renderer/src/lib/sequentialForward';
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
  '闪传经转发计划及实际 wire 编码后，收侧仍识别同一文件集（群聊：%s）',
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
    if (plan.kind !== 'elements') throw new Error('缺少闪传发送计划');
    const elems = buildSendElems(plan.elements as SendElement[], {
      scene: group ? 'group' : 'c2c',
    });
    const decoded = decodeMessage(
      encode(PUSH_MSG_BODY, {
        contentHead: { msgType: group ? 82 : 166, sequence: 1, timestamp: 1 },
        body: { richText: { elems } },
      }),
    );
    expect(decoded.elements).toMatchObject([{ kind: 'markdown', ...element.data }]);
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

it.each(['sending', 'failed'] as const)('尚未确认的本机 %s 消息不能进入转发队列', (optimistic) => {
  const prepared = partitionForwardMessages([{ ...base, optimistic, qqElements: [text] }]);
  expect(prepared.sendable).toHaveLength(0);
  expect(prepared.ignored[0]?.reason).toContain(optimistic === 'sending' ? '发送中' : '未确认');
});
