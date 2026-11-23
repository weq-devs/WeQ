import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHAT_IMAGE_CACHE_MIB,
  MAX_CHAT_IMAGE_CACHE_MIB,
} from '@weq/service/chat-image-cache';
import {
  ChatImageCacheSettings,
  ChatMessagePrewarmSettings,
} from '../src/renderer/src/components/settings/ChatImageCacheSettings';

const fixture = vi.hoisted(() => ({
  value: 128,
  prewarm: 128,
  pending: false,
  missing: false,
  save: vi.fn(),
  savePrewarm: vi.fn(),
  setData: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      getSettings: {
        useQuery: () => ({
          data: fixture.missing
            ? undefined
            : { chatImageCacheMiB: fixture.value, chatMessagePrewarmMiB: fixture.prewarm },
          isError: false,
        }),
      },
      setChatImageCacheMiB: {
        useMutation: () => ({ mutateAsync: fixture.save, isLoading: fixture.pending }),
      },
      setChatMessagePrewarmMiB: {
        useMutation: () => ({ mutateAsync: fixture.savePrewarm }),
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
  fixture.prewarm = 128;
  fixture.pending = false;
  fixture.missing = false;
  fixture.save.mockImplementation(async ({ miB }: { miB: number }) => miB);
  fixture.savePrewarm.mockImplementation(async ({ miB }: { miB: number }) => miB);
  fixture.setData.mockImplementation(
    (
      _input,
      updater: (data: { chatImageCacheMiB: number; chatMessagePrewarmMiB: number }) => {
        chatImageCacheMiB: number;
        chatMessagePrewarmMiB: number;
      },
    ) => {
      const updates = updater({
        chatImageCacheMiB: fixture.value,
        chatMessagePrewarmMiB: fixture.prewarm,
      });
      fixture.value = updates.chatImageCacheMiB;
      fixture.prewarm = updates.chatMessagePrewarmMiB;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

it('完整消息预算可以关闭额外预热，并只更新自己的偏好', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(h(ChatMessagePrewarmSettings)));
    const input = host.querySelector('input')!;
    expect(input.value).toBe('128');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '0');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(fixture.savePrewarm).toHaveBeenCalledWith({ miB: 0 });
    expect(fixture.prewarm).toBe(0);
    expect(fixture.value).toBe(DEFAULT_CHAT_IMAGE_CACHE_MIB);
    expect(fixture.save).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});

it('预算自动保存零值、共享设置立即更新，失败可重试，保存期间仍可编辑', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = () => act(() => root.render(h(ChatImageCacheSettings)));
  const input = () => host.querySelector('input')!;
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
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  try {
    render();
    expect(input().value).toBe(String(DEFAULT_CHAT_IMAGE_CACHE_MIB));
    expect(host.querySelector('button')).toBeNull();
    change('0');
    await submit();
    expect(fixture.save).toHaveBeenLastCalledWith({ miB: 0 });
    expect(fixture.value).toBe(0);
    expect(fixture.invalidate).toHaveBeenCalledOnce();
    render();
    change('256');
    fixture.save.mockRejectedValueOnce(new Error('保存失败'));
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('保存失败');
    expect(fixture.value).toBe(0);
    await submit();
    expect(fixture.value).toBe(256);
    for (const invalid of ['', '-1', '1.5', String(MAX_CHAT_IMAGE_CACHE_MIB + 1)]) {
      change(invalid);
      const before = fixture.save.mock.calls.length;
      await submit();
      expect(fixture.save).toHaveBeenCalledTimes(before);
    }
    change('128');
    fixture.pending = true;
    render();
    expect(input().disabled).toBe(false);
    fixture.pending = false;
    fixture.missing = true;
    render();
    expect(input().disabled).toBe(true);
  } finally {
    act(() => root.unmount());
  }
});
