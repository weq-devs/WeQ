import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectionDialog } from '../src/renderer/src/components/CollectionDialog';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rpc = vi.hoisted(() => ({ item: vi.fn(), detail: vi.fn(), sync: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      localCollectionItem: { query: rpc.item },
      listCollections: { query: async () => ({ items: [], hasMore: false }) },
      collectionDetail: { query: rpc.detail },
      syncCollectionDetails: { mutate: rpc.sync },
    },
  },
}));

const item = {
  cid: 'cid-fixture',
  kind: 'text',
  type: 1,
  createTime: 1,
  collectTime: 1,
  authorName: '合成作者',
  authorUin: '10001',
  groupName: '',
  text: '本地收藏的命中正文',
  contentStatus: 'cached',
  fullContent: '本地收藏的完整正文',
  fullContentFormat: 'text',
  link: null,
  gallery: null,
  audio: null,
  video: null,
  file: null,
  location: null,
  richMedia: null,
};

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    root,
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function captureLayout(host: HTMLElement, name = 'collection-search') {
  const output = process.env.WEQ_COLLECTION_LAYOUT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  const styles = [
    'collection-search.css',
    'search-scope.css',
    'workspace-tools.css',
    'workspace-surfaces.css',
    'page-chrome.css',
    'index.css',
  ]
    .map((name) => readFileSync(resolve('src/renderer/src/styles', name), 'utf8'))
    .join('\n');
  writeFileSync(
    resolve(output, `${name}.html`),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styles}</style><style>html,body{margin:0;font-family:system-ui}*,*::before,*::after{box-sizing:border-box}.weq-search-dropdown{position:relative;inset:auto;width:100%;max-height:100dvh}body{padding:8px;background:var(--weq-bg-surface);color:var(--weq-fg-primary)}main{width:min(720px,100%);margin:auto}</style><body><main>${host.innerHTML}</main></body></html>`,
  );
}
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('收藏全局搜索定位', () => {
  it.each([false, true])('标题栏布局不受全局样式后加载影响（全局后加载：%s）', (globalLast) => {
    const styles = ['index.css', 'collection-search.css'];
    if (globalLast) styles.reverse();
    const sheet = document.createElement('style');
    sheet.textContent = styles
      .map((name) => readFileSync(resolve('src/renderer/src/styles', name), 'utf8'))
      .join('\n');
    document.head.append(sheet);
    const f = mount();
    try {
      act(() =>
        f.root.render(
          createElement(CollectionDialog, { open: true, embedded: true, onClose: vi.fn() }),
        ),
      );
      const header = f.host.querySelector<HTMLElement>('.weq-collection-head')!;
      const search = f.host.querySelector<HTMLElement>('.weq-collection-search')!;
      expect(getComputedStyle(header).flexDirection).toBe('row');
      expect(getComputedStyle(search).maxWidth).toBe('none');
    } finally {
      f.close();
      sheet.remove();
    }
  });

  it('列表搜索与标题共用顶部栏，清空按钮可重置关键词', async () => {
    const f = mount();
    try {
      await act(async () =>
        f.root.render(
          createElement(
            'div',
            { className: 'weq-workspace-content' },
            createElement(CollectionDialog, { open: true, embedded: true, onClose: vi.fn() }),
          ),
        ),
      );
      const input = f.host.querySelector<HTMLInputElement>('[aria-label="搜索收藏"]')!;
      expect(input.parentElement?.parentElement).toBe(f.host.querySelector('.weq-collection-head'));
      captureLayout(f.host, 'collection-header');
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          '合成',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(input.value).toBe('合成');
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="清空搜索"]')!.click());
      expect(input.value).toBe('');
    } finally {
      f.close();
    }
  });

  it('收藏来源失败时仍显示助手命中，失败只出现在对应分组并可重试', () => {
    const f = mount();
    const retry = vi.fn();
    try {
      act(() =>
        f.root.render(
          createElement(SearchDropdown, {
            keyword: '合成',
            quick: null,
            quickLoading: false,
            slowLoading: false,
            slow: {
              collections: [],
              chatRecords: [],
              files: [],
              cloneMessages: [],
              assistantMessages: [
                {
                  category: 'assistantMessage',
                  kind: 'assistant',
                  ownerId: 'assistant',
                  sessionId: 's',
                  messageId: 'm',
                  title: 'WeQ 助手',
                  sessionTitle: '合成会话',
                  content: '保留的合成结果',
                  ts: 1,
                },
              ],
              failedCategories: ['collection'],
              indexStatus: 'disabled',
            },
            categories: ['collection', 'assistantMessage'],
            onCategoriesChange: vi.fn(),
            onSelect: vi.fn(),
            onMore: vi.fn(),
            onRetry: retry,
          }),
        ),
      );
      expect(f.host.querySelectorAll('.weq-search-failure')).toHaveLength(1);
      expect(f.host.textContent).toContain('保留的合成结果');
      captureLayout(f.host);
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="重试收藏搜索"]')!.click());
      expect(retry).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });
  it('搜索结果带独立收藏类别与精确 CID，不伪装为聊天文件', () => {
    const f = mount();
    const select = vi.fn();
    const hit = {
      category: 'collection' as const,
      cid: item.cid,
      kind: 'text' as const,
      title: item.text,
      content: item.text,
      sourceName: item.authorName,
      collectTime: 1,
    };
    try {
      act(() =>
        f.root.render(
          createElement(SearchDropdown, {
            keyword: '命中',
            quick: null,
            quickLoading: false,
            slowLoading: false,
            slow: {
              collections: [hit],
              chatRecords: [],
              files: [],
              cloneMessages: [],
              assistantMessages: [],
              indexStatus: 'disabled',
            },
            categories: ['collection'],
            onCategoriesChange: vi.fn(),
            onSelect: select,
            onMore: vi.fn(),
          }),
        ),
      );
      expect(f.host.querySelector('.weq-search-section-name')?.textContent).toBe('收藏');
      captureLayout(f.host, 'collection-search-result');
      act(() => f.host.querySelector<HTMLButtonElement>('.weq-search-row')!.click());
      expect(select).toHaveBeenCalledWith(hit);
    } finally {
      f.close();
    }
  });

  it('未加载到列表的本地缓存项也能直接打开详情，已缓存正文不重新在线抓取', async () => {
    rpc.item.mockResolvedValue(item);
    rpc.detail.mockResolvedValue(null);
    const f = mount();
    try {
      await act(async () =>
        f.root.render(
          createElement(CollectionDialog, {
            open: true,
            embedded: true,
            onClose: vi.fn(),
            searchTarget: { cid: item.cid, revision: 1 },
          }),
        ),
      );
      expect(f.host.textContent).toContain('收藏详情');
      expect(f.host.textContent).toContain(item.fullContent);
      expect(rpc.item).toHaveBeenCalledWith({ cid: item.cid });
      expect(rpc.sync).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('读取失败可重试，明确处理已消失的收藏，不停留在加载状态', async () => {
    rpc.item.mockRejectedValueOnce(new Error('合成失败')).mockResolvedValueOnce(null);
    const f = mount();
    try {
      await act(async () =>
        f.root.render(
          createElement(CollectionDialog, {
            open: true,
            embedded: true,
            onClose: vi.fn(),
            searchTarget: { cid: item.cid, revision: 2 },
          }),
        ),
      );
      expect(f.host.textContent).toContain('读取收藏失败');
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="重试定位收藏"]')!.click(),
      );
      expect(f.host.textContent).toContain('这条收藏已不在当前账号的本地缓存中');
      expect(f.host.textContent).not.toContain('正在定位收藏');
    } finally {
      f.close();
    }
  });

  it('连续打开两条收藏时丢弃先前的晚到响应', async () => {
    let resolve!: (value: typeof item) => void;
    rpc.item
      .mockReturnValueOnce(
        new Promise<typeof item>((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValueOnce({ ...item, cid: 'second', fullContent: '第二条正文' });
    rpc.detail.mockResolvedValue(null);
    const f = mount();
    const render = (cid: string, revision: number) =>
      act(() =>
        f.root.render(
          createElement(CollectionDialog, {
            open: true,
            embedded: true,
            onClose: vi.fn(),
            searchTarget: { cid, revision },
          }),
        ),
      );
    try {
      render(item.cid, 1);
      await act(async () => {
        render('second', 2);
      });
      await act(async () => {
        resolve(item);
      });
      expect(f.host.textContent).toContain('第二条正文');
      expect(f.host.textContent).not.toContain(item.fullContent);
    } finally {
      f.close();
    }
  });
});
