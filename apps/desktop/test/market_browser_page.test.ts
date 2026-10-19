import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { client, trpc } from '../src/renderer/src/trpc/client';
import { DressUpDialog } from '../src/renderer/src/components/DressUpDialog';
import { MarketEmojiBrowserLightbox } from '../src/renderer/src/views/export/MarketEmojiBrowserLightbox';
import {
  WorkspaceContent,
  WorkspacePage,
  WorkspacePages,
} from '../src/renderer/src/components/WorkspacePages';
import type { ExportSavePolicy } from '@weq/service';

const saveState = vi.hoisted(() => ({
  prepare: vi.fn(async (intent?: ExportSavePolicy) => intent ?? { mode: 'after' as const }),
  download: vi.fn(async (_input: unknown) => 'task-a'),
}));

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { listExportTasks: { invalidate: async () => {} } } }),
    account: {
      dressup: {
        getState: { useQuery: () => ({ data: { qqOnline: false } }) },
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
            'setBackgroundOpacity',
          ].map((name) => [name, { useMutation: () => ({}) }]),
        ),
      },
      marketEmoji: {
        getPackDetail: {
          useQuery: vi.fn(() => ({
            isLoading: false,
            isInitialLoading: false,
            data: {
              name: '测试表情包',
              feeType: 'free',
              count: 1,
              items: [{ hash: '0123456789abcdef0123456789abcdef', name: '开心' }],
            },
          })),
        },
      },
    },
  },
  client: {
    account: {
      marketEmoji: {
        startDownload: { mutate: saveState.download },
        searchCatalog: {
          query: vi.fn().mockResolvedValue({ entries: [], total: 0, nextCursor: null }),
        },
      },
    },
  },
}));

it('商城表情复用装扮顶部搜索，离线可提交、清空，切换页签保留独立关键词', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(h(DressUpDialog, { initialKind: 'emoji', onClose: () => {} })),
    );
    const input = host.querySelector<HTMLInputElement>('.weq-dress-search input')!;
    expect(input.disabled).toBe(false);
    expect(input.getAttribute('aria-label')).toBe('搜索表情包');
    expect(host.querySelector('.weq-directory-toolbar [aria-label="搜索表情包"]')).toBeNull();
    const query = vi.mocked(client.account.marketEmoji.searchCatalog.query);
    query.mockClear();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        ' 开心 ',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(query).not.toHaveBeenCalled();
    await act(async () =>
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: '开心' }));
    const tab = (label: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (item) => item.textContent === label,
      )!;
    await act(async () => tab('聊天气泡').click());
    expect(host.querySelector<HTMLInputElement>('.weq-dress-search input')!.disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('.weq-dress-search input')!.value).toBe('');
    await act(async () => tab('商城表情').click());
    expect(host.querySelector<HTMLInputElement>('.weq-dress-search input')!.value).toBe(' 开心 ');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="清空搜索"]')!.click(),
    );
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: undefined }));
    expect(host.querySelector<HTMLInputElement>('.weq-dress-search input')!.value).toBe('');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    policy: { mode: 'after' },
    settings: { isLoading: false },
    picking: false,
    accountUin: '10001',
    isCurrent: () => true,
    prepareSave: saveState.prepare,
  }),
}));

