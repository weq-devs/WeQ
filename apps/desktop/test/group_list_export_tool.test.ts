import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportTool } from '../src/renderer/src/views/ExportView';
import type { LightboxResult } from '../src/renderer/src/views/export/ExportLightbox';
import { DEFAULT_OPTIONS } from '../src/renderer/src/views/export/types';
import { useViewState } from '../src/renderer/src/state/view';
import { describeExportOutput, type ExportOutputPlan, type ExportSavePolicy } from '@weq/service';
import { prepareExportDestination } from '../src/main/ipc/routers/export_save';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  start: vi.fn(async (_input: unknown) => 'task-a'),
  prepare: vi.fn(
    async (
      _intent?: ExportSavePolicy,
      _output?: ExportOutputPlan,
    ): Promise<ExportSavePolicy | null> => ({ mode: 'after' }),
  ),
  data: {} as Record<string, unknown>,
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    settings: { data: {} },
    policy: { mode: 'after' },
    prepareSave: state.prepare,
    isCurrent: () => true,
  }),
}));
vi.mock('../src/renderer/src/views/export/ExportLightbox', () => ({
  ExportLightbox: ({
    onConfirm,
    contactScope,
  }: {
    onConfirm: (result: LightboxResult) => void;
    contactScope: string;
  }) =>
    h(
      'button',
      {
        'aria-label': '确认名单导出',
        onClick: () =>
          onConfirm({
            formats: ['json'],
            options: {
              ...DEFAULT_OPTIONS,
              exportAvatar: contactScope === 'groups' ? false : DEFAULT_OPTIONS.exportAvatar,
            },
          }),
      },
      '确认名单导出',
    ),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  function proxy(path = ''): unknown {
    return new Proxy(() => {}, {
      get(_target, key) {
        const name = String(key);
        if (name === 'useUtils') return () => proxy('utils');
        if (name === 'invalidate') return async () => {};
        if (name === 'useQuery')
          return () => ({
            data: state.data[path] ?? [],
            isLoading: false,
            isError: false,
            refetch: async () => ({ data: state.data[path] ?? [] }),
          });
        if (name === 'subscribe') return () => ({ unsubscribe() {} });
        if (name === 'query') return async () => state.data[path] ?? [];
        if (name === 'mutate')
          return path === 'account.startContactsExport' ? state.start : async () => {};
        return proxy(path ? `${path}.${name}` : name);
      },
    });
  }
  return { trpc: proxy(), client: proxy() };
});
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useViewState.setState({ openedUin: '10001' });
  state.start.mockClear();
  state.prepare.mockReset().mockResolvedValue({ mode: 'after' });
  state.data = {
    'account.getAccountConfig': { uin: '10001', configId: 'source-a' },
    'account.exportGroupDirectory': [
      { groupCode: '123', groupName: '合成群一', memberCount: 2 },
      { groupCode: '456', groupName: '合成群二', memberCount: 3 },
    ],
  };
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});
async function mount(ids?: string[], container = 'group-list') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(
      h(ExportTool, {
        initialSelection: {
          owner: { kind: 'contacts', container },
          scope: ids === undefined ? { type: 'all' } : { type: 'items', ids },
        },
      }),
    ),
  );
  return host;
}
describe('群聊名单导出工具', () => {
  it.each([false, true])(
    '界面确认后的真实输出判断驱动文件／目录选择，多目标：%s',
    async (multiple) => {
      const root = mkdtempSync(join(tmpdir(), 'weq-output-picker-ui-'));
      const hostPicker = {
        pickSaveTarget: vi.fn(async () => ({
          path: join(root, '用户指定.json'),
          downloadId: null,
        })),
        pickDirectory: vi.fn(async () => root),
      };
      state.prepare.mockImplementation(async (intent, output) => {
        if (!output) throw new Error('缺少输出形态');
        return prepareExportDestination(
          intent ?? { mode: 'before' },
          null,
          hostPicker,
          describeExportOutput(output, {
            avatar: false,
            ocr: false,
            transcribe: false,
            dress: false,
          }),
        );
      });
      try {
        const host = await mount(
          multiple ? ['123', '456'] : undefined,
          multiple ? 'groups' : 'group-list',
        );
        act(() => host.querySelector<HTMLButtonElement>('[aria-label="本次保存选项"]')!.click());
        const choose = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
          (node) => node.textContent === '另存到…',
        )!;
        act(() => choose.click());
        await act(async () => {
          host.querySelector<HTMLButtonElement>('[aria-label="确认名单导出"]')!.click();
          await vi.waitFor(() => expect(state.start).toHaveBeenCalledTimes(multiple ? 2 : 1));
        });
        if (multiple) {
          expect(hostPicker.pickDirectory).toHaveBeenCalledOnce();
          expect(hostPicker.pickSaveTarget).not.toHaveBeenCalled();
          expect(state.start).toHaveBeenCalledTimes(2);
          for (const [input] of state.start.mock.calls)
            expect(input).toMatchObject({ savePolicy: { mode: 'before', directory: root } });
        } else {
          expect(hostPicker.pickSaveTarget).toHaveBeenCalledWith({
            defaultName: '全部群聊名单.json',
            extension: 'json',
          });
          expect(hostPicker.pickDirectory).not.toHaveBeenCalled();
          expect(state.start).toHaveBeenCalledWith(
            expect.objectContaining({
              scope: 'groups',
              savePolicy: { mode: 'before', filePath: join(root, '用户指定.json') },
            }),
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each([undefined, ['123']] as const)('全量／精确范围生成独立名单任务：%j', async (ids) => {
    const host = await mount(ids ? [...ids] : undefined);
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '导出群聊名单',
    )!;
    expect(button.disabled).toBe(false);
    act(() => button.click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="确认名单导出"]')!.click(),
    );
    expect(state.start).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'groups',
        expectedAccountUin: '10001',
        expectedAccountConfigId: 'source-a',
        groupIds: ids ? ['123'] : undefined,
      }),
    );
    expect(state.start.mock.calls[0]![0]).not.toHaveProperty('groupCode');
    expect(state.start.mock.calls[0]![0]).not.toHaveProperty('uids');
  });
  it('空的精确群选择禁用导出，不退回全部群聊', async () => {
    const host = await mount([]);
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '导出群聊名单',
    )!;
    expect(button.disabled).toBe(true);
    expect(state.start).not.toHaveBeenCalled();
  });
});
