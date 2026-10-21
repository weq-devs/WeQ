// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MailBody } from '../src/renderer/src/views/mail/MailBody';
import type { MailApi } from '../src/renderer/src/views/mail/api';

const api = {} as MailApi;

it('iframe 文档还没有根元素时布局不抛错，加载后再写入主题变量', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const variables = new Map<string, string>();
  // 首次布局时 contentDocument 已存在，但 documentElement 可能仍是 null；
  // 旧实现直接在 null 上读 style，会抛 Cannot read properties of null。
  const documentElement = {
    style: {
      setProperty: (name: string, value: string): void => void variables.set(name, value),
    },
  };
  const contentDocument = {
    documentElement: null as typeof documentElement | null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getElementById: vi.fn(() => null),
  };
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
    configurable: true,
    get: () => contentDocument,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(MailBody, { html: '<p>正文</p>', api })));
    expect(variables.size).toBe(0);
    contentDocument.documentElement = documentElement;
    const frame = host.querySelector('iframe')!;
    act(() => {
      frame.dispatchEvent(new Event('load'));
    });
    expect(variables.has('--mail-fg')).toBe(true);
    expect(variables.has('--mail-accent')).toBe(true);
  } finally {
    act(() => root.unmount());
    host.remove();
    Reflect.deleteProperty(HTMLIFrameElement.prototype, 'contentDocument');
    vi.unstubAllGlobals();
  }
});
