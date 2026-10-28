import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MAX_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES } from '@weq/service/qzone-public-settings';
import { QzonePublicRefreshSettings } from '../src/renderer/src/components/settings/QzonePublicRefreshSettings';

const state = vi.hoisted(() => ({
  saved: 60,
  save: vi.fn(async (_input: { minutes: number }) => {}),
  refetch: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      getSettings: {
        useQuery: () => ({
          data: { qzonePublicRefreshCooldownMinutes: state.saved },
          refetch: state.refetch,
        }),
      },
      setQzonePublicRefreshCooldown: {
        useMutation: () => ({ mutateAsync: state.save, isLoading: false }),
      },
    },
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('冷却分钟数显式保存，非法输入禁用保存，0 分钟可以提交', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(h(QzonePublicRefreshSettings)));
    const input = host.querySelector('input')!;
    const button = host.querySelector('button')!;
    expect(input.value).toBe(String(state.saved));
    const change = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    for (const invalid of [
      '',
      '-1',
      '1.5',
      String(MAX_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES + 1),
    ]) {
      change(invalid);
      expect(button.disabled).toBe(true);
    }
    change('30');
    expect(state.save).not.toHaveBeenCalled();
    await act(async () => button.click());
    expect(state.save).toHaveBeenLastCalledWith({ minutes: 30 });
    expect(state.refetch).toHaveBeenCalledOnce();
    change('0');
    await act(async () => button.click());
    expect(state.save).toHaveBeenLastCalledWith({ minutes: 0 });
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
