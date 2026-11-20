import { act, createElement } from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DressManifest } from '@weq/service';
import { DressUpDialog } from '../src/renderer/src/components/DressUpDialog';
vi.mock('../src/renderer/src/hooks/useDevelopmentDressTools', () => ({
  useDevelopmentDressTools: () => fixture.developmentTools,
}));

const fixture = vi.hoisted(() => ({
  developmentTools: true,
  activate: vi.fn(),
  download: vi.fn(),
  invalidate: vi.fn(),
  manifest: {
    bubbles: [],
    fonts: [],
    widgets: [],
    activeBubble: 0,
    activeFont: 0,
    activeWidget: 0,
    scope: 'mine',
    background: 'none',
    widgetId: '',
    backgroundOpacity: 1,
    widgetOpacity: 1,
  } as DressManifest,
}));

vi.mock('../src/renderer/src/hooks/useDressSkin', async (original) => ({
  ...(await original<typeof import('../src/renderer/src/hooks/useDressSkin')>()),
  syncDressSkin: vi.fn(),
  syncDressSkinPreloaded: vi.fn(async () => {}),
}));

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { dressup: { getState: { invalidate: fixture.invalidate } } } }),
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
                callBgId: 44,
                callBgName: 'QQ 同款通话背景',
                callBgUrl: 'https://example.test/call-background.jpg',
                callBgVideoUrl: 'https://example.test/call-background.mp4',
              },
              manifest: fixture.manifest,
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
            'setWidgetOpacity',
          ].map((name) => [name, { useMutation: () => ({ mutateAsync: fixture.activate }) }]),
        ),
      },
    },
  },
}));
vi.mock('../src/renderer/src/hooks/useDressDownload', () => ({
  useDressDownload: () => ({ run: fixture.download, disabled: false }),
}));
vi.mock('../src/renderer/src/components/ChatBackdrop', () => ({
  ScreenWidget: () => null,
  ChatBackdrop: () => null,
}));
vi.mock('../src/renderer/src/views/export/MarketEmojiBrowserLightbox', () => ({
  MarketEmojiBrowserLightbox: () => null,
}));

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  fixture.developmentTools = true;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.manifest = {
    bubbles: [],
    fonts: [],
    widgets: [],
    activeBubble: 0,
    activeFont: 0,
    activeWidget: 0,
    scope: 'mine',
    background: 'none',
    widgetId: '',
    backgroundOpacity: 1,
    widgetOpacity: 1,
  } as DressManifest;
  fixture.activate
    .mockReset()
    .mockImplementation(
      async (input: { scope?: DressManifest['scope']; kind?: string; itemId?: number }) => {
        if (input.scope) fixture.manifest = { ...fixture.manifest, scope: input.scope };
        if (input.kind === 'bubble')
          fixture.manifest = { ...fixture.manifest, activeBubble: input.itemId ?? 0 };
        return fixture.manifest;
      },
    );
});

