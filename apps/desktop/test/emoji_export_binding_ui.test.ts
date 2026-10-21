import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExportSavePolicy } from '@weq/service';
import { EmojiPackExportPane } from '../src/renderer/src/views/export/EmojiPackExportPane';
const state = vi.hoisted(() => ({
  start: vi.fn(async (_input: unknown) => 'task-a'),
  favorite: vi.fn(async (_input: unknown) => 'favorite-task'),
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      emojiPack: {
        summary: {
          useQuery: () => ({
            data: {
              own: {
                scope: 'own',
                total: 1,
                withOri: 1,
                thumbOnly: 0,
                downloadable: 0,
                missing: 0,
                sample: [],
              },
              received: {
                scope: 'received',
                total: 1,
                withOri: 1,
                thumbOnly: 0,
                downloadable: 0,
                missing: 0,
                sample: [],
              },
            },
            isLoading: false,
          }),
        },
      },
    },
  },
  client: {
    account: {
      emojiPack: { startExport: { mutate: state.start } },
      qqActions: { favoriteExport: { mutate: state.favorite } },
    },
  },
}));
afterEach(() => {
  state.start.mockClear();
  state.favorite.mockClear();
  vi.unstubAllGlobals();
});

it.each(['zip', 'favorite-zip'] as const)(
  '导出工具的 %s 选择单文件 ZIP，收藏格式复用带元数据的导出',
  async (format) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
    const prepare = vi.fn(async () => ({ mode: 'after' as const }));
    try {
      act(() =>
        root.render(h(EmojiPackExportPane, { binding, prepareSave: prepare, onStarted: vi.fn() })),
      );
      act(() => {
        const select = host.querySelector<HTMLSelectElement>('[aria-label="表情包导出格式"]')!;
        select.value = format;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await act(async () => host.querySelector<HTMLButtonElement>('.weq-epk-start')!.click());
      expect(prepare).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ kind: 'file', format: 'zip' }),
      );
      if (format === 'favorite-zip') {
        expect(state.favorite).toHaveBeenCalledWith({ ...binding, savePolicy: { mode: 'after' } });
        expect(state.start).not.toHaveBeenCalled();
        expect(host.querySelector('[aria-label="收藏备份来源"]')).not.toBeNull();
      } else {
        expect(state.start).toHaveBeenCalledWith(
          expect.objectContaining({ ...binding, format: 'zip' }),
        );
        expect(state.favorite).not.toHaveBeenCalled();
      }
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
it.each([false, true])('表情导出固定点击时的来源，准备后来源失效则不提交：%s', async (changed) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
  let current = true,
    finish!: (policy: ExportSavePolicy) => void;
  const prepare = vi.fn(
    () =>
      new Promise<ExportSavePolicy>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    act(() =>
      root.render(
        h(EmojiPackExportPane, {
          onStarted: vi.fn(),
          prepareSave: prepare,
          binding,
          isCurrent: () => current,
        }),
      ),
    );
    act(() => host.querySelector<HTMLButtonElement>('.weq-epk-start')!.click());
    expect(prepare).toHaveBeenCalledOnce();
    binding.expectedAccountConfigId = 'source-b';
    current = !changed;
    await act(async () => finish({ mode: 'after' }));
    if (changed) expect(state.start).not.toHaveBeenCalled();
    else
      expect(state.start).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedAccountConfigId: 'source-a',
          expectedAccountUin: '10001',
        }),
      );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
