import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const { save, invalidate } = vi.hoisted(() => ({ save: vi.fn(), invalidate: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      getSettings: { useQuery: () => ({ data: { qqShowCacheMinutes: 5, showChatQqShow: true } }) },
      setShowChatQqShow: { useMutation: () => ({ mutate: vi.fn() }) },
      setQqShowCacheMinutes: { useMutation: () => ({ mutateAsync: save, isLoading: false }) },
    },
    useUtils: () => ({ bootstrap: { getSettings: { invalidate } } }),
  },
}));
import { QqShowSettings } from '../src/renderer/src/components/settings/QqShowSettings';

afterEach(() => vi.unstubAllGlobals());

it('分钟设置默认显示 5，拒绝零分钟并保存新的分钟数', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(h(QqShowSettings)));
  try {
    const input = host.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(input.value).toBe('5');
    expect(input.getAttribute('aria-label')).toBe('QQ 秀缓存有效期（分钟）');
    expect(host.querySelector('button[aria-label="保存 QQ 秀缓存有效期"]')).toBeNull();
    const setValue = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    setValue('0');
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(save).not.toHaveBeenCalled();
    setValue('3');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(save).toHaveBeenCalledWith({ minutes: 3 });
    expect(invalidate).toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
