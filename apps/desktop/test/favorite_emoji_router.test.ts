import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';

const f = vi.hoisted(() => ({
  configId: 'source-a',
  online: true,
  path: '',
  switched: false,
  listRows: vi.fn(),
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
    emoji: { listFavEmojiRows: f.listRows },
    customEmoji: { resolveFile: f.resolveFile },
    messageSend: { sendElements: f.sendElements },
  };
  return {
    getAppContext: () => ({
      account: { context: { uin: '10001' } },
      services: f.switched ? { ...services } : services,
    }),
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
