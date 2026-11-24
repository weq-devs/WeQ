import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupAlbumVideoUpload } from '../src/renderer/src/components/qq-actions/GroupAlbumVideoUpload';
type HostStatus = {
  id: string;
  requestId: string;
  status: string;
  foreground: boolean;
  statusLabel?: string;
  note?: string;
  canVerify?: boolean;
};

const f = vi.hoisted(() => ({
  confirm: true,
  upload: vi.fn(),
  task: null as HostStatus | null,
  background: vi.fn(),
  verify: vi.fn(),
  changed: vi.fn(),
  chunk: vi.fn(),
  discard: vi.fn(),
}));
const binding = { expectedAccountUin: 'synthetic', expectedAccountConfigId: 'live' };
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      qqActions: {
        albumVideoStatus: {
          useQuery() {
            const [, setRevision] = useState(0);
            return {
              data: f.task,
              refetch: async () => {
                setRevision((n) => n + 1);
                return { data: f.task };
              },
            };
          },
        },
      },
    },
  },
  client: {
    account: {
      pickSendFile: {
        mutate: async () => ({ path: '/synthetic/video.mp4', fileName: 'video.mp4' }),
      },
      qqActions: {
        albumVideoPublish: { mutate: f.upload },
        albumVideoStatus: { query: async () => f.task },
        albumVideoBackground: { mutate: f.background },
        albumVideoVerify: { mutate: f.verify },
        albumVideoStart: { mutate: async () => ({ id: 'synthetic-stage' }) },
        albumVideoChunk: { mutate: f.chunk },
        albumVideoDiscard: { mutate: f.discard },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  useQQAlbumPermissions: () => ({ data: { upload: true }, error: null }),
  withQQAccountScope: (component: unknown) => component,
  ActionIcon: ({
    label,
    disabled,
    onClick,
    children,
  }: {
    label: string;
    disabled: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }) => h('button', { 'aria-label': label, disabled, onClick }, children),
  useQQAction: () => ({
    binding,
    disabled: false,
    busy: false,
    available: true,
    perform: async (run: (binding: typeof binding) => Promise<unknown>) => {
      if (!f.confirm) return false;
      try {
        await run(binding);
        return true;
      } catch {
        return false;
      }
    },
  }),
}));
vi.mock('../src/renderer/src/components/qq-actions/shared.shared', () => ({
  useQQAlbumPermissions: () => ({ data: { upload: true }, error: null }),
  withQQAccountScope: (component: unknown) => component,
  ActionIcon: ({
    label,
    disabled,
    onClick,
    children,
  }: {
    label: string;
    disabled: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }) => h('button', { 'aria-label': label, disabled, onClick }, children),
  useQQAction: () => ({
    binding,
    disabled: false,
    busy: false,
    available: true,
    perform: async (run: (binding: typeof binding) => Promise<unknown>) => {
      if (!f.confirm) return false;
      try {
        await run(binding);
        return true;
      } catch {
        return false;
      }
    },
  }),
}));

const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.confirm = true;
  f.task = null;
  f.background.mockReset().mockImplementation(async () => {
    if (f.task) f.task = { ...f.task, foreground: false };
    return true;
  });
  f.verify.mockReset().mockImplementation(async () => {
    if (f.task)
      f.task = {
        ...f.task,
        status: 'completed',
        statusLabel: undefined,
        canVerify: false,
        note: '视频已发布到群相册并读回确认',
      };
    return true;
  });
  f.upload.mockReset().mockImplementation(async ({ requestId }: { requestId: string }) => {
    f.task = {
      id: 'synthetic-task',
      requestId,
      status: 'running',
      statusLabel: '正在上传到 QQ 并发布',
      foreground: true,
    };
    return f.task.id;
  });
  f.changed.mockReset();
  f.chunk.mockReset();
  f.discard.mockReset().mockResolvedValue(true);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(
    (tag: string, options?: ElementCreationOptions) => {
      const element = create(tag, options);
      if (tag === 'video') {
        Object.defineProperties(element, {
          duration: { value: 10 },
          videoWidth: { value: 640 },
          videoHeight: { value: 480 },
          src: {
            set: () =>
              queueMicrotask(() =>
                (element as HTMLVideoElement).onloadeddata?.(new Event('loadeddata')),
              ),
          },
        });
        Object.assign(element, { pause() {}, load() {} });
      }
      if (tag === 'canvas')
        Object.assign(element, {
          getContext: () => ({ drawImage() {} }),
          toDataURL: () => 'data:image/jpeg;base64,c3ludGhldGlj',
        });
      return element;
    },
  );
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      h(GroupAlbumVideoUpload, { groupId: 123, albumId: 'synthetic-album', onChanged: f.changed }),
    ),
  );
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    act(() => root.unmount());
  };
  cleanups.push(close);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="选择视频"]')!.click());
  const upload = () =>
    act(async () => host.querySelector<HTMLButtonElement>('[aria-label="上传视频"]')!.click());
  return { host, upload, close };
}

