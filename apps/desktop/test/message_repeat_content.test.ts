import { afterEach, expect, it, vi } from 'vitest';
import {
  canRepeatMessage,
  repeatImageSources,
  repeatSendPlan,
  repeatTarget,
} from '../src/renderer/src/lib/messageRepeat';

afterEach(() => vi.unstubAllGlobals());

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
