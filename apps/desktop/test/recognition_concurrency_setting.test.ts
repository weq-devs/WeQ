import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RecognitionConcurrencySetting } from '../src/renderer/src/components/settings/RecognitionConcurrencySetting';

const mocks = vi.hoisted(() => ({
  save: vi.fn(async (_input: unknown) => undefined),
  invalidate: vi.fn(async () => undefined),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ bootstrap: { getSettings: { invalidate: mocks.invalidate } } }),
    bootstrap: {
      getSettings: {
        useQuery: () => ({
          data: { ocr: { onlineConcurrency: 8 }, voiceTranscribe: { onlineConcurrency: 3 } },
        }),
      },
      setRecognitionConcurrency: { useMutation: () => ({ mutateAsync: mocks.save }) },
    },
  },
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each(['ocr', 'voice'] as const)('设置页保存 %s 并发，支持连续输入并还原无效值', async (kind) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(h(RecognitionConcurrencySetting, { kind })));
    const input = host.querySelector('input')!;
    expect(input.value).toBe(kind === 'ocr' ? '8' : '3');
    const change = async (value: string) => {
      await act(async () => {
        input.focus();
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(mocks.save).not.toHaveBeenCalled();
        input.blur();
      });
    };
    await change('0');
    expect(input.value).toBe(kind === 'ocr' ? '8' : '3');
    expect(mocks.save).not.toHaveBeenCalled();
    await change('12');
    expect(mocks.save).toHaveBeenCalledWith({ kind, concurrency: 12 });
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
