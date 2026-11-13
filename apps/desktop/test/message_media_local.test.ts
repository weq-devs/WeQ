// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountServices } from '../src/main/context/app_context';
import type { MessageMediaTarget } from '../src/shared/message_media';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    platform: {
      appDataRoot: () => state.root,
      marketFaceDir: () => join(state.root, 'qq'),
      fileDir: () => join(state.root, 'qq-files'),
    },
    bootstrap: { userConfig: { cacheDir: () => join(state.root, 'cache', 'media') } },
  }),
}));
import { messageMediaLocations, savedMediaSourceKey } from '../src/main/message_media_local';

afterEach(async () => {
  if (state.root) await rm(state.root, { recursive: true, force: true });
});
const target = (kind: MessageMediaTarget['kind']): MessageMediaTarget => ({
  kind,
  t: 1,
  name: 'sample',
  token: 'token',
  md5: '',
  msgId: '123',
  conv: '1234',
  pack: '100',
  hash: 'ab'.repeat(16),
  label: 'sample',
});
function services(source: string | null = null) {
  return {
    exportManager: { listTasks: () => [] },
    accountConfig: { getRecord: () => ({ uin: '10000' }) },
    fileSearch: {
      findFile: vi.fn(
        async (): Promise<{ source: string | null; thumb: string | null }> => ({
          source,
          thumb: null,
        }),
      ),
    },
    fileAssistant: { getFileInfoByMsgId: vi.fn(async () => null) },
    mediaDownload: {
      cachedFile: vi.fn((): string | null => null),
      download: vi.fn(() => {
        throw new Error('不应下载');
      }),
    },
    emoji: {
      getMarketFace: vi.fn(() => {
        throw new Error('不应解码');
      }),
    },
  };
}

it.each(['pic', 'emoji', 'video', 'ptt', 'file'] as const)(
  '%s 只查现成文件，文件消失后返回不可用',
  async (kind) => {
    state.root = await mkdtemp(join(tmpdir(), 'weq-menu-media-'));
    const file = join(state.root, 'sample');
    await writeFile(file, 'fixture');
    const deps = services(file);
    expect(await messageMediaLocations(deps as unknown as AccountServices, target(kind))).toEqual([
      expect.objectContaining({ kind: 'cache', path: file, available: true }),
    ]);
    await rm(file);
    expect(await messageMediaLocations(deps as unknown as AccountServices, target(kind))).toEqual(
      [],
    );
    expect(deps.mediaDownload.download).not.toHaveBeenCalled();
  },
);

it('商城表情直接定位 QQ 原始缓存，不解密也不创建 WeQ 副本', async () => {
  state.root = await mkdtemp(join(tmpdir(), 'weq-menu-media-'));
  const selected = target('mface');
  const folder = join(state.root, 'qq', selected.pack);
  await mkdir(folder, { recursive: true });
  const file = join(folder, selected.hash);
  await writeFile(file, 'encrypted fixture');
  const deps = services();
  expect(await messageMediaLocations(deps as unknown as AccountServices, selected)).toEqual([
    expect.objectContaining({ kind: 'cache', path: file }),
  ]);
  expect(deps.emoji.getMarketFace).not.toHaveBeenCalled();
  expect(
    await messageMediaLocations(deps as unknown as AccountServices, {
      ...selected,
      pack: '../100',
    }),
  ).toEqual([]);
});

it.each(['pic', 'emoji', 'video', 'ptt', 'mface', 'file'] as const)(
  '%s 另存与任务缓存分别定位，删除另存文件保留失效记录',
  async (kind) => {
    state.root = await mkdtemp(join(tmpdir(), 'weq-menu-saved-media-'));
    const file = join(state.root, 'saved-media');
    const cache = join(state.root, 'task-cache');
    await writeFile(file, 'fixture');
    await writeFile(cache, 'fixture');
    const url = `weq-media://${kind}?token=fixture&name=sample`;
    const task = {
      id: 'saved-task',
      createdAt: 1,
      status: 'completed',
      filePath: cache,
      resource: {
        kind: 'media',
        sourceKey: savedMediaSourceKey(
          kind === 'file' ? { ...target(kind), kind: 'chat-file' } : { kind: 'url', url },
        ),
      },
      save: { status: 'saved', path: file },
    };
    const deps = { ...services(), exportManager: { listTasks: () => [task] } };
    const selected = { ...target(kind), url: `/_media/${kind}?name=sample&token=fixture` };
    const before = await messageMediaLocations(deps as unknown as AccountServices, selected);
    expect(before).toEqual([
      expect.objectContaining({ kind: 'saved', path: file, available: true }),
      expect.objectContaining({ kind: 'cache', path: cache, available: true }),
    ]);
    await rm(file);
    expect(await messageMediaLocations(deps as unknown as AccountServices, selected)).toEqual([
      { ...before[0], available: false },
      before[1],
    ]);
  },
);

