import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FlashTransferViewer } from '../src/renderer/src/components/FlashTransferViewer';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';

const fixture = vi.hoisted(() => ({
  start: vi.fn(async () => ({ started: 2, errors: [] })),
  toast: vi.fn(),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/FlashShareDialog', () => ({
  FlashShareDialog: () => null,
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => fixture.toast }));
vi.mock('../src/renderer/src/lib/resourceUrl', () => ({ fileIconUrl: (name: string) => name }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      flashListFiles: {
        query: async () => ({
          files: ['a.txt', 'b.txt'].map((name) => ({
            name,
            fileId: name,
            status: 2,
            fileSize: 100,
          })),
        }),
      },
      flashStartDownloads: { mutate: fixture.start },
    },
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('多选只提交一次下载操作，成功后进入常规任务入口，不展示独立列表', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const onClose = vi.fn();
  const before = useWorkspaceMenu.getState().taskOpenRequest;
  try {
    await act(async () =>
      root.render(h(FlashTransferViewer, { filesetId: 'fixture', title: '合成资料', onClose })),
    );
    act(() => host.querySelector<HTMLInputElement>('.weq-ft-select-all input')!.click());
    expect(host.textContent).toContain('已选 2 项');
    await act(async () => host.querySelector<HTMLButtonElement>('.weq-ft-btn-primary')!.click());
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(fixture.start.mock.calls[0]).toEqual([
      expect.objectContaining({
        selections: expect.arrayContaining([
          expect.objectContaining({ name: 'a.txt' }),
          expect.objectContaining({ name: 'b.txt' }),
        ]),
      }),
    ]);
    expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(before + 1);
    expect(onClose).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain('闪传下载任务');
  } finally {
    act(() => root.unmount());
  }
});

it('无可下载文件时不跳转，也不提示创建成功', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.start.mockResolvedValueOnce({ started: 0, errors: [] });
  const host = document.createElement('div');
  const root = createRoot(host);
  const onClose = vi.fn();
  const before = useWorkspaceMenu.getState().taskOpenRequest;
  try {
    await act(async () =>
      root.render(h(FlashTransferViewer, { filesetId: 'fixture', title: '合成资料', onClose })),
    );
    act(() => host.querySelector<HTMLInputElement>('.weq-ft-select-all input')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('.weq-ft-btn-primary')!.click());
    expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(before);
    expect(onClose).not.toHaveBeenCalled();
    expect(fixture.toast).toHaveBeenCalledWith({ tone: 'warning', message: '没有可下载的文件' });
  } finally {
    act(() => root.unmount());
  }
});
