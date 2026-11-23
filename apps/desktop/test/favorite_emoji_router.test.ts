// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { favoriteEmojiFileRevision } from '@weq/service';
import { accountRouter } from '../src/main/ipc/routers/account';
import { handleMediaRequest } from '../src/main/media_protocol';

const f = vi.hoisted(() => ({
  configId: 'source-a',
  online: true,
  path: '',
  switched: false,
  listRows: vi.fn(),
  listPanelFaces: vi.fn(),
  listRecentEmojis: vi.fn(),
  listFavoriteEmojis: vi.fn(),
  resolveFile: vi.fn(),
  sendElements: vi.fn(),
}));
vi.mock('../src/main/ocr/local', () => ({
  resolveLocalOcrModel: () => null,
  resolveLocalOcrFilterModel: () => null,
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: f.configId, qqOnline: f.online, qqPid: 1 }) },
    emoji: {
      listFavEmojiRows: f.listRows,
      listPanelFaces: f.listPanelFaces,
      listRecentEmojis: f.listRecentEmojis,
      listFavoriteEmojis: f.listFavoriteEmojis,
    },
    customEmoji: { resolveFile: f.resolveFile },
    messageSend: { sendElements: f.sendElements },
  };
  const bootstrap = () => ({
    userConfig: { getSettings: () => ({ autoAttachQq: true, ocr: { prefilterEnabled: false } }) },
  });
  return {
    accountEventBus: new EventEmitter(),
    getAppContext: () => ({
      account: { context: { uin: '10001' } },
      services: f.switched ? { ...services } : services,
      bootstrap: bootstrap(),
    }),
    requireBootstrap: bootstrap,
  };
});
const hash = 'aabbccddeeff00112233445566778899';
const gif = Buffer.from('4749463839610100010000003b', 'hex');
const input = {
  peerType: 'group' as const,
  targetId: '123',
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'source-a',
  elements: [
    {
      kind: 'image',
      source: {
        kind: 'favoriteEmoji',
        scope: 'personal',
        bucket: '',
        variant: 'thumb',
        file: `${hash}.png`,
      },
    },
  ],
};
let dir: string;
beforeEach(async () => {
  vi.resetAllMocks();
  f.configId = 'source-a';
  f.online = true;
  f.switched = false;
  dir = await mkdtemp(join(tmpdir(), 'weq-favorite-router-'));
  f.path = join(dir, 'original.gif');
  await writeFile(f.path, gif);
  f.listRows.mockResolvedValue([
    {
      hash,
      oriPath: `/qq/personal_emoji/Ori/${hash}.gif`,
      thumbPath: `/qq/personal_emoji/Thumb/${hash}.png`,
      remoteUrl: '',
    },
  ]);
  f.resolveFile.mockImplementation(async () => f.path);
  f.sendElements.mockResolvedValue({ result: 0, msgSeq: 42 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('收藏查询未完成时，系统目录和最近使用仍能返回', async () => {
  const faces = [{ key: 'faces', items: [{ id: '14' }] }];
  const recent = [{ id: '14' }];
  const favorites = [{ id: 'favorite-a' }];
  f.listPanelFaces.mockResolvedValue(faces);
  f.listRecentEmojis.mockResolvedValue(recent);
  let release!: () => void;
  f.listFavoriteEmojis.mockImplementation(
    () => new Promise((resolve) => (release = () => resolve(favorites))),
  );
  const panel = accountRouter.createCaller({}).emojiPanel;
  const loadingFavorites = panel.favorites();
  try {
    await vi.waitFor(() => expect(f.listFavoriteEmojis).toHaveBeenCalledTimes(1));
    await expect(panel.catalog()).resolves.toEqual({ faces, recent });
    expect(f.listFavoriteEmojis).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await expect(loadingFavorites).resolves.toEqual(favorites);
  }
});

it('Web 收藏预览私有缓存实际文件版本，旧版本及不同文件不会得到可缓存的图片', async () => {
  const uri = `weq-media://cemoji?scope=personal&v=thumb&file=${hash}.png`;
  const revision = favoriteEmojiFileRevision(f.path, await stat(f.path));
  const request = (version: string, etag?: string) =>
    new Request(`${uri}&previewRevision=${version}`, {
      headers: { 'x-weq-web': '1', ...(etag ? { 'If-None-Match': etag } : {}) },
    });
  const first = await handleMediaRequest(request(revision));
  expect(first.headers.get('cache-control')).toBe('private, max-age=86400');
  expect(first.headers.get('vary')).toBe('Cookie, Authorization');
  expect(Buffer.from(await first.arrayBuffer())).toEqual(gif);
  const conditional = await handleMediaRequest(request(revision, first.headers.get('etag')!));
  expect(conditional.status).toBe(304);
  expect(conditional.body).toBeNull();

  const another = join(dir, 'another.gif');
  await writeFile(another, gif);
  f.resolveFile.mockResolvedValueOnce(another);
  expect((await handleMediaRequest(request(revision))).status).toBe(404);
  await writeFile(f.path, Buffer.concat([gif, gif]));
  const stale = await handleMediaRequest(request(revision));
  expect(stale.status).toBe(404);
  expect(stale.headers.get('cache-control')).toBe('no-store');
  const updated = await handleMediaRequest(
    request(favoriteEmojiFileRevision(f.path, await stat(f.path))),
  );
  expect(updated.status).toBe(200);
  expect(Buffer.from(await updated.arrayBuffer())).toEqual(Buffer.concat([gif, gif]));
  const original = await handleMediaRequest(new Request(uri));
  expect(original.headers.get('cache-control')).toBeNull();
  await original.arrayBuffer();
});

describe('收藏表情发送 IPC', () => {
  it('原图进入既有发送链路，目标及回执原样保留', async () => {
    const result = await accountRouter.createCaller({}).sendElements(input);
    expect(result).toEqual({ result: 0, msgSeq: 42 });
    expect(f.sendElements).toHaveBeenCalledTimes(1);
    expect(f.sendElements).toHaveBeenCalledWith(
      expect.objectContaining({
        peerType: 'group',
        targetId: '123',
        elements: [expect.objectContaining({ kind: 'image', source: gif, subType: 1 })],
      }),
    );
  });
  it('回执失败不重发', async () => {
    f.sendElements.mockRejectedValue(new Error('服务端拒绝'));
    await expect(accountRouter.createCaller({}).sendElements(input)).rejects.toThrow('服务端拒绝');
    expect(f.sendElements).toHaveBeenCalledTimes(1);
  });
  it.each(['config', 'services', 'offline'] as const)(
    '准备原图时发生 %s 变化则不发送',
    async (mode) => {
      f.resolveFile.mockImplementation(async () => {
        if (mode === 'config') f.configId = 'source-b';
        if (mode === 'services') f.switched = true;
        if (mode === 'offline') f.online = false;
        return f.path;
      });
      await expect(
        accountRouter
          .createCaller({})
          .sendElements(
            mode === 'services' ? { ...input, expectedAccountConfigId: undefined } : input,
          ),
      ).rejects.toThrow();
      expect(f.sendElements).not.toHaveBeenCalled();
    },
  );
  it('损坏的原图在发送之前失败', async () => {
    await writeFile(f.path, '损坏图片');
    await expect(accountRouter.createCaller({}).sendElements(input)).rejects.toThrow('原图');
    expect(f.sendElements).not.toHaveBeenCalled();
  });
});