it('按最近一次成功保存选定另存记录，不因文件丢失回落到更早的副本', async () => {
  state.root = await mkdtemp(join(tmpdir(), 'weq-menu-media-'));
  const file = join(state.root, 'old-save');
  await writeFile(file, 'fixture');
  const selected = { ...target('pic'), url: 'weq-media://pic?token=fixture' };
  const resource = {
    kind: 'media',
    sourceKey: savedMediaSourceKey({ kind: 'url', url: selected.url }),
  };
  const tasks = [
    {
      id: 'new-task',
      createdAt: 20,
      status: 'completed',
      resource,
      save: { status: 'saved', path: file, savedAt: 20 },
    },
    {
      id: 'old-task-resaved',
      createdAt: 10,
      status: 'completed',
      resource,
      save: { status: 'failed', path: join(state.root, 'latest-save'), savedAt: 30 },
    },
  ];
  const deps = { ...services(), exportManager: { listTasks: () => tasks } };
  expect(await messageMediaLocations(deps as unknown as AccountServices, selected)).toEqual([
    expect.objectContaining({ kind: 'saved', path: tasks[1].save.path, available: false }),
  ]);
});

it.each(['pic', 'video', 'emoji', 'file'] as const)(
  '%s 正确区分缩略图、封面、完整表情与文件图标',
  async (kind) => {
    state.root = await mkdtemp(join(tmpdir(), 'weq-menu-media-'));
    const thumb = join(state.root, 'thumb.png');
    await writeFile(thumb, 'fixture');
    const deps = services();
    deps.fileSearch.findFile.mockResolvedValue({ source: null, thumb });
    const locations = await messageMediaLocations(deps as unknown as AccountServices, target(kind));
    expect(locations).toEqual(
      kind === 'file'
        ? []
        : [
            expect.objectContaining({
              kind: kind === 'pic' ? 'thumbnail' : kind === 'video' ? 'cover' : 'cache',
              path: thumb,
            }),
          ],
    );
  },
);

it('完整视频缓存优先于封面；正式下载文件与内部任务缓存同时提供', async () => {
  state.root = await mkdtemp(join(tmpdir(), 'weq-menu-media-'));
  const source = join(state.root, 'video.mp4');
  const thumb = join(state.root, 'cover.jpg');
  await writeFile(source, 'fixture');
  await writeFile(thumb, 'fixture');
  const deps = services();
  deps.fileSearch.findFile.mockResolvedValue({ source: null, thumb });
  deps.mediaDownload.cachedFile.mockImplementation(() => source);
  expect(await messageMediaLocations(deps as unknown as AccountServices, target('video'))).toEqual([
    expect.objectContaining({ kind: 'cache', path: source }),
  ]);
  const fileDeps = {
    ...services(source),
    fileAssistant: {
      getFileInfoByMsgId: vi.fn(async () => ({ localPath: thumb, fileName: 'sample' })),
    },
  };
  expect(
    await messageMediaLocations(fileDeps as unknown as AccountServices, target('file')),
  ).toEqual([
    expect.objectContaining({ kind: 'local', path: thumb }),
    expect.objectContaining({ kind: 'cache', path: source }),
  ]);
});

it('QQ 文件缓存目录内的 localPath 不冒充正式下载文件', async () => {
  state.root = await mkdtemp(join(tmpdir(), 'weq-menu-media-'));
  const folder = join(state.root, 'qq-files', 'Ori');
  await mkdir(folder, { recursive: true });
  const path = join(folder, 'sample');
  await writeFile(path, 'fixture');
  const deps = {
    ...services(path),
    fileAssistant: {
      getFileInfoByMsgId: vi.fn(async () => ({
        localPath: `::NTOSFull::${path}`,
        fileName: 'sample',
      })),
    },
  };
  expect(await messageMediaLocations(deps as unknown as AccountServices, target('file'))).toEqual([
    expect.objectContaining({ kind: 'cache', path }),
  ]);
});

it('只下载过视频封面时不显示视频缓存入口，语音任务 WAV 明确标为转码缓存', async () => {
  state.root = await mkdtemp(join(tmpdir(), 'weq-menu-media-'));
  const cover = join(state.root, 'cover.jpg');
  const wav = join(state.root, 'voice.wav');
  await writeFile(cover, 'fixture');
  await writeFile(wav, 'fixture');
  const deps = services();
  deps.mediaDownload.cachedFile.mockImplementation((_token?: string, ext?: string) =>
    ext === '.jpg' ? cover : null,
  );
  expect(await messageMediaLocations(deps as unknown as AccountServices, target('video'))).toEqual([
    expect.objectContaining({ kind: 'cover', path: cover }),
  ]);
  const selected = { ...target('ptt'), url: 'weq-media://ptt?token=fixture' };
  const taskDeps = {
    ...services(),
    exportManager: {
      listTasks: () => [
        {
          id: 'voice',
          createdAt: 1,
          status: 'completed',
          filePath: wav,
          resource: {
            kind: 'media',
            sourceKey: savedMediaSourceKey({ kind: 'url', url: selected.url }),
          },
        },
      ],
    },
  };
  expect(await messageMediaLocations(taskDeps as unknown as AccountServices, selected)).toEqual([
    expect.objectContaining({ kind: 'transcoded', path: wav }),
  ]);
});
