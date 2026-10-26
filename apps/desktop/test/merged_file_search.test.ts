import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import { UnifiedSearchModal } from '../src/renderer/src/components/search/UnifiedSearchModal';
import type {
  ContentSearchHit,
  SearchCategory,
  SlowSearchResult,
} from '../src/renderer/src/components/search/types';

const rpc = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { searchMore: { query: rpc.query } } },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => children,
}));

const directory: ContentSearchHit = {
  category: 'groupFile',
  id: 'cached',
  target: { kind: 'groupFile', groupCode: '10001', folderId: '/nested', fileId: 'target' },
  title: '报告',
  content: '合成上传者',
  sourceName: '合成群 · 目录',
  time: 10,
  observedAt: 10,
};
const message = {
  category: 'file' as const,
  source: 'group' as const,
  partition: '10001',
  targetUid: '10001',
  targetUin: '0',
  fileName: '报告-附件',
  msgId: '1',
  msgSeq: '20',
  sendTime: '30',
  convName: '合成群',
};
const slow: SlowSearchResult = {
  files: [message],
  contentHits: [directory],
  contentCoverage: {
    groupFile: { scope: 'observed-cache', records: 1, limited: false, updatedAt: 10 },
  },
  collections: [],
  chatRecords: [],
  cloneMessages: [],
  assistantMessages: [],
  indexStatus: 'disabled',
};

function mount(element: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('仅一个文件范围及结果组，混合排序后保留两种原始跳转身份', () => {
  const select = vi.fn();
  const change = vi.fn();
  function Harness() {
    const [categories, setCategories] = useState<SearchCategory[]>(['file']);
    return createElement(SearchDropdown, {
      keyword: '报告',
      categories,
      onCategoriesChange: (next) => {
        change(next);
        setCategories(next);
      },
      quick: null,
      quickLoading: false,
      slow,
      slowLoading: false,
      onSelect: select,
      onMore: vi.fn(),
    });
  }
  const f = mount(createElement(Harness));
  try {
    const buttons = [...f.host.querySelectorAll<HTMLButtonElement>('.weq-search-scope button')];
    expect(buttons.filter((button) => button.textContent === '文件')).toHaveLength(1);
    expect(buttons.some((button) => button.textContent === '群文件')).toBe(false);
    expect(
      [...f.host.querySelectorAll('.weq-search-section-name')].map((node) => node.textContent),
    ).toEqual(['文件']);
    expect(f.host.textContent).toContain('群文件目录 · 已缓存内容 · 1 条');
    const rows = f.host.querySelectorAll<HTMLButtonElement>('[role="option"]');
    expect(rows).toHaveLength(2);
    act(() => rows[0]!.click());
    act(() => rows[1]!.click());
    expect(select.mock.calls.map(([hit]) => hit)).toEqual([directory, message]);
    act(() => buttons.find((button) => button.textContent === '文件')!.click());
    expect(change).toHaveBeenLastCalledWith([]);
    expect(f.host.querySelector('[role="option"]')).toBeNull();
    act(() => buttons.find((button) => button.textContent === '文件')!.click());
    expect(change).toHaveBeenLastCalledWith(['file']);
  } finally {
    f.close();
  }
});

it('一个文件来源失败时仍展示另一来源和重试入口', () => {
  const f = mount(
    createElement(SearchDropdown, {
      keyword: '报告',
      categories: ['file'],
      onCategoriesChange: vi.fn(),
      quick: null,
      quickLoading: false,
      slow: { ...slow, contentHits: [], failedCategories: ['groupFile'] },
      slowLoading: false,
      onSelect: vi.fn(),
      onMore: vi.fn(),
    }),
  );
  try {
    expect(f.host.querySelector('[aria-label="重试文件搜索"]')).not.toBeNull();
    expect(f.host.querySelector('[role="option"]')?.textContent).toContain('报告-附件');
  } finally {
    f.close();
  }
});

it('文件更多页承接混合结果，选中目录文件时保留分页返回现场', async () => {
  vi.useFakeTimers();
  rpc.query.mockResolvedValueOnce({
    category: 'file',
    items: [directory, message],
    total: 2,
    hasMore: false,
  });
  const select = vi.fn();
  const navigate = vi.fn();
  const f = mount(
    createElement(UnifiedSearchModal, {
      category: 'file',
      initialKeyword: '报告',
      onClose: vi.fn(),
      onSelect: select,
      onOpenChatRecords: vi.fn(),
      onNavigate: navigate,
    }),
  );
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(rpc.query).toHaveBeenCalledWith({
      category: 'file',
      keyword: '报告',
      offset: 0,
      limit: 30,
    });
    act(() => f.host.querySelector<HTMLButtonElement>('[role="option"]')!.click());
    expect(select).toHaveBeenCalledWith(directory);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'file', nextOffset: 2, focusKey: directory.id }),
    );
  } finally {
    f.close();
  }
});
