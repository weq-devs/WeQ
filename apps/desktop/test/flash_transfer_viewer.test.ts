import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FlashTransferViewer } from '../src/renderer/src/components/FlashTransferViewer';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';

const fixture = vi.hoisted(() => ({
  start: vi.fn(
    async (
      _input: unknown,
    ): Promise<{ started: number; errors: string[]; cancelled: boolean; taskId?: string }> => ({
      started: 2,
      errors: [],
      cancelled: false,
      taskId: 'batch-a',
    }),
  ),
  list: vi.fn(async (_input: unknown) => [] as unknown[]),
  directory: vi.fn(async (_input: unknown) => ({
    files: ['a.txt', 'b.txt'].map((name) => ({
      name,
      fileId: name,
      status: 2,
      fileSize: 100,
      isDir: false,
    })),
  })),
  background: vi.fn(async (_input: unknown) => true),
  pause: vi.fn(async (_input: unknown) => true),
  toast: vi.fn(),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/FlashShareDialog', () => ({
  FlashShareDialog: () => null,
}));
vi.mock('../src/renderer/src/components/Toast', () => ({
  useToastApi: () => ({ push: fixture.toast }),
  useToast: () => fixture.toast,
}));
vi.mock('../src/renderer/src/components/Toast.shared', () => ({
  useToastApi: () => ({ push: fixture.toast }),
  useToast: () => fixture.toast,
}));
vi.mock('../src/renderer/src/lib/resourceUrl', () => ({ fileIconUrl: (name: string) => name }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      getAccountConfig: { query: async () => ({ uin: '10001', configId: 'source' }) },
      flashViewDownloads: { query: fixture.list },
      flashBackgroundDownload: { mutate: fixture.background },
      flashPauseDownloadTask: { mutate: fixture.pause },
      flashListFiles: { query: fixture.directory },
      flashStartDownloads: { mutate: fixture.start },
    },
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  fixture.list.mockResolvedValue([]);
  vi.unstubAllGlobals();
});

it('取消保存目录后保留勾选，不关闭浏览弹窗或打开任务面板', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.start.mockResolvedValueOnce({ started: 0, errors: [], cancelled: true });
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
    expect(host.textContent).toContain('已选 2 项');
    expect(onClose).not.toHaveBeenCalled();
    expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(before);
  } finally {
    act(() => root.unmount());
  }
});

it('多选只提交一批，页内可交给后台，关闭时只暂停剩余前台批次', async () => {
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
    fixture.list.mockResolvedValue([
      {
        id: 'batch-a',
        foreground: true,
        status: 'downloading',
        fileSize: 200,
        downloadedBytes: 60,
        files: [{ id: 'a', relativePath: 'a.txt', status: 'downloading' }],
      },
      {
        id: 'batch-b',
        foreground: true,
        status: 'downloading',
        fileSize: 200,
        downloadedBytes: 80,
        files: [{ id: 'b', relativePath: 'b.txt', status: 'downloading' }],
      },
    ]);
    await act(async () => host.querySelector<HTMLButtonElement>('.weq-ft-btn-primary')!.click());
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(fixture.start.mock.calls[0]).toEqual([
      expect.objectContaining({
        viewFilesetId: 'fixture',
        selections: expect.arrayContaining([
          expect.objectContaining({ name: 'a.txt' }),
          expect.objectContaining({ name: 'b.txt' }),
        ]),
      }),
    ]);
    expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(before);
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelectorAll('[aria-label="本批次下载进度"]')).toHaveLength(2);
    fixture.start.mockResolvedValueOnce({
      started: 2,
      errors: [],
      cancelled: false,
      taskId: 'batch-b',
    });
    act(() => host.querySelector<HTMLInputElement>('.weq-ft-select-all input')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('.weq-ft-btn-primary')!.click());
    const first = host.querySelector('[aria-label="下载 a.txt"]')!;
    const backgroundButton = [...first.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('后台进行'),
    )!;
    await act(async () => backgroundButton.click());
    expect(fixture.background).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'batch-a' }));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(fixture.pause.mock.calls).toEqual([
      [expect.objectContaining({ taskId: 'batch-b', foregroundOnly: true })],
    ]);
  } finally {
    act(() => root.unmount());
  }
});

it('无可下载文件时不跳转，也不提示创建成功', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.start.mockResolvedValueOnce({ started: 0, errors: [], cancelled: false });
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

it('返回已读目录立即显示缓存，刷新失败保留旧文件', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const directory = { name: '下级目录', fileId: 'child', status: 2, fileSize: 0, isDir: true };
  fixture.directory.mockResolvedValueOnce({ files: [directory] });
  fixture.directory.mockResolvedValueOnce({
    files: [{ ...directory, name: '子目录文件.txt', fileId: 'child-file', isDir: false }],
  });
  let failRefresh!: (error: Error) => void;
  fixture.directory.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        failRefresh = reject;
      }),
  );
  try {
    await act(async () =>
      root.render(
        h(FlashTransferViewer, {
          filesetId: 'fixture',
          title: '合成资料',
          onClose() {},
        }),
      ),
    );
    await act(async () => host.querySelector<HTMLElement>('.weq-ft-card')!.click());
    expect(host.textContent).toContain('子目录文件.txt');

    await act(async () => host.querySelector<HTMLElement>('.weq-ft-crumb-link')!.click());
    expect(host.textContent).toContain('下级目录');
    expect(host.textContent).not.toContain('子目录文件.txt');
    expect(host.querySelector('[aria-label="正在读取文件"]')).toBeNull();

    await act(async () => failRefresh(new Error('目录读取失败')));
    expect(host.textContent).toContain('目录读取失败');
    expect(host.textContent).toContain('下级目录');
  } finally {
    await act(async () => root.unmount());
  }
});
