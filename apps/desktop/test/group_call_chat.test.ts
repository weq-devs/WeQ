import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GroupCallChatPanel } from '../src/renderer/src/components/call/GroupCallChatPanel';

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getSystemFaces: {
        useQuery: () => ({
          data: [
            { id: 451, desc: '/色', sticker: true },
            { id: 2, desc: '/色', sticker: false },
          ],
        }),
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({
  QqAvatar: ({ uin }: { uin: string }) => createElement('div', { 'data-avatar': uin }),
}));
vi.mock('../src/renderer/src/lib/resourceUrl', () => ({
  emojiUrl: (...parts: string[]) => `/emoji/${parts.join('/')}`,
  resourceUrl: (...parts: string[]) => `/${parts.join('/')}`,
}));

it('显示头像与内联小表情，未知表情或图片加载失败时保留原文', async () => {
  const window = new Window({ url: 'http://localhost' });
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.body);
  try {
    await act(async () => {
      root.render(
        createElement(GroupCallChatPanel, {
          messages: [
            { id: '1', senderUin: 1001, text: '喵\x14/色喵' },
            { id: '2', senderUin: 1001, text: '\x14/未知 /色' },
          ],
          name: () => '测试发言人',
        }),
      );
    });
    expect(document.querySelectorAll('[data-avatar="1001"]')).toHaveLength(2);
    expect(document.querySelector('[role="log"]')?.textContent).toContain('测试发言人');
    expect(document.querySelectorAll('input, textarea')).toHaveLength(0);
    const image = window.document.querySelector('img');
    expect(image?.getAttribute('src')).toBe('/emoji/2/apng/2.png');
    await act(async () => {
      image?.dispatchEvent(new window.Event('error'));
    });
    expect(
      [...document.querySelectorAll('.weq-group-call-chat-text')].map((el) => el.textContent),
    ).toEqual(['喵/色喵', '/未知 /色']);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    await window.close();
  }
});
