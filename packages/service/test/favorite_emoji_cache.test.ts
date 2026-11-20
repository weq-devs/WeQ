import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import type { FavEmoji } from '@weq/db';
import { AddCustomFace, DeleteCustomFace } from '@weqbot/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmojiService } from '../src/account/emoji';
import { prepareFavoriteEmojiElements } from '../src/account/favorite_emoji_send';

const db = vi.hoisted(() => ({ rows: [] as FavEmoji[] }));
vi.mock('@weq/db', async (original) => ({
  ...(await original<typeof import('@weq/db')>()),
  FavEmojiDb: class {
    async listAll() {
      return db.rows;
    }
  },
}));
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const hash = createHash('md5').update(gif).digest('hex');
const emojiId = `10001_0_0_0_${hash.toUpperCase()}_0_0`;
let dir: string;
let platform: Platform;
function service(source = 'source-a') {
  return new EmojiService(
    { context: { uin: '10001', dbKey: '', algos: {} } } as Pick<AccountSession, 'context'>,
    platform,
    { nt: {} as Platform['native']['ntHelper'], resolvePid: () => 1 },
    join(dir, 'cache', source),
  );
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'weq-favorite-cache-'));
  await writeFile(join(dir, 'emoji.db'), 'fixture');
  platform = {
    ntDbDir: () => dir,
    personalEmojiDir: () => join(dir, 'personal_emoji'),
    emojiRecvDir: () => null,
    native: { ntHelper: {} },
  } as unknown as Platform;
  db.rows = [];
  vi.spyOn(AddCustomFace, 'invoke').mockResolvedValue(emojiId);
  vi.spyOn(DeleteCustomFace, 'invoke').mockResolvedValue();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
describe('新增收藏原图缓存', () => {
  it('QQ 尚未落库时可立即显示、按原字节发送，重开保留且数据源隔离', async () => {
    const emoji = service();
    expect(await emoji.listFavoriteEmojis()).toEqual([]);
    await emoji.addFavorite(gif);
    const [item] = await emoji.listFavoriteEmojis();
    expect(item).toMatchObject({ hash, scope: 'favorite', oriFile: `${hash}.gif` });
    expect(await readFile(emoji.resolveCachedFavorite(item!.oriFile!)!)).toEqual(gif);
    const listRows = vi.fn(async () => []);
    const sent = await prepareFavoriteEmojiElements(
      [
        {
          kind: 'image',
          source: {
            kind: 'favoriteEmoji',
            scope: 'favorite',
            bucket: '',
            variant: 'ori',
            file: item!.oriFile,
          },
        },
      ],
      {
        listRows,
        resolveFile: vi.fn(),
        resolveCachedFavorite: (file) => emoji.resolveCachedFavorite(file),
        checkCurrent() {},
      },
    );
    expect(sent[0]).toMatchObject({ source: gif, picFormat: 2000, subType: 1 });
    expect(listRows).not.toHaveBeenCalled();
    expect(await service().listFavoriteEmojis()).toEqual([item]);
    expect(await service('source-b').listFavoriteEmojis()).toEqual([]);
  });

  it('QQ 后续同步同图不重复，原有草稿的缓存地址保持可用', async () => {
    const emoji = service();
    await emoji.addFavorite(gif);
    const before = await emoji.listFavoriteEmojis();
    await mkdir(join(dir, 'personal_emoji', 'Ori'), { recursive: true });
    const oriPath = join(dir, 'personal_emoji', 'Ori', `${hash}.suf`);
    await writeFile(oriPath, gif);
    db.rows = [
      {
        id: emojiId,
        hash: hash.toUpperCase(),
        oriPath,
        thumbPath: '',
        remoteUrl: '',
        order: 0,
        batchId: '',
      },
    ];
    expect(await emoji.listFavoriteEmojis()).toEqual(before);
  });

  it('每次刷新重新读取 QQ 收藏，不永久缓存旧列表', async () => {
    const emoji = service();
    expect(await emoji.listFavoriteEmojis()).toEqual([]);
    await mkdir(join(dir, 'personal_emoji', 'Ori'), { recursive: true });
    const oriPath = join(dir, 'personal_emoji', 'Ori', `${hash}.gif`);
    await writeFile(oriPath, gif);
    db.rows = [{ id: emojiId, hash, oriPath, thumbPath: '', remoteUrl: '', order: 0, batchId: '' }];
    expect(await emoji.listFavoriteEmojis()).toHaveLength(1);
    db.rows = [];
    expect(await emoji.listFavoriteEmojis()).toEqual([]);
  });

  it('上传失败不新增，删除成功后旧缓存与旧草稿均不可用', async () => {
    const emoji = service();
    vi.mocked(AddCustomFace.invoke).mockRejectedValueOnce(new Error('上传失败'));
    await expect(emoji.addFavorite(gif)).rejects.toThrow('上传失败');
    expect(await emoji.listFavoriteEmojis()).toEqual([]);
    await emoji.addFavorite(gif);
    await emoji.deleteFavorite(emojiId);
    expect(await emoji.listFavoriteEmojis()).toEqual([]);
    expect(emoji.resolveCachedFavorite(`${hash}.gif`)).toBeNull();
    expect(emoji.resolveCachedFavorite(`../${hash}.gif`)).toBeNull();
  });
});
