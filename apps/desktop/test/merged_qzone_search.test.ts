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
const hits: ContentSearchHit[] = [
  {
    category: 'qzonePost',
    id: 'own-post',
    target: { kind: 'qzonePost', uin: '10001', tid: 'same' },
    title: 'needle',
    content: '自己的说说',
    sourceName: '空间 10001',
    time: 10,
    observedAt: 1,
  },
  {
    category: 'otherQzonePost',
    id: 'other-post',
    target: { kind: 'qzonePost', uin: '10002', tid: 'same' },
    title: 'needle',
    content: '他人的说说',
    sourceName: '空间 10002',
    time: 30,
    observedAt: 1,
  },
  {
    category: 'qzoneAlbum',
    id: 'own-album',
    target: { kind: 'qzoneAlbum', uin: '10001', albumId: 'same' },
    title: 'needle',
    content: '自己的相册',
    sourceName: '空间 10001',
    time: 20,
    observedAt: 1,
  },
  {
    category: 'otherQzoneAlbum',
    id: 'other-album',
    target: { kind: 'qzoneAlbum', uin: '10002', albumId: 'same' },
    title: 'needle',
    content: '他人的相册',
    sourceName: '空间 10002',
    time: 40,
    observedAt: 1,
  },
];
const slow: SlowSearchResult = {
  contentHits: hits,
  contentCoverage: Object.fromEntries(
    hits.map((hit) => [
      hit.category,
      { scope: 'observed-cache', records: 1, limited: hit.id === 'own-post', updatedAt: 1 },
    ]),
  ),
  files: [],
  chatRecords: [],
  collections: [],
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

it('空间只有一个范围和结果组，统一预览、缓存覆盖及更多入口', () => {
  const select = vi.fn(),
    more = vi.fn(),
    change = vi.fn();
  function Harness() {
    const [categories, setCategories] = useState<SearchCategory[]>(['qzone']);
    return createElement(SearchDropdown, {
      keyword: 'needle',
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
      onMore: more,
    });
  }
  const f = mount(createElement(Harness));
  try {
    const buttons = [...f.host.querySelectorAll<HTMLButtonElement>('.weq-search-scope button')];
    expect(buttons.filter((button) => button.textContent === '空间')).toHaveLength(1);
    expect(buttons.some((button) => ['个人空间', '他人空间'].includes(button.textContent!))).toBe(
      false,
    );
    expect(
      [...f.host.querySelectorAll('.weq-search-section-name')].map((node) => node.textContent),
    ).toEqual(['空间']);
    expect(f.host.textContent).toContain('已缓存内容 · 4 条 · 缓存有回收或截断');
    const rows = f.host.querySelectorAll<HTMLButtonElement>('[role="option"]');
    expect(rows).toHaveLength(3);
    for (const row of rows) act(() => row.click());
    expect(select.mock.calls.map(([hit]) => hit)).toEqual([hits[3], hits[1], hits[2]]);
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-search-more')!.click());
    expect(more).toHaveBeenCalledWith('qzone');
    act(() => buttons.find((button) => button.textContent === '空间')!.click());
    expect(change).toHaveBeenLastCalledWith([]);
    act(() => buttons.find((button) => button.textContent === '空间')!.click());
    expect(change).toHaveBeenLastCalledWith(['qzone']);
  } finally {
    f.close();
  }
});

it('空间部分来源失败显示统一重试入口并保留有效命中', () => {
  const f = mount(
    createElement(SearchDropdown, {
      keyword: 'needle',
      categories: ['qzone'],
      onCategoriesChange: vi.fn(),
      quick: null,
      quickLoading: false,
      slow: { ...slow, failedCategories: ['otherQzoneAlbum'], contentHits: hits.slice(0, 3) },
      slowLoading: false,
      onSelect: vi.fn(),
      onMore: vi.fn(),
    }),
  );
  try {
    expect(f.host.querySelector('[aria-label="重试空间搜索"]')).not.toBeNull();
    expect(f.host.querySelectorAll('[role="option"]')).toHaveLength(3);
  } finally {
    f.close();
  }
});

it('空间更多页保留作者和相册目标及分页返回现场', async () => {
  vi.useFakeTimers();
  rpc.query.mockResolvedValue({ category: 'qzone', items: hits, total: 4, hasMore: false });
  const select = vi.fn(),
    navigate = vi.fn();
  const f = mount(
    createElement(UnifiedSearchModal, {
      category: 'qzone',
      initialKeyword: 'needle',
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
      category: 'qzone',
      keyword: 'needle',
      offset: 0,
      limit: 30,
    });
    act(() => f.host.querySelectorAll<HTMLButtonElement>('[role="option"]')[3]!.click());
    expect(select).toHaveBeenCalledWith(hits[3]);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'qzone', nextOffset: 4, focusKey: 'other-album' }),
    );
  } finally {
    f.close();
  }
});
