import { act, createElement } from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DressMallItem, DressManifest, DressScopeKind } from '@weq/service';
import { DressUpDialog } from '../src/renderer/src/components/DressUpDialog';
import { resolveChatBackdrop } from '../src/renderer/src/hooks/useDressSkin';
vi.mock('../src/renderer/src/hooks/useDevelopmentDressTools', () => ({
  useDevelopmentDressTools: () => fixture.developmentTools,
}));

const fixture = vi.hoisted(() => ({
  developmentTools: true,
  activate: vi.fn(),
  setCallBackground: vi.fn(),
  rankItems: [] as DressMallItem[],
  callBackground: {
    itemId: 44,
    name: 'QQ 同款通话背景',
    imageUrl: 'https://example.test/call-background.jpg',
    videoUrl: 'https://example.test/call-background.mp4',
  },
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
                callBgId: fixture.callBackground.itemId,
                callBgName: fixture.callBackground.name,
                callBgUrl: fixture.callBackground.imageUrl,
                callBgVideoUrl: fixture.callBackground.videoUrl,
              },
              manifest: fixture.manifest,
            },
          }),
        },
        rank: { useQuery: () => ({ data: { items: fixture.rankItems } }) },
        search: { useQuery: () => ({ data: { items: [] } }) },
        widgets: { useQuery: () => ({ data: [] }) },
        setCallBackground: { useMutation: () => ({ mutateAsync: fixture.setCallBackground }) },
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
  fixture.rankItems = [];
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
  fixture.callBackground = {
    itemId: 44,
    name: 'QQ 同款通话背景',
    imageUrl: 'https://example.test/call-background.jpg',
    videoUrl: 'https://example.test/call-background.mp4',
  };
  fixture.setCallBackground
    .mockReset()
    .mockImplementation(async ({ itemId, name = '', imageUrl = '', videoUrl = '' }) => {
      fixture.callBackground = { itemId, name, imageUrl, videoUrl };
    });
  fixture.activate
    .mockReset()
    .mockImplementation(
      async (input: { scope?: DressManifest['scope']; kind?: DressScopeKind; itemId?: number }) => {
        if (input.scope && input.kind)
          fixture.manifest = {
            ...fixture.manifest,
            scopes: {
              bubble: 'mine',
              font: 'mine',
              widget: 'mine',
              ...fixture.manifest.scopes,
              [input.kind]: input.scope,
            },
          };
        if (input.itemId !== undefined && input.kind === 'bubble')
          fixture.manifest = { ...fixture.manifest, activeBubble: input.itemId ?? 0 };
        return fixture.manifest;
      },
    );
});

it('默认打开第一个页签，使用中可保存三档范围并取消当前气泡', async () => {
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
    expect(host.querySelector('[role="tab"]')?.getAttribute('aria-selected')).toBe('true');
    const usageTab = host.querySelector<HTMLButtonElement>('#weq-dress-tab-usage')!;
    await act(async () => usageTab.click());
    expect(usageTab.getAttribute('aria-selected')).toBe('true');

    expect(host.textContent).toContain('本地气泡');
    expect(host.querySelector('[data-bubble-preview="11"]')).not.toBeNull();
    expect(host.querySelector('.weq-dress-search')).toBeNull();
    expect(host.querySelector('.weq-dress-toolbar')).toBeNull();
    const card = host.querySelector('article[aria-label="聊天气泡"]')!;
    const select = card.querySelector('select')!;
    await act(async () => {
      select.value = 'fallback';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(fixture.activate).toHaveBeenLastCalledWith({ kind: 'bubble', scope: 'fallback' });
    expect(select.value).toBe('fallback');
    expect(host.querySelector('article[aria-label="聊天字体"] select')).toHaveProperty(
      'value',
      'mine',
    );
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
    expect(host.querySelector('[aria-label="聊天气泡渲染范围"]')).toBeNull();
    expect(host.querySelector('.weq-dress-local-note')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('会话背景和浮屏独立处理跟随、单独选款及明确关闭', () => {
  const global = {
    ...fixture.manifest,
    background: 'qq' as const,
    backgroundOpacity: 0.6,
    widgetId: '1',
    widgetOpacity: 0.7,
  };
  const qq = 'https://example.test/background.png';
  const conversation = { kind: 'group', conv: '42', title: '项目讨论' } as const;
  expect(resolveChatBackdrop(global, qq, { ...conversation, background: 'off' })).toMatchObject({
    imageUrl: '',
    videoUrl: '',
    widgetId: '1',
    widgetOpacity: 0.7,
    backgroundFollowsGlobal: false,
    widgetFollowsGlobal: true,
  });
  const selected = resolveChatBackdrop(global, qq, {
    ...conversation,
    background: { source: 'custom', file: 'bg-fixture.mp4', opacity: 0.3 },
    screen: { widgetId: '3', opacity: 0 },
  });
  expect(selected).toMatchObject({
    imageUrl: '',
    backgroundOpacity: 0.3,
    widgetId: '3',
    widgetOpacity: 0,
    widgetFollowsGlobal: false,
  });
  expect(selected.videoUrl).toContain('kind=group&conv=42');
  expect(resolveChatBackdrop(global, qq, { ...conversation, screen: 'off' })).toMatchObject({
    imageUrl: expect.stringContaining('background.png'),
    backgroundOpacity: 0.6,
    widgetId: '',
  });
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
    expect(host.querySelector('[aria-label="聊天气泡渲染范围"]')).toBeNull();
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

it('热门通话背景用专用接口保存，使用中可查看并取消', async () => {
  fixture.rankItems = [
    {
      appId: 17,
      itemId: 41136,
      name: '星雨戏水喵',
      previewUrl: 'https://example.test/star-small.jpg',
      previewLargeUrl: 'https://example.test/star.jpg',
      videoUrl: 'https://example.test/star.mp4',
      labels: [],
      price: 0,
      mallName: '',
    },
  ];
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(createElement(DressUpDialog, { initialKind: 'callbg', onClose: () => {} })),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('.weq-dress-use')!.click());
    expect(fixture.setCallBackground).toHaveBeenCalledWith({
      itemId: 41136,
      name: '星雨戏水喵',
      imageUrl: 'https://example.test/star.jpg',
      videoUrl: 'https://example.test/star.mp4',
    });
    expect(fixture.activate).not.toHaveBeenCalled();
    const usageTab = host.querySelector<HTMLButtonElement>('[role="tab"]:last-child')!;
    await act(async () => usageTab.click());
    expect(host.textContent).toContain('星雨戏水喵');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="取消使用通话背景"]')!.click(),
    );
    expect(fixture.setCallBackground).toHaveBeenLastCalledWith({ itemId: 0 });
    expect(host.textContent).not.toContain('星雨戏水喵');
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
