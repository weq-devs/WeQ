import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypingStatus } from '../src/renderer/src/components/qq-actions/ChatActions';

const session = vi.hoisted(() => ({
  available: true,
  busy: false,
  binding: { expectedAccountUin: '10000', expectedAccountConfigId: 'test' },
  result: null,
  run: vi.fn(),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => session,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({ client: {}, trpc: {} }));

afterEach(() => {
  session.available = true;
  vi.unstubAllGlobals();
});

describe('正在输入状态工具栏按钮', () => {
  it('默认关闭，点击切换高亮状态，切换好友后恢复关闭', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    const editors = [createRef<HTMLDivElement>()];
    try {
      await act(async () => root.render(createElement(TypingStatus, { uid: 'u_one', editors })));
      const button = host.querySelector('button')!;
      expect(button.classList.contains('composer-tool')).toBe(true);
      expect(button.getAttribute('aria-label')).toBe('发送正在输入状态');
      expect(button.getAttribute('aria-pressed')).toBe('false');
      expect(host.querySelector('input[type="checkbox"]')).toBeNull();
      act(() => button.click());
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(button.title).toContain('已开启');
      act(() => button.click());
      expect(button.getAttribute('aria-pressed')).toBe('false');
      act(() => button.click());
      await act(async () => root.render(createElement(TypingStatus, { uid: 'u_two', editors })));
      expect(button.getAttribute('aria-pressed')).toBe('false');
      session.available = false;
      await act(async () => root.render(createElement(TypingStatus, { uid: 'u_two', editors })));
      expect(button.disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });
});
