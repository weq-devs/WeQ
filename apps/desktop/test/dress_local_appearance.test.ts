import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DressUpDialog } from '../src/renderer/src/components/DressUpDialog';

const fixture = vi.hoisted(() => ({
  activate: vi.fn(),
  download: vi.fn(),
  mediaDownload: vi.fn(),
}));

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({}),
    account: {
      dressup: {
        getState: {
          useQuery: () => ({
            data: {
              qqOnline: false,
              own: {
                bubbleId: 11,
                bubbleName: 'QQ 同款气泡',
                fontId: 22,
                fontName: 'QQ 同款字体',
                widgetId: 33,
                widgetName: 'QQ 同款挂件',
              },
              manifest: { bubbles: [], fonts: [], widgets: [] },
            },
          }),
        },
        rank: { useQuery: () => ({ data: { items: [] } }) },
        search: { useQuery: () => ({ data: { items: [] } }) },
        widgets: { useQuery: () => ({ data: [] }) },
        ...Object.fromEntries(
          [
            'installBubble',
            'installFont',
            'installWidget',
            'setActive',
            'setScope',
            'pickBackground',
            'setBackground',
            'setWidget',
            'setCallBackground',
            'setBackgroundOpacity',
          ].map((name) => [name, { useMutation: () => ({ mutateAsync: fixture.activate }) }]),
        ),
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/DecorationSaveControls', () => ({
  useDecorationSave: () => ({ run: fixture.download, disabled: false }),
}));
vi.mock('../src/renderer/src/components/MediaSaveControls', () => ({
  useMediaSave: () => ({ run: fixture.mediaDownload, disabled: false, isBusy: () => false }),
}));
vi.mock('../src/renderer/src/components/ChatBackdrop', () => ({ ScreenWidget: () => null }));
vi.mock('../src/renderer/src/views/export/MarketEmojiBrowserLightbox', () => ({
  MarketEmojiBrowserLightbox: () => null,
}));

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['bubble', 'QQ 同款气泡'],
  ['font', 'QQ 同款字体'],
  ['widget', 'QQ 同款挂件'],
] as const)(
  'QQ 同款 %s 自动列入已装，但不自动使用，并说明本地显示与发送的区别',
  async (kind, name) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fixture.activate.mockClear();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(DressUpDialog, { initialKind: kind, onClose: () => {} })),
      );
      const installed = host.querySelector<HTMLButtonElement>('.weq-dress-chip')!;
      expect(installed.textContent).toContain('1');
      await act(async () => installed.click());
      expect(host.textContent).toContain(name);
      expect(host.textContent).toContain('“使用”仅影响 WeQ 本地显示，不影响实际发送');
      const use = host.querySelector<HTMLButtonElement>('.weq-dress-use')!;
      expect(use.textContent).toBe('使用');
      expect(use.title).toBe('仅影响 WeQ 本地显示，不影响实际发送');
      expect(use.disabled).toBe(false);
      expect(fixture.activate).not.toHaveBeenCalled();
      const actions = host.querySelector('.weq-dress-card-actions')!;
      expect(
        Array.from(actions.querySelectorAll('button'), (button) => button.textContent),
      ).toEqual(['使用', '下载']);
      fixture.download.mockClear();
      await act(async () => host.querySelector<HTMLButtonElement>('.weq-dress-save')!.click());
      expect(fixture.download).toHaveBeenCalledWith(
        expect.objectContaining({ kind }),
        expect.stringContaining(`${kind}:`),
        undefined,
        false,
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
