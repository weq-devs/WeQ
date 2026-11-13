import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmptyState } from '../src/renderer/src/components/EmptyState';
import { State } from '../src/renderer/src/views/qzoneShared';

vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

describe('分场景空状态', () => {
  it('提供三种密度，兼容已有紧凑调用，不为缺少的说明占位', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      for (const [props, variant] of [
        [{}, 'panel'],
        [{ compact: true }, 'compact'],
        [{ variant: 'inline' as const }, 'inline'],
      ] as const) {
        act(() => root.render(h(EmptyState, { title: '暂无内容', ...props })));
        expect(host.firstElementChild?.classList.contains(`is-${variant}`)).toBe(true);
        expect(host.querySelector('.weq-empty-state-icon')?.getAttribute('aria-hidden')).toBe(
          'true',
        );
        expect(host.querySelectorAll('svg')).toHaveLength(1);
        expect(host.querySelector('.weq-empty-state-body')).toBeNull();
      }
    } finally {
      act(() => root.unmount());
    }
  });

  it('保留说明中的操作与状态语义', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const restore = vi.fn();
    try {
      act(() =>
        root.render(
          h(EmptyState, {
            title: '未选择搜索范围',
            role: 'status',
            body: h('button', { onClick: restore }, '恢复全部范围'),
          }),
        ),
      );
      expect(host.firstElementChild?.getAttribute('role')).toBe('status');
      act(() => host.querySelector('button')!.click());
      expect(restore).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
    }
  });

  it('空间空态只在读取完成且无错误时出现，不覆盖加载、失败或重试', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const retry = vi.fn();
    const render = (loading: boolean, error: string) =>
      act(() =>
        root.render(
          h(State, {
            loading,
            error,
            empty: '暂无说说',
            progress: '已读 1 页',
            retry,
          }),
        ),
      );
    try {
      render(true, '');
      expect(host.querySelector('.weq-empty-state')).toBeNull();
      expect(host.textContent).toContain('正在加载');
      render(false, '合成读取失败');
      expect(host.querySelector('.weq-empty-state')).toBeNull();
      expect(host.textContent).toContain('合成读取失败');
      act(() => host.querySelector('button')!.click());
      expect(retry).toHaveBeenCalledOnce();
      render(false, '');
      expect(host.querySelectorAll('.weq-empty-state')).toHaveLength(1);
      expect(host.textContent).toContain('暂无说说');
      expect(host.textContent).toContain('已读 1 页');
    } finally {
      act(() => root.unmount());
    }
  });
});