it('商城详情的下载菜单只覆盖本次保存方式，多选不展开保存栏', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  saveState.prepare.mockClear();
  saveState.download.mockClear();
  try {
    await act(async () =>
      root.render(h(MarketEmojiBrowserLightbox, { embedded: true, initialPackId: 'test-pack' })),
    );
    expect(host.querySelector('.weq-export-save-control')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="本次保存选项"]')!.click());
    const choose = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (node) => node.textContent === '先生成，稍后保存',
    )!;
    await act(async () => choose.click());
    expect(saveState.prepare).toHaveBeenLastCalledWith({ mode: 'after' });
    expect(saveState.download).toHaveBeenCalledWith(
      expect.objectContaining({ savePolicy: { mode: 'after' } }),
    );
    expect(host.querySelector('.weq-export-save-control')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('内嵌模式不套整页、不渲染关闭按钮，可直接放进个性装扮页签', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(MarketEmojiBrowserLightbox, { embedded: true })));
    const page = host.querySelector('.weq-market-browser')!;
    expect(page.classList.contains('is-embedded')).toBe(true);
    expect(page.closest('[aria-label="商城表情"]')).toBeNull();
    expect(host.querySelector('.weq-workspace-page')).toBeNull();
    expect(host.querySelector('[aria-label="关闭商城表情"]')).toBeNull();
    expect(page.querySelector('.weq-market-head')).toBeNull();
    expect(page.querySelector('.weq-market-summary')?.textContent).toBe('共 0 套');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('目录使用预览卡片，接近视口才加载图片，返回保留目录滚动位置', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const observers: Array<{ callback: IntersectionObserverCallback; element?: Element }> = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      record: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback };
        observers.push(this.record);
      }
      observe(element: Element) {
        this.record.element = element;
      }
      disconnect() {}
    },
  );
  vi.mocked(client.account.marketEmoji.searchCatalog.query).mockResolvedValueOnce({
    entries: [
      { id: '100', name: '预览测试', mark: '简介', feeType: 'free' },
      { id: '101', name: '另一个包', mark: '', feeType: 'vip' },
    ],
    total: 2,
    nextCursor: null,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(MarketEmojiBrowserLightbox, { embedded: true })));
    const cards = host.querySelectorAll<HTMLButtonElement>('.weq-market-pack-card');
    expect(cards).toHaveLength(2);
    expect(host.querySelector('.weq-market-pack-grid img')).toBeNull();
    expect(trpc.account.marketEmoji.getPackDetail.useQuery).toHaveBeenCalledWith(
      { packId: '100' },
      expect.objectContaining({ enabled: false }),
    );
    const observer = observers.find((item) => item.element === cards[0])!;
    act(() =>
      observer.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(host.querySelectorAll('.weq-market-pack-grid img')).toHaveLength(1);
    expect(cards[0].querySelector('img')?.getAttribute('src')).toContain('pack=100');
    expect(trpc.account.marketEmoji.getPackDetail.useQuery).toHaveBeenCalledWith(
      { packId: '100' },
      expect.objectContaining({ enabled: true }),
    );
    act(() => cards[0].querySelector('img')!.dispatchEvent(new Event('error')));
    expect(cards[0].querySelector('img')).toBeNull();
    expect(cards[0].querySelector('.weq-mface-lb-fallback')).not.toBeNull();
    const scroll = host.querySelector<HTMLElement>('.weq-market-catalog-scroll')!;
    scroll.scrollTop = 120;
    act(() => cards[0].click());
    expect(host.querySelector<HTMLElement>('.weq-market-catalog')!.hidden).toBe(true);
    expect(host.querySelector('.weq-emb-detail')).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="返回表情包列表"]')!.click());
    expect(host.querySelector<HTMLElement>('.weq-market-catalog')!.hidden).toBe(false);
    expect(scroll.scrollTop).toBe(120);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="多选表情包"]')!.click());
    expect(host.querySelector('.weq-export-save-control')).toBeNull();
    act(() => cards[1].click());
    expect(cards[1].classList.contains('is-selected')).toBe(true);
    expect(host.querySelector('.weq-emb-detail')).toBeNull();
    act(() => cards[1].click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="退出多选"]')!.click());
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('内嵌详情保留计数条和返回入口，筛选状态可访问且不叠加页面标题', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(h(MarketEmojiBrowserLightbox, { embedded: true, initialPackId: 'test-pack' })),
    );
    expect(host.querySelector('.weq-market-head')).toBeNull();
    expect(host.querySelector('.weq-market-summary [role="status"]')?.textContent).toBe('共 0 套');
    expect(host.querySelector('.weq-mface-lb-title')?.textContent).toBe('测试表情包');
    const filters = host.querySelectorAll<HTMLButtonElement>('.weq-mpd-fee-chip');
    expect(filters[0].getAttribute('aria-pressed')).toBe('true');
    await act(async () => filters[1].click());
    expect(filters[0].getAttribute('aria-pressed')).toBe('false');
    expect(filters[1].getAttribute('aria-pressed')).toBe('true');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="返回表情包列表"]')!.click());
    expect(host.querySelector('.weq-market-browser')?.classList.contains('has-detail')).toBe(false);
    expect(host.querySelector('.weq-emb-detail')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('在整包详情内提交顶部搜索时返回目录并应用新关键词', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(MarketEmojiBrowserLightbox, {
          embedded: true,
          initialPackId: 'test-pack',
          searchQuery: '',
        }),
      ),
    );
    expect(host.querySelector('.weq-emb-detail')).not.toBeNull();
    await act(async () =>
      root.render(
        h(MarketEmojiBrowserLightbox, {
          embedded: true,
          initialPackId: 'test-pack',
          searchQuery: '开心',
        }),
      ),
    );
    expect(host.querySelector('.weq-emb-detail')).toBeNull();
    expect(host.querySelector<HTMLElement>('.weq-market-catalog')!.hidden).toBe(false);
    expect(client.account.marketEmoji.searchCatalog.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ keyword: '开心' }),
    );
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('商城表情使用无标签整页和整页标题栏，关闭后恢复原内容并保留报告', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function View() {
    const [open, setOpen] = useState(true);
    return h(
      WorkspacePages,
      { navigationKey: 'chat' },
      h(WorkspaceContent, null, h('input', { 'data-chat-draft': true })),
      h(WorkspacePage, { title: '已有报告', retainOnNavigate: true }, '报告内容'),
      open && h(MarketEmojiBrowserLightbox, { onClose: () => setOpen(false) }),
    );
  }
  try {
    await act(async () => root.render(h(View)));
    const page = host.querySelector('.weq-market-browser')!;
    expect(page.closest('[role="region"][aria-label="商城表情"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="内容页面"]')).toBeNull();
    expect(page.classList.contains('weq-blob-dialog')).toBe(false);
    expect(page.querySelector('header h2')?.textContent).toBe('商城表情');
    const draft = host.querySelector<HTMLInputElement>('[data-chat-draft]')!;
    draft.value = '原会话草稿';
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="关闭商城表情"]')!.click());
    expect(host.querySelector('.weq-market-browser')).toBeNull();
    expect(host.querySelector('[aria-label="内容页面"]')).toBeNull();
    expect(host.querySelector('[aria-label="已有报告"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="已有报告"]')?.closest('[hidden]')).toBeNull();
    expect(draft.closest('[hidden]')).not.toBeNull();
    expect(draft.value).toBe('原会话草稿');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
