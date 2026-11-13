import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { OcrPrefilterSetting } from '../src/renderer/src/components/settings/OcrPrefilterSetting';

const mocks = vi.hoisted(() => ({
  enabled: true,
  save: vi.fn(async (_input: unknown) => undefined),
  invalidate: vi.fn(async () => undefined),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ bootstrap: { getSettings: { invalidate: mocks.invalidate } } }),
    bootstrap: {
      getSettings: {
        useQuery: () => ({ data: { ocr: { prefilterEnabled: mocks.enabled } } }),
      },
      setOcrPrefilterEnabled: {
        useMutation: () => ({ mutateAsync: mocks.save, isLoading: false }),
      },
    },
  },
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])('筛图开关显示全局值 %s，保存后刷新；失败保留原值', async (enabled) => {
  mocks.enabled = enabled;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(h(OcrPrefilterSetting)));
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe(String(enabled));
    await act(async () => toggle.click());
    expect(mocks.save).toHaveBeenCalledWith({ enabled: !enabled });
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    mocks.save.mockRejectedValueOnce(new Error('保存失败'));
    await act(async () => toggle.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('保存失败');
    expect(toggle.getAttribute('aria-checked')).toBe(String(enabled));
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
