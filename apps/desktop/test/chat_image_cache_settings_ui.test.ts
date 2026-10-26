import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHAT_IMAGE_CACHE_MIB,
  MAX_CHAT_IMAGE_CACHE_MIB,
} from '@weq/service/chat-image-cache';
import { ChatImageCacheSettings } from '../src/renderer/src/components/settings/ChatImageCacheSettings';

const fixture = vi.hoisted(() => ({
  value: 128,
  pending: false,
  missing: false,
  save: vi.fn(),
  setData: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      getSettings: {
        useQuery: () => ({
          data: fixture.missing ? undefined : { chatImageCacheMiB: fixture.value },
          isError: false,
        }),
      },
      setChatImageCacheMiB: {
        useMutation: () => ({ mutateAsync: fixture.save, isLoading: fixture.pending }),
      },
    },
    useUtils: () => ({
      bootstrap: { getSettings: { setData: fixture.setData, invalidate: fixture.invalidate } },
    }),
  },
}));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  fixture.value = DEFAULT_CHAT_IMAGE_CACHE_MIB;
  fixture.pending = false;
  fixture.missing = false;
  fixture.save.mockImplementation(async ({ miB }: { miB: number }) => miB);
  fixture.setData.mockImplementation(
    (_input, updater: (data: { chatImageCacheMiB: number }) => { chatImageCacheMiB: number }) => {
      fixture.value = updater({ chatImageCacheMiB: fixture.value }).chatImageCacheMiB;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

it('预算控件支持保存零值、共享设置立即更新，失败可重试，非法值和在途时禁用保存', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = () => act(() => root.render(h(ChatImageCacheSettings)));
  const input = () => host.querySelector('input')!;
  const button = () => host.querySelector('button')!;
  const change = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input(),
        value,
      );
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  const submit = () =>
    act(async () => {
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  try {
    render();
    expect(input().value).toBe(String(DEFAULT_CHAT_IMAGE_CACHE_MIB));
    expect(button().disabled).toBe(true);
    change('0');
    await submit();
    expect(fixture.save).toHaveBeenLastCalledWith({ miB: 0 });
    expect(fixture.value).toBe(0);
    expect(fixture.invalidate).toHaveBeenCalledOnce();
    render();
    change('256');
    fixture.save.mockRejectedValueOnce(new Error('保存失败'));
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('保存失败');
    expect(fixture.value).toBe(0);
    await submit();
    expect(fixture.value).toBe(256);
    for (const invalid of ['', '-1', '1.5', String(MAX_CHAT_IMAGE_CACHE_MIB + 1)]) {
      change(invalid);
      expect(button().disabled).toBe(true);
    }
    change('128');
    fixture.pending = true;
    render();
    expect(input().disabled).toBe(true);
    fixture.pending = false;
    fixture.missing = true;
    render();
    expect(input().disabled).toBe(true);
  } finally {
    act(() => root.unmount());
  }
});
