import { afterEach, expect, it, vi } from 'vitest';
import { buildSendElems, type SendElement } from '@weqbot/protocol';
import {
  canRepeatMessage,
  forwardUnsupportedReason,
  repeatImageSources,
  repeatSendPlan,
  repeatTarget,
} from '../src/renderer/src/lib/messageRepeat';

afterEach(() => vi.unstubAllGlobals());

it('转发过滤空文本占位，保留实际文本及空格，预检与发送使用同一份有效内容', () => {
  const elements = [
    { type: 'text', data: { textContent: '' } },
    { type: 'text', data: {} },
    { type: 'text', data: { textContent: '正文' } },
    { type: 'text', data: { textContent: ' ' } },
  ];
  expect(forwardUnsupportedReason(elements)).toBeNull();
  const plan = repeatSendPlan(elements, new Map(), false);
  expect(plan).toEqual({
    kind: 'elements',
    elements: [
      { kind: 'text', textContent: '正文' },
      { kind: 'text', textContent: ' ' },
    ],
  });
  if (plan.kind !== 'elements') throw new Error('缺少元素发送计划');
  expect(() => buildSendElems(plan.elements as SendElement[])).not.toThrow();

  expect(() => repeatSendPlan(elements.slice(0, 2), new Map(), false)).toThrow('没有可重发');
  expect(forwardUnsupportedReason(elements.slice(0, 2))).toContain('没有可重发');
});

it('文件旁的空文本占位不再被误判为混合文件发送', () => {
  const elements = [
    { type: 'text', data: { textContent: '' } },
    { type: 'file', data: { localPath: '/fixture/archive.zip', fileName: 'archive.zip' } },
  ];
  expect(forwardUnsupportedReason(elements)).toBeNull();
  expect(repeatSendPlan(elements, new Map(), false)).toEqual({
    kind: 'file',
    path: '/fixture/archive.zip',
    fileName: 'archive.zip',
  });
});

it('重发引用时也过滤被引消息中的空文本占位，不更改引用指针', () => {
  const plan = repeatSendPlan(
    [
      {
        type: 'reply',
        data: {
          origMsgSeq: 11,
          origMsgIndex: 22,
          origElements: [
            { type: 'text', data: { textContent: '' } },
            { type: 'text', data: { textContent: '被引正文' } },
          ],
        },
      },
      { type: 'text', data: { textContent: '回复正文' } },
    ],
    new Map(),
    false,
  );
  expect(plan).toMatchObject({
    kind: 'elements',
    elements: [
      {
        kind: 'reply',
        origMsgSeq: 22,
        origElements: [{ kind: 'text', textContent: '被引正文' }],
      },
      { kind: 'text', textContent: '回复正文' },
    ],
  });
  if (plan.kind !== 'elements') throw new Error('缺少引用发送计划');
  expect(() => buildSendElems(plan.elements as SendElement[])).not.toThrow();
});

it('手动重发图片不要求用于自动比对的 MD5，但实际发送必须先拿到完整字节', async () => {
  const picture = {
    type: 'pic',
    data: { fileName: 'fixture.png', originalUrl: 'https://fixture.invalid/image' },
  };
  const retained = { id: 'retained', recall: {}, qqElements: [picture] };
  expect(canRepeatMessage(retained)).toBe(true);
  expect(repeatTarget([retained, retained], true)).toBeNull();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );
  const images = await repeatImageSources([picture], 1);
  expect(repeatSendPlan([picture], new Map(), false, images)).toMatchObject({
    kind: 'elements',
    elements: [{ kind: 'image', source: new Uint8Array([1, 2, 3]) }],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  await expect(repeatImageSources([picture], 1)).rejects.toThrow('原文件不可用');
});

it('媒体和未知元素不能降级成正文占位重发', () => {
  expect(
    canRepeatMessage({
      id: 'missing-file',
      body: '[文件]',
      qqElements: [{ type: 'file', data: { md5: 'a'.repeat(32), fileName: 'missing.zip' } }],
    }),
  ).toBe(false);
  expect(
    canRepeatMessage({
      id: 'unknown',
      body: '可见摘要',
      qqElements: [{ type: 'unknown', data: {} }],
    }),
  ).toBe(false);
});
