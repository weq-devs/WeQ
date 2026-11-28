// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { handleMediaRequest, resolveOcrChatImageFile } from '../src/main/media_protocol';
import { setupImageWorker } from './support/image-worker';
import { updateTransferPolicy } from '@weq/service/transfer-policy';
import { UNKNOWN_NETWORK } from '@weq/service/data-saver';
import { ManagedDownload, transferActivity } from '@weq/service/managed-download';
import { backgroundTasks } from '../src/main/background_tasks';
import { startTransferPolicy } from '../src/main/data_saver';
import { watchTaskPage } from '../src/main/task_page';
import { MediaCacheService, MediaDownloadService, type AccountConfigService } from '@weq/service';
setupImageWorker();
const state = vi.hoisted(() => ({
  source: null as string | null,
  thumb: null as string | null,
  download: vi.fn(async () => null as string | null),
  mediaDownload: undefined as MediaDownloadService | undefined,
  cache: undefined as MediaCacheService | undefined,
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: {
      fileSearch: { findFile: async () => ({ source: state.source, thumb: state.thumb }) },
      mediaDownload: state.mediaDownload ?? { download: state.download, cachedFile: () => null },
    },
    bootstrap: {
      avatarCache: state.cache,
      userConfig: {
        getSharedPreference: () => ({ dataSaverMode: 'auto' }),
        getSettings: () => ({}),
      },
    },
  }),
}));
const roots: string[] = [];
afterEach(async () => {
  updateTransferPolicy('auto', UNKNOWN_NETWORK);
  state.source = state.thumb = null;
  state.cache = undefined;
  state.mediaDownload = undefined;
  state.download.mockClear();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('空间图片首次点击联网后，省流量仍能用原位地址读取本地图片', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-album-policy-'));
  roots.push(root);
  state.cache = new MediaCacheService({ cacheDir: (category) => join(root, category) });
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#454545' } })
    .png()
    .toBuffer();
  const fetch = vi.fn(
    async () => new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/png' } }),
  );
  vi.stubGlobal('fetch', fetch);
  updateTransferPolicy('always', UNKNOWN_NETWORK);
  const url = `weq-media://album?${new URLSearchParams({ src: 'https://a.qpic.cn/fixture.png', ds: '1' })}`;
  const get = (suffix = '') => handleMediaRequest(new Request(`${url}${suffix}`));
  expect((await get()).status).toBe(409);
  expect(fetch).not.toHaveBeenCalled();
  expect((await get('&intent=interactive')).status).toBe(200);
  expect(Buffer.from(await (await get()).arrayBuffer())).toEqual(bytes);
  expect(fetch).toHaveBeenCalledOnce();
});

it('挂件预览只取同款的已有尺寸，另一款不会误命中', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-dress-policy-'));
  roots.push(root);
  state.cache = new MediaCacheService({ cacheDir: (category) => join(root, category) });
  const preview = (id: number, version: number) =>
    `https://tianquan.gtimg.cn/faceAddon/item/${id}/newPreview${version}.png`;
  const hash = createHash('sha1').update(preview(101576, 1)).digest('hex');
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#454545' } })
    .png()
    .toBuffer();
  await mkdir(join(root, 'dress'));
  await writeFile(join(root, 'dress', `${hash}.png`), bytes);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  updateTransferPolicy('always', UNKNOWN_NETWORK);
  const get = (id: number) =>
    handleMediaRequest(
      new Request(`weq-media://dress?${new URLSearchParams({ src: preview(id, 2), ds: '1' })}`),
    );
  expect(Buffer.from(await (await get(101576)).arrayBuffer())).toEqual(bytes);
  expect((await get(101577)).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});
it('不自动加载仅允许现有缓存，携带小图地址也不发起下载', async () => {
  updateTransferPolicy('always', UNKNOWN_NETWORK, { dataSaverImageLoading: 'none' });
  const response = await handleMediaRequest(
    new Request(
      'weq-media://pic?t=1&name=x&token=token&small=https%3A%2F%2Fgchat.qpic.cn%2Fsmall&ds=1',
    ),
  );
  expect(response.status).toBe(409);
  expect(state.download).not.toHaveBeenCalled();
});
it('省流量不自动联网时仍可凭内容哈希读取此前已发的图片', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-sent-picture-'));
  roots.push(root);
  state.mediaDownload = new MediaDownloadService(
    {
      getConfigId: () => 'fixture',
      getRecord: () => ({ configId: 'fixture' }),
    } as unknown as AccountConfigService,
    root,
  );
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#454545' } })
    .png()
    .toBuffer();
  const digest = createHash('md5').update(bytes).digest('hex');
  const sent = (await state.mediaDownload.sentMedia?.stage(bytes))!;
  await sent.publish('pic', digest, ['sent-token']);
  await sent.discard();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  updateTransferPolicy('always', UNKNOWN_NETWORK, { dataSaverImageLoading: 'none' });
  const url = `weq-media://pic?token=readback-token&md5=${digest}&ds=1&cacheOnly=1`;
  const response = await handleMediaRequest(new Request(url));
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

  state.thumb = join(root, 'qq-thumbnail.png');
  await writeFile(state.thumb, await sharp(bytes).resize(1, 1).png().toBuffer());
  const cachedOriginal = await handleMediaRequest(new Request(`${url}&v=original&localOnly=1`));
  expect(cachedOriginal.status).toBe(200);
  expect(Buffer.from(await cachedOriginal.arrayBuffer())).toEqual(bytes);
  expect(fetch).not.toHaveBeenCalled();
});
it('选择自动原图时使用完整在线下载链路，不再强制仅小图', async () => {
  updateTransferPolicy('always', UNKNOWN_NETWORK, { dataSaverImageLoading: 'original' });
  await handleMediaRequest(new Request('weq-media://pic?t=1&name=x&token=token&ds=1'));
  expect(state.download).toHaveBeenCalledOnce();
});
it('表情自动下载开关独立于普通图片档位', async () => {
  updateTransferPolicy('always', UNKNOWN_NETWORK, {
    dataSaverImageLoading: 'original',
    dataSaverEmoji: false,
  });
  const response = await handleMediaRequest(
    new Request('weq-media://pic?t=1&name=x&token=token&recv=1&ds=1'),
  );
  expect(response.status).toBe(409);
  expect(state.download).not.toHaveBeenCalled();
  updateTransferPolicy('always', UNKNOWN_NETWORK, {
    dataSaverImageLoading: 'none',
    dataSaverEmoji: true,
  });
  await handleMediaRequest(new Request('weq-media://pic?t=1&name=x&token=token&recv=1&ds=1'));
  expect(state.download).toHaveBeenCalledOnce();
});
it('省流量下跨消息复用已下载表情，内容指纹必须与实际文件一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-chat-sticker-'));
  roots.push(root);
  state.mediaDownload = new MediaDownloadService(
    { getRecord: () => null } as unknown as AccountConfigService,
    root,
  );
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#454545' } })
    .png()
    .toBuffer();
  const md5 = createHash('md5').update(bytes).digest('hex');
  const wrongMd5 = 'a'.repeat(32);
  const fetch = vi.fn(
    async () => new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/png' } }),
  );
  vi.stubGlobal('fetch', fetch);
  updateTransferPolicy('always', UNKNOWN_NETWORK, { dataSaverEmoji: false });
  const get = (params: Record<string, string>) =>
    handleMediaRequest(
      new Request(`weq-media://pic?${new URLSearchParams({ recv: '1', ds: '1', ...params })}`),
    );
  const later = { t: '2', token: '502', name: `${md5.toUpperCase()}.png` };
  expect((await get(later)).status).toBe(409);
  expect(
    (
      await get({
        t: '1',
        token: '501',
        orig: '/fixture.png',
        md5: wrongMd5,
        intent: 'interactive',
      })
    ).status,
  ).toBe(200);
  expect((await get({ ...later, md5: wrongMd5 })).status).toBe(409);
  expect((await get({ t: '1', token: '501', md5 })).status).toBe(200);
  const reused = await get(later);
  expect(reused.status).toBe(200);
  expect(Buffer.from(await reused.arrayBuffer())).toEqual(bytes);
  expect(fetch).toHaveBeenCalledOnce();
});
it('省流量缩图缺失不偷偷下载原图，显式点击仍使用现有下载服务', async () => {
  const automatic = await handleMediaRequest(
    new Request('weq-media://pic?t=1&name=x&token=token&v=thumb&ds=1'),
  );
  expect(automatic.status).toBe(409);
  expect(automatic.headers.get('X-WeQ-Media-State')).toBe('deferred');
  expect(state.download).not.toHaveBeenCalled();
  await handleMediaRequest(
    new Request('weq-media://pic?t=1&name=x&token=token&intent=interactive&ds=1'),
  );
  expect(state.download).toHaveBeenCalledOnce();
});
it('省流量下有小图地址但取图失败时返回失败，也不回退原图', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-thumbnail-policy-'));
  roots.push(root);
  state.mediaDownload = new MediaDownloadService(
    { getRecord: () => null } as unknown as AccountConfigService,
    root,
  );
  const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  const small = 'https://gchat.qpic.cn/fixture.png';
  const params = new URLSearchParams({ name: 'x', token: 'token', v: 'thumb', ds: '1', small });
  const response = await handleMediaRequest(new Request(`weq-media://pic?${params}`));
  expect(response.status).toBe(404);
  expect(response.headers.has('X-WeQ-Media-State')).toBe(false);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([small]);
});
it('预览自动获取原图仍受宿主的省流量状态约束', async () => {
  const url = 'weq-media://pic?token=token&v=original&intent=interactive&ds=1';
  expect((await handleMediaRequest(new Request(`${url}&autoOriginal=1`))).status).toBe(409);
  expect(state.download).not.toHaveBeenCalled();
  await handleMediaRequest(new Request(url));
  expect(state.download).toHaveBeenCalledOnce();
});
it('OCR 仅在开启补取且省流量未生效时自动请求原图', async () => {
  state.thumb = '/existing/thumbnail.png';
  const query = new URLSearchParams('token=token&v=thumb&preview=1&intent=interactive');
  expect((await resolveOcrChatImageFile(query, false)).path).toBeNull();
  updateTransferPolicy('always', UNKNOWN_NETWORK);
  expect(await resolveOcrChatImageFile(query, true)).toMatchObject({ deferred: true });
  expect(state.download).not.toHaveBeenCalled();
  updateTransferPolicy('never', UNKNOWN_NETWORK);
  state.download.mockResolvedValueOnce('/fetched/original.png');
  expect((await resolveOcrChatImageFile(query, true)).path).toBe('/fetched/original.png');
  expect(state.download).toHaveBeenCalledOnce();
});
it('灯箱自动取图只显示原位进度，手动取图传递页面和下载控制', async () => {
  const pageId = crypto.randomUUID();
  const url = `weq-media://pic?token=token&v=original&intent=interactive&transferId=${crypto.randomUUID()}`;
  await handleMediaRequest(new Request(`${url}&autoOriginal=1`));
  await handleMediaRequest(new Request(`${url}&pageId=${pageId}`));
  expect(state.download).toHaveBeenNthCalledWith(
    1,
    'token',
    expect.objectContaining({ reportActivity: false }),
    expect.any(Function),
  );
  expect(state.download).toHaveBeenNthCalledWith(
    2,
    'token',
    expect.objectContaining({
      reportActivity: true,
      activity: { pageId, onState: expect.any(Function) },
    }),
    expect.any(Function),
  );
});
it.each([false, true])(
  '原图传输仅在未完成离开灯箱时进入任务列表（中途离开：%s）',
  (leavesEarly) => {
    startTransferPolicy();
    let pageId: string | undefined;
    const page = watchTaskPage().subscribe({
      next: (id) => {
        pageId = id;
      },
    });
    const transfer = new ManagedDownload({ activityPageId: pageId });
    const id = crypto.randomUUID();
    const activity = {
      id,
      name: id,
      transfer,
      paused: true,
      reasons: ['network'],
      received: 10,
      total: 100,
    };
    const task = () => backgroundTasks.snapshot().find((row) => row.name === id);
    try {
      transferActivity.emit('state', activity);
      expect(task()).toMatchObject({ status: 'paused', foreground: true });
      if (leavesEarly) page.unsubscribe();
      transferActivity.emit('state', { ...activity, done: true, paused: false, received: 100 });
      page.unsubscribe();
      expect(task()).toMatchObject({ status: 'completed', foreground: !leavesEarly });
    } finally {
      page.unsubscribe();
      const finished = task();
      if (finished) backgroundTasks.remove(finished.id);
    }
  },
);
it('宿主已有原图时自动响应真实小图，原图点击才传原始内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-data-saver-media-'));
  roots.push(root);
  state.source = join(root, 'original.png');
  const original = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: '#bb4455' },
  })
    .png()
    .toBuffer();
  await writeFile(state.source, original);
  const automatic = await handleMediaRequest(
    new Request('weq-media://pic?t=1&name=x&v=thumb&ds=1'),
  );
  const small = Buffer.from(await automatic.arrayBuffer());
  expect(automatic.status).toBe(200);
  expect(small.length).toBeLessThan(original.length);
  expect((await sharp(small).metadata()).width).toBeLessThan(2000);
  const interactive = await handleMediaRequest(
    new Request('weq-media://pic?t=1&name=x&intent=interactive&ds=1'),
  );
  expect(Buffer.from(await interactive.arrayBuffer())).toEqual(original);
  expect(state.download).not.toHaveBeenCalled();
});
