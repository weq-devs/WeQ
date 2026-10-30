import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupAlbumVideoUpload } from '../src/renderer/src/components/qq-actions/GroupAlbumVideoUpload';
import { localBackgroundTasks } from '../src/renderer/src/state/backgroundTasks';

const f = vi.hoisted(() => ({
  confirm: true,
  upload: vi.fn(),
  read: vi.fn(),
  changed: vi.fn(),
  chunk: vi.fn(),
  discard: vi.fn(),
}));
const binding = { expectedAccountUin: 'synthetic', expectedAccountConfigId: 'live' };
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      pickSendFile: {
        mutate: async () => ({ path: '/synthetic/video.mp4', fileName: 'video.mp4' }),
      },
      qqActions: {
        albumVideoUpload: { mutate: f.upload },
        albumVideoStart: { mutate: async () => ({ id: 'synthetic-stage' }) },
        albumVideoChunk: { mutate: f.chunk },
        albumVideoDiscard: { mutate: f.discard },
      },
      listGroupAlbumMedia: { query: f.read },
    },
  },
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
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
    perform: async (
      run: (binding: typeof binding) => Promise<unknown>,
      refresh: () => Promise<void>,
      _warning: string,
      options: { readback: () => Promise<boolean> },
    ) => {
      if (!f.confirm) return false;
      try {
        await run(binding);
        const matched = await options.readback();
        await refresh();
        return matched;
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
  f.upload.mockReset().mockResolvedValue({ state: 'unconfirmed', videoId: 'synthetic-video' });
  f.read.mockReset().mockResolvedValue([]);
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
  for (const task of localBackgroundTasks.snapshot()) {
    localBackgroundTasks.finish(task.id, 'cancelled');
    localBackgroundTasks.remove(task.id);
  }
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
  cleanups.push(() => act(() => root.unmount()));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="选择视频"]')!.click());
  const upload = () =>
    act(async () => host.querySelector<HTMLButtonElement>('[aria-label="上传视频"]')!.click());
  return { host, upload };
}

it('取消确认不创建任务，选择视频本身不算上传', async () => {
  const ui = await mount();
  expect(localBackgroundTasks.snapshot()).toHaveLength(0);
  f.confirm = false;
  await ui.upload();
  expect(localBackgroundTasks.snapshot()).toHaveLength(0);
  expect(f.upload).not.toHaveBeenCalled();
});
it('提交视频不等于成功，读回未确认时保留待核对且不重传', async () => {
  const ui = await mount();
  await ui.upload();
  expect(f.upload).toHaveBeenCalledOnce();
  expect(localBackgroundTasks.snapshot()[0]).toMatchObject({
    status: 'paused',
    statusLabel: '上传结果待核对',
    scope: { uin: binding.expectedAccountUin, configId: binding.expectedAccountConfigId },
  });
  expect(f.changed).not.toHaveBeenCalled();
});
it('只有原读回确认的视频及上传者匹配才显示完成', async () => {
  f.read.mockResolvedValue([
    { video: { id: 'synthetic-video' }, uploader: binding.expectedAccountUin },
  ]);
  const ui = await mount();
  await ui.upload();
  expect(localBackgroundTasks.snapshot()[0]?.status).toBe('completed');
  expect(f.changed).toHaveBeenCalledOnce();
});
it('请求发出后报错保留未确认，不诱导自动重传', async () => {
  f.upload.mockRejectedValueOnce(new Error('合成响应中断'));
  const ui = await mount();
  await ui.upload();
  expect(localBackgroundTasks.snapshot()[0]).toMatchObject({
    status: 'paused',
    note: '合成响应中断',
  });
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
  const task = localBackgroundTasks.snapshot().at(-1)!;
  await act(async () => localBackgroundTasks.act(task.id, 'stop'));
  expect(localBackgroundTasks.snapshot().at(-1)?.status).toBe('running');
  await act(async () => release({ offset: 1024 * 1024 }));
  expect(localBackgroundTasks.snapshot().at(-1)?.status).toBe('cancelled');
  expect(f.chunk).toHaveBeenCalledOnce();
  expect(f.discard).toHaveBeenCalledWith(expect.objectContaining({ uploadId: 'synthetic-stage' }));
  expect(f.upload).not.toHaveBeenCalled();
});
