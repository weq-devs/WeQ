import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { EmojiPanel } from '../src/renderer/src/im-template/template/emojiPanel';
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: (component: unknown) => component,
  useQQAction: () => ({ binding: null, available: false, disabled: true }),
}));
vi.mock('../src/renderer/src/components/qq-actions/shared.shared', () => ({
  withQQAccountScope: (component: unknown) => component,
  useQQAction: () => ({ binding: null, available: false, disabled: true }),
}));
vi.mock('../src/renderer/src/components/MediaSaveControls', () => ({
  useMediaSave: () => ({ disabled: false, prompt: null }),
}));
vi.mock('../src/renderer/src/components/MediaSaveControls.shared', () => ({
  useMediaSave: () => ({ disabled: false, prompt: null }),
}));
vi.mock('../src/renderer/src/components/qq-actions/FavoriteBundleControls', () => ({
  FavoriteBundleControls: () =>
    h(
      'div',
      { role: 'toolbar', 'aria-label': '收藏表情导入导出' },
      h('button', { type: 'button', 'aria-label': '导入收藏表情包' }),
      h('button', { type: 'button', 'aria-label': '导出收藏表情包' }),
    ),
}));

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({}),
    account: {
      qqActions: { favorites: { useQuery: () => ({ data: undefined }) } },
      emojiPanel: {
        catalog: {
          useQuery: () => ({
            data: {
              faces: [
                {
                  key: 'standard',
                  label: '经典表情',
                  unicode: false,
                  items: [
                    { id: '14', desc: '[微笑]', unicode: false, sticker: false },
                    { id: '1', desc: '[撇嘴]', unicode: false, sticker: false },
                  ],
                },
              ],
              recent: [],
            },
          }),
        },
        favorites: {
          useQuery: () => ({
            data: [
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
          }),
        },
      },
    },
  },
}));
describe('收藏表情面板', () => {
  it('面板加载缩略图，点击插入原图地址且不自动发送', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // Happy DOM 没有真实可见区域；视口加载由浏览器夹具覆盖。
    vi.stubGlobal('IntersectionObserver', undefined);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onSelect = vi.fn();
    const onSelectSuper = vi.fn();
    const renderPanel = (textOnly = false) =>
      act(() =>
        root.render(
          h(EmojiPanel, { panelRef: { current: null }, onSelect, onSelectSuper, textOnly }),
        ),
      );
    const selectedTab = () =>
      host.querySelector('.emoji-tabs button[aria-pressed="true"]')?.getAttribute('aria-label');
    try {
      renderPanel();
      expect(selectedTab()).toBe('表情');
      const search = host.querySelector<HTMLInputElement>('[aria-label="搜索表情"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          search,
          'wx',
        );
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const matches = host.querySelectorAll<HTMLButtonElement>('.emoji-cell');
      expect([...matches].map((button) => button.title)).toEqual(['[微笑]']);
      act(() => matches[0]!.click());
      expect(onSelect).toHaveBeenLastCalledWith(
        expect.objectContaining({ token: '[[chat:face:14]]' }),
      );
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="收藏"]')!.click());
      expect(host.querySelector('[aria-label="导入收藏表情包"]')).not.toBeNull();
      expect(host.querySelector('[aria-label="导出收藏表情包"]')).not.toBeNull();
      expect(host.querySelector('.emoji-cell img')?.getAttribute('src')).toContain('v=thumb');
      act(() => host.querySelector<HTMLButtonElement>('.emoji-cell')!.click());
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ token: '[[chat:fav:recv:2026-09:ori:aabbccddeeff.gif]]' }),
      );
      expect(onSelectSuper).not.toHaveBeenCalled();

      act(() => root.render(null));
      renderPanel();
      expect(selectedTab()).toBe('收藏');

      act(() => root.render(null));
      renderPanel(true);
      expect(selectedTab()).toBe('表情');
      expect(host.querySelector<HTMLButtonElement>('[aria-label="收藏"]')?.disabled).toBe(true);

      act(() => root.render(null));
      renderPanel();
      expect(selectedTab()).toBe('收藏');
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