it('取消确认不提交任务，选择视频本身不算上传', async () => {
  const ui = await mount();
  f.confirm = false;
  await ui.upload();
  expect(f.task).toBeNull();
  expect(f.upload).not.toHaveBeenCalled();
});
it('宿主接管后可显示原位进度，离开相册自动交接且不重复提交', async () => {
  const ui = await mount();
  await ui.upload();
  expect(ui.host.textContent).toContain('正在上传到 QQ 并发布');
  expect(f.changed).not.toHaveBeenCalled();
  ui.close();
  await vi.waitFor(() => expect(f.background).toHaveBeenCalledOnce());
  expect(f.background).toHaveBeenCalledWith({
    ...binding,
    taskId: 'synthetic-task',
    groupId: 123,
    albumId: 'synthetic-album',
  });
  expect(f.upload).toHaveBeenCalledOnce();
});
it('宿主未确认时只核对原任务，确认后刷新原相册', async () => {
  f.upload.mockImplementationOnce(async ({ requestId }) => {
    f.task = {
      id: 'synthetic-task',
      requestId,
      status: 'paused',
      statusLabel: '上传结果待核对',
      foreground: true,
      canVerify: true,
    };
    return f.task.id;
  });
  const ui = await mount();
  await ui.upload();
  expect(ui.host.textContent).toContain('上传结果待核对');
  expect(f.changed).not.toHaveBeenCalled();
  await act(async () =>
    ui.host.querySelector<HTMLButtonElement>('[aria-label="核对上传结果"]')!.click(),
  );
  expect(f.verify).toHaveBeenCalledWith({
    ...binding,
    taskId: 'synthetic-task',
    groupId: 123,
    albumId: 'synthetic-album',
  });
  expect(f.changed).toHaveBeenCalledOnce();
  expect(f.upload).toHaveBeenCalledOnce();
});
it('提交响应中断后仅重读受理状态，不自动重传', async () => {
  f.upload.mockRejectedValueOnce(new Error('合成响应中断'));
  const ui = await mount();
  await ui.upload();
  expect(ui.host.textContent).toContain('宿主受理结果待核对');
  await act(async () =>
    ui.host.querySelector<HTMLButtonElement>('[aria-label="重新读取上传状态"]')!.click(),
  );
  expect(f.upload).toHaveBeenCalledOnce();
});

it('停止宿主分片传输会等待在途分片并释放暂存，不继续上传 QQ', async () => {
  let release!: (value: { offset: number }) => void;
  f.chunk.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const ui = await mount();
  const input = ui.host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File([new Uint8Array(2 * 1024 * 1024)], 'synthetic.mp4')],
  });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await ui.upload();
  await act(async () => vi.waitFor(() => expect(f.chunk).toHaveBeenCalledOnce()));
  await act(async () =>
    ui.host.querySelector<HTMLButtonElement>('[aria-label="停止传输到宿主"]')!.click(),
  );
  await act(async () => release({ offset: 1024 * 1024 }));
  expect(ui.host.textContent).toContain('已停止传输视频到宿主');
  expect(f.chunk).toHaveBeenCalledOnce();
  expect(f.discard).toHaveBeenCalledWith(expect.objectContaining({ uploadId: 'synthetic-stage' }));
  expect(f.upload).not.toHaveBeenCalled();
});
