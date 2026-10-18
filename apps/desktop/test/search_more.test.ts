import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnifiedSearchModal } from '../src/renderer/src/components/search/UnifiedSearchModal';
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

function mount() {
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