it('默认打开使用页，三档范围保存并可取消当前气泡，商城入口不重复显示设置和说明', async () => {
  fixture.manifest.bubbles = [
    {
      itemId: 11,
      name: '本地气泡',
      slice: { left: 4, right: 4, top: 4, bottom: 4 },
      imageSize: { w: 40, h: 40 },
      textColor: '#222222',
    },
  ];
  fixture.manifest.activeBubble = 11;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(DressUpDialog, { onClose: () => {} })));
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('使用中');
    expect(host.querySelector('[role="tab"]:last-child')?.textContent).toBe('使用中');
    expect(host.getElementsByTagName('input')).toHaveLength(3);
    expect(host.textContent).toContain('本地气泡');
    expect(host.querySelector('[data-bubble-preview="11"]')).not.toBeNull();
    expect(host.querySelector('.weq-dress-search')).toBeNull();
    expect(host.querySelector('.weq-dress-toolbar')).toBeNull();
    expect(
      Array.from(
        host.querySelectorAll('input[type="radio"]'),
        (node) => (node as HTMLInputElement).value,
      ),
    ).toEqual(['mine', 'fallback', 'all']);
    await act(async () => host.querySelector<HTMLInputElement>('input[value="fallback"]')!.click());
    expect(fixture.activate).toHaveBeenLastCalledWith({ scope: 'fallback' });
    expect(host.querySelector<HTMLInputElement>('input[value="fallback"]')?.checked).toBe(true);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="取消使用聊天气泡"]')!.click(),
    );
    expect(fixture.activate).toHaveBeenLastCalledWith({ kind: 'bubble', itemId: 0 });
    expect(host.querySelector('[aria-label="取消使用聊天气泡"]')).toBeNull();
    expect(host.textContent).toContain('按消息记录还原');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="选择聊天气泡"]')!.click(),
    );
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('聊天气泡');
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(host.querySelector('.weq-dress-local-note')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('普通模式只保留聊天背景，商城直达不显示安装、覆盖或密钥工具', async () => {
  fixture.developmentTools = false;
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(createElement(DressUpDialog, { initialKind: 'bubble', onClose: () => {} })),
    );
    expect(Array.from(host.querySelectorAll('[role="tab"]'), (tab) => tab.textContent)).toEqual([
      '聊天背景',
    ]);
    expect(host.querySelector('.weq-dress-search')).toBeNull();
    expect(host.querySelector('.weq-dress-use')).toBeNull();
    expect(host.querySelector('[aria-label="装扮渲染范围"]')).toBeNull();
    expect(host.textContent).not.toContain('商城表情');
    expect(fixture.activate).not.toHaveBeenCalled();
    const layout = process.env.WEQ_DRESS_LAYOUT;
    if (layout) {
      mkdirSync(layout, { recursive: true });
      writeFileSync(resolve(layout, 'dress-normal.html'), host.innerHTML);
    }
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('通话背景的单个下载按钮保存原视频，不把背景 ID 当作气泡或字体资源', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.download.mockClear();
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(createElement(DressUpDialog, { initialKind: 'callbg', onClose: () => {} })),
    );
    await act(async () => host.querySelectorAll<HTMLButtonElement>('.weq-dress-chip')[1]!.click());
    expect(host.querySelector('.weq-dress-card-actions')?.querySelectorAll('button')).toHaveLength(
      2,
    );
    await act(async () => host.querySelector<HTMLButtonElement>('.weq-dress-save')!.click());
    expect(fixture.download).toHaveBeenCalledWith(
      'callbg',
      [
        {
          itemId: 44,
          name: 'QQ 同款通话背景',
          mediaUrl: 'https://example.test/call-background.mp4',
        },
      ],
      'callbg:44',
    );
  } finally {
    act(() => root.unmount());
  }
});

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
      const installed = host.querySelectorAll<HTMLButtonElement>('.weq-dress-chip')[1]!;
      expect(installed.textContent).toContain('1');
      await act(async () => installed.click());
      expect(host.textContent).toContain(name);
      expect(host.textContent).not.toContain('“使用”仅影响 WeQ 本地显示，不影响实际发送');
      const use = host.querySelector<HTMLButtonElement>('.weq-dress-use')!;
      expect(use.textContent).toBe('使用');
      expect(use.title).toBe('仅影响 WeQ 本地显示，不影响实际发送');
      expect(use.disabled).toBe(false);
      expect(fixture.activate).not.toHaveBeenCalled();
      const actions = host.querySelector('.weq-dress-card-actions')!;
      expect(
        Array.from(actions.querySelectorAll('button'), (button) => button.textContent),
      ).toEqual(['使用', '下载']);
      const layout = process.env.WEQ_DRESS_LAYOUT;
      if (layout) {
        mkdirSync(layout, { recursive: true });
        const styles = ['index.css', 'dressup.css']
          .map(
            (file) =>
              `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', file)}">`,
          )
          .join('');
        writeFileSync(
          resolve(layout, `dress-${kind}.html`),
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>html,body{margin:0;background:var(--background);color:var(--foreground);font-family:system-ui}*,*::before,*::after{box-sizing:border-box}.weq-dress-card{width:220px;max-width:calc(100% - 32px);margin:16px}</style><body>${host.querySelector('.weq-dress-card')!.outerHTML}</body></html>`,
        );
      }
      fixture.download.mockClear();
      await act(async () => host.querySelector<HTMLButtonElement>('.weq-dress-save')!.click());
      expect(fixture.download).toHaveBeenCalledWith(
        kind,
        [expect.objectContaining({ name })],
        expect.stringContaining(`${kind}:`),
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
