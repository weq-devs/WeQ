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
    platform: { appDataRoot: () => state.root, marketFaceDir: () => join(state.root, 'qq') },
    bootstrap: { userConfig: { cacheDir: () => join(state.root, 'cache', 'media') } },
  }),
}));
import { localMessageMedia, savedMediaSourceKey } from '../src/main/message_media_local';

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
    fileSearch: { findFile: vi.fn(async () => ({ source, thumb: null })) },
    fileAssistant: { getFileInfoByMsgId: vi.fn(async () => null) },
    mediaDownload: {
      cachedFile: vi.fn(() => null),
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
    expect(await localMessageMedia(deps as unknown as AccountServices, target(kind))).toBe(file);
    await rm(file);
    expect(await localMessageMedia(deps as unknown as AccountServices, target(kind))).toBeNull();
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
  expect(await localMessageMedia(deps as unknown as AccountServices, selected)).toBe(file);
  expect(deps.emoji.getMarketFace).not.toHaveBeenCalled();
  expect(
    await localMessageMedia(deps as unknown as AccountServices, { ...selected, pack: '../100' }),
  ).toBeNull();
});

it.each(['pic', 'video', 'ptt', 'mface'] as const)(
  '%s 另存后的文件可定位，删除后不返回陈旧路径',
  async (kind) => {
    state.root = await mkdtemp(join(tmpdir(), 'weq-menu-saved-media-'));
    const file = join(state.root, 'saved-media');
    await writeFile(file, 'fixture');
    const url = `weq-media://${kind}?token=fixture&name=sample`;
    const task = {
      status: 'completed',
      resource: { kind: 'media', sourceKey: savedMediaSourceKey({ kind: 'url', url }) },
      save: { status: 'saved', path: file },
    };
    const deps = { ...services(), exportManager: { listTasks: () => [task] } };
    const selected = { ...target(kind), url: `/_media/${kind}?name=sample&token=fixture` };
    expect(await localMessageMedia(deps as unknown as AccountServices, selected)).toBe(file);
    await rm(file);
    expect(await localMessageMedia(deps as unknown as AccountServices, selected)).toBeNull();
  },
);
