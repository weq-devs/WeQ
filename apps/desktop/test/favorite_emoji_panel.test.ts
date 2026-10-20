import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { EmojiPanel } from '../src/renderer/src/im-template/template/emojiPanel';

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      emojiPanel: {
        overview: {
          useQuery: () => ({
            data: {
              faces: [],
              recent: [],
              tags: [],
              favorites: [
                {
                  id: 'favorite',
                  hash: 'aabbccddeeff',
                  scope: 'personal',
                  bucket: '',
                  oriFile: 'aabbccddeeff.gif',
                  thumbFile: 'aabbccddeeff.png',
                  original: { scope: 'recv', bucket: '2026-09', file: 'aabbccddeeff.gif' },
                  remoteUrl: '',
                },
              ],
            },
          }),
        },
      },
    },
  },
}));
describe('收藏表情面板', () => {
  it('面板加载缩略图，点击插入原图地址且不自动发送', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onSelect = vi.fn();
    const onSelectSuper = vi.fn();
    try {
      act(() =>
        root.render(h(EmojiPanel, { panelRef: { current: null }, onSelect, onSelectSuper })),
      );
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="收藏"]')!.click());
      expect(host.querySelector('.emoji-cell img')?.getAttribute('src')).toContain('v=thumb');
      act(() => host.querySelector<HTMLButtonElement>('.emoji-cell')!.click());
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ token: '[[chat:fav:recv:2026-09:ori:aabbccddeeff.gif]]' }),
      );
      expect(onSelectSuper).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
