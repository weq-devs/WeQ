import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UnifiedSearchModal,
  type SearchMoreSnapshot,
} from '../src/renderer/src/components/search/UnifiedSearchModal';
import type { MoreSearchResult } from '../src/renderer/src/components/search/types';

const rpc = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { searchMore: { query: rpc.query } } },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => children,
}));

function page(name: string, hasMore = false): MoreSearchResult {
  return {
    category: 'friend',
    items: [{ category: 'friend', uid: name, uin: '', nick: name, remark: '', avatarUrl: null }],
    total: hasMore ? 2 : 1,
    hasMore,
  };
}

function mount(
  options: {
    initialSnapshot?: SearchMoreSnapshot;
    onNavigate?: (snapshot: SearchMoreSnapshot) => void;
  } = {},
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(UnifiedSearchModal, {
        category: 'friend',
        initialKeyword: '旧词',
        onClose: vi.fn(),
        onSelect: vi.fn(),
        onOpenChatRecords: vi.fn(),
        ...options,
      }),
    ),
  );
  return {
    host,
    change(value: string) {
      const input = host.querySelector('input')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
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

describe('搜索更多的请求隔离', () => {
  it('返回恢复修改后的词、已加载结果、原始游标、滚动与命中焦点，不重取第一页', async () => {
    vi.useFakeTimers();
    rpc.query
      .mockResolvedValueOnce(page('a', true))
      .mockResolvedValueOnce({ ...page('b', true), total: 3 });
    let snapshot: SearchMoreSnapshot | undefined;
    const first = mount({
      onNavigate: (value) => {
        snapshot = value;
      },
    });
    try {
      first.change('调整后的词');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      await act(async () =>
        first.host.querySelector('.weq-search-more-body')!.dispatchEvent(new Event('scroll')),
      );
      first.host.querySelector('.weq-search-more-body')!.scrollTop = 184;
      act(() => first.host.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]!.click());
      expect(snapshot?.keyword).toBe('调整后的词');
      expect(snapshot?.nextOffset).toBe(2);
    } finally {
      first.close();
    }
    const restored = mount({ initialSnapshot: snapshot });
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(rpc.query).toHaveBeenCalledTimes(2);
      expect(restored.host.querySelector('input')!.value).toBe('调整后的词');
      expect(restored.host.querySelector('.weq-search-more-body')!.scrollTop).toBe(184);
      expect(document.activeElement?.textContent).toContain('b');
      rpc.query.mockResolvedValueOnce({ ...page('c'), total: 3 });
      await act(async () =>
        restored.host.querySelector('.weq-search-more-body')!.dispatchEvent(new Event('scroll')),
      );
      expect(rpc.query.mock.calls[2]?.[0]).toMatchObject({ keyword: '调整后的词', offset: 2 });
      expect(restored.host.querySelectorAll('[role="option"]')).toHaveLength(3);
    } finally {
      restored.close();
    }
  });
  it('来源更新后的重复项只显示一次，分页游标仍按服务端原始条数前进', async () => {
    vi.useFakeTimers();
    rpc.query
      .mockResolvedValueOnce(page('a', true))
      .mockResolvedValueOnce({
        ...page('b', true),
        total: 4,
        items: [...page('a').items, ...page('b').items],
      })
      .mockResolvedValueOnce({ ...page('c'), total: 4 });
    const f = mount();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      await act(async () =>
        f.host.querySelector('.weq-search-more-body')!.dispatchEvent(new Event('scroll')),
      );
      expect(f.host.querySelectorAll('[role="option"]')).toHaveLength(2);
      expect(f.host.textContent).toContain('结果可能已更新');
      expect(f.host.querySelector('[aria-label="刷新搜索结果"]')).not.toBeNull();
      await act(async () =>
        f.host.querySelector('.weq-search-more-body')!.dispatchEvent(new Event('scroll')),
      );
      expect(rpc.query.mock.calls[2]?.[0].offset).toBe(3);
      expect(f.host.querySelectorAll('[role="option"]')).toHaveLength(3);
    } finally {
      f.close();
    }
  });
  it('换词后的防抖窗口内丢弃旧响应，清空后也不会重新出现旧结果', async () => {
    vi.useFakeTimers();
    let resolve!: (result: MoreSearchResult) => void;
    rpc.query.mockReturnValueOnce(
      new Promise<MoreSearchResult>((done) => {
        resolve = done;
      }),
    );
    const f = mount();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      f.change('新词');
      await act(async () => {
        resolve(page('旧结果'));
      });
      expect(f.host.textContent).not.toContain('旧结果');
      f.change('');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(f.host.textContent).not.toContain('旧结果');
      expect(rpc.query).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });

  it('查询失败显示可重试状态，分页失败保留已有结果', async () => {
    vi.useFakeTimers();
    rpc.query
      .mockRejectedValueOnce(new Error('合成失败'))
      .mockResolvedValueOnce(page('新结果', true));
    const f = mount();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(f.host.textContent).toContain('搜索失败');
      await act(async () => {
        f.host.querySelector<HTMLButtonElement>('[aria-label="重试搜索"]')!.click();
      });
      expect(f.host.textContent).toContain('新结果');
      rpc.query.mockRejectedValueOnce(new Error('合成分页失败'));
      await act(async () => {
        f.host.querySelector('.weq-search-more-body')!.dispatchEvent(new Event('scroll'));
      });
      expect(f.host.textContent).toContain('新结果');
      expect(f.host.textContent).toContain('加载更多失败');
    } finally {
      f.close();
    }
  });
});
