// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountConfig, HostBridge, UserConfig } from '@weq/service';
import { DEVELOPMENT_DRESS_FLAG } from '../../../packages/service/src/common/development_dress';
import { dressupRouter } from '../src/main/ipc/routers/dressup';
import { emojiPanelRouter } from '../src/main/ipc/routers/emoji_panel';
import { marketEmojiRouter } from '../src/main/ipc/routers/market_emoji';
import { setMarketCatalogReader } from '../src/main/market_catalog';

const state = vi.hoisted(() => ({
  manifest: {
    bubbles: [],
    fonts: [],
    widgets: [],
    activeBubble: 11,
    activeFont: 22,
    activeWidget: 33,
    scope: 'all',
    background: 'custom',
    backgroundFile: '/synthetic/background.png',
    widgetId: '',
    backgroundOpacity: 0.7,
  },
  active: vi.fn(),
  homeDress: undefined as AccountConfig['homeDress'],
  online: false,
  bubble: vi.fn(() => ({ itemId: 99 })),
  fetchBubble: vi.fn(),
  fetchFont: vi.fn(),
  resolvePendantAnimation: vi.fn(),
  searchDress: vi.fn(),
  resolve: vi.fn(),
  key: vi.fn(async () => ({ key: 'synthetic-key' })),
  start: vi.fn(),
  userConfig: {} as UserConfig,
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: {
      getRecord: () => ({
        configId: 'synthetic',
        homeDress: state.homeDress,
        qqOnline: state.online,
        qqPid: state.online ? 123 : undefined,
      }),
      setHomeDress: (dress: AccountConfig['homeDress']) => {
        state.homeDress = dress;
      },
    },
    dressInstall: {
      read: () => state.manifest,
      messageBubble: () => undefined,
      indexResources: () => [],
      localBubble: state.bubble,
      fetchBubble: state.fetchBubble,
      fetchFont: state.fetchFont,
      resolvePendantAnimation: state.resolvePendantAnimation,
      setActive: state.active,
    },
    webQuery: { searchDress: state.searchDress },
    msgDecoration: { resolve: state.resolve },
    emoji: {
      getMarketPackKey: state.key,
      listMarketPackages: async () => [
        {
          packId: '123',
          name: 'QQ 表情包',
          summary: '',
          addTime: 1,
          sizeInfoJson: '',
          coverHash: 'fedcba9876543210fedcba9876543210',
        },
      ],
      getMarketPackItems: async (packId: string) => ({
        packId,
        name: '商城表情包',
        summary: '',
        count: 1,
        source: 'online',
        items: [{ hash: '0123456789abcdef0123456789abcdef', name: '合成表情' }],
      }),
      getMarketFace: async (_packId: string, _hash: string, localOnly?: boolean) =>
        localOnly ? null : '/synthetic/emoji.gif',
      getMarketPackImage: async () => null,
    },
    exportManager: { startMarketPackDownload: state.start },
  };
  return {
    getAppContext: () => ({
      services,
      bootstrap: {
        userConfig: {
          read: () => state.userConfig,
          write: (patch: Partial<UserConfig>) => {
            state.userConfig = { ...state.userConfig, ...patch };
          },
        },
      },
    }),
  };
});
const argv = process.argv;
beforeEach(() => {
  vi.clearAllMocks();
  state.homeDress = undefined;
  state.online = false;
  state.userConfig = {};
  vi.stubEnv('NODE_ENV', 'development');
  process.argv = [...argv, DEVELOPMENT_DRESS_FLAG];
});
afterEach(() => {
  process.argv = argv;
  setMarketCatalogReader(() => null);
  vi.unstubAllEnvs();
});
function callers(packaged: boolean) {
  const host = { isPackaged: () => packaged } as HostBridge;
  return {
    dress: dressupRouter.createCaller({ host }),
    market: marketEmojiRouter.createCaller({ host }),
    emojiPanel: emojiPanelRouter.createCaller({ host }),
  };
}

it('正式宿主即使带开发参数也拒绝装扮商城、安装、覆盖和素材保存', async () => {
  const { dress, market } = callers(true);
  const operations = [
    () => dress.rank({ kind: 'bubble' }),
    () => dress.search({ kind: 'font', keyword: 'synthetic' }),
    () => dress.search({ kind: 'font', keyword: '#59500' }),
    () => dress.installBubble({ itemId: 11 }),
    () => dress.installFont({ itemId: 22 }),
    () => dress.installWidget({ itemId: 33 }),
    () => dress.setActive({ kind: 'bubble', itemId: 11 }),
    () => dress.setScope({ scope: 'all' }),
    () => dress.setCallBackground({ itemId: 44 }),
    () => dress.saveMsgDecoration({ bubbleId: 11 }),
    () => market.getPackKey({ packId: '123', timestamp: 123456 }),
    () => market.searchCatalog({ keyword: 'synthetic' }),
    () => market.downloadPackToLocal({ packId: '123' }),
    () => market.startDownload({ packs: [{ id: '123', name: 'synthetic' }] }),
    () => market.downloadImage({ packId: '123', hash: 'abcdef123456', name: 'synthetic' }),
  ];
  for (const operation of operations) await expect(operation()).rejects.toThrow('未启用');
  expect(state.key).not.toHaveBeenCalled();
  expect(state.start).not.toHaveBeenCalled();
  expect(state.active).not.toHaveBeenCalled();
});

it('离线精确查找装扮 ID，也能解析榜单外素材，但不启用装扮', async () => {
  const { dress } = callers(false);
  const ranked = (await dress.rank({ kind: 'bubble' })).items[0]!;
  await expect(dress.search({ kind: 'bubble', keyword: ` #${ranked.itemId} ` })).resolves.toEqual({
    items: [ranked],
    total: 1,
  });
  expect(state.fetchBubble).not.toHaveBeenCalled();

  const id = 0xff00_002a;
  state.fetchFont.mockResolvedValueOnce({ itemId: id });
  await expect(dress.search({ kind: 'font', keyword: String(id) })).resolves.toMatchObject({
    items: [{ appId: 5, itemId: id, name: '' }],
    total: 1,
  });
  expect(state.fetchFont).toHaveBeenCalledWith(id);
  await expect(dress.search({ kind: 'widget', keyword: String(id) })).resolves.toEqual({
    items: [],
    total: 0,
  });
  expect(state.resolvePendantAnimation).toHaveBeenCalledWith(id);
  await expect(dress.search({ kind: 'font', keyword: '4294967296' })).resolves.toEqual({
    items: [],
    total: 0,
  });
  expect(state.fetchFont).toHaveBeenCalledTimes(1);
  await expect(dress.search({ kind: 'font', keyword: '手写体' })).rejects.toThrow('登录');
  expect(state.active).not.toHaveBeenCalled();
  expect(state.searchDress).not.toHaveBeenCalled();
});

it('通话背景的 ID 搜索只接受同类别、同 ID 且有素材的结果', async () => {
  const { dress } = callers(false);
  state.online = true;
  const id = 0xff00_002a;
  const videoUrl = 'https://example.test/background.mp4';
  state.searchDress.mockResolvedValueOnce({
    items: [
      { appId: 17, itemId: id + 1, videoUrl },
      { appId: 4, itemId: id, videoUrl },
      { appId: 17, itemId: id },
    ],
    total: 3,
  });
  await expect(dress.search({ kind: 'callbg', keyword: String(id) })).resolves.toEqual({
    items: [],
    total: 0,
  });
  const exact = { appId: 17, itemId: id, videoUrl };
  state.searchDress.mockResolvedValueOnce({ items: [exact], total: 1 });
  await expect(dress.search({ kind: 'callbg', keyword: `#${id}` })).resolves.toEqual({
    items: [exact],
    total: 1,
  });
  expect(state.searchDress).toHaveBeenLastCalledWith(17, String(id), 0);
});

it('普通模式可查目录、删除 QQ 来源的表情包并重新添加到输入框', async () => {
  const { market, emojiPanel } = callers(true);
  setMarketCatalogReader(() => ({
    version: 'fixture',
    entries: [{ id: '123', name: '商城表情包', mark: '', feeType: 'free' }],
  }));
  expect((await market.searchCatalog({ composer: true })).entries.map(({ id }) => id)).toEqual([
    '123',
  ]);
  expect(await emojiPanel.marketPackages()).toMatchObject([
    { name: 'QQ 表情包', coverHash: 'fedcba9876543210fedcba9876543210' },
  ]);
  await market.removeComposerPack({ packId: '123' });
  expect(await emojiPanel.marketPackages()).toEqual([]);
  expect(await market.listPackages()).toMatchObject([{ packId: '123', name: 'QQ 表情包' }]);

  await expect(market.addComposerPack({ packId: '123' })).resolves.toEqual({ cached: 1, total: 1 });
  expect(await emojiPanel.marketPackages()).toMatchObject([
    { name: '商城表情包', coverHash: '0123456789abcdef0123456789abcdef' },
  ]);
  expect(state.userConfig.hiddenComposerMarketPackIds).toEqual([]);
  await market.removeComposerPack({ packId: '123' });
  expect(await emojiPanel.marketPackages()).toEqual([]);
  expect(state.userConfig.composerMarketPacks).toEqual([]);
});

it('普通模式保留消息装扮与背景读取，只屏蔽任意覆盖且不改写原配置', async () => {
  const { dress } = callers(true);
  const result = await dress.getState();
  expect(result.manifest).toMatchObject({
    activeBubble: 0,
    activeFont: 0,
    activeWidget: 0,
    background: 'custom',
    backgroundOpacity: 0.7,
  });
  expect(state.manifest.activeBubble).toBe(11);
  expect(await dress.resolveMsgDecoration({ bubbleId: 99, localOnly: true })).toEqual({
    bubble: { itemId: 99 },
    font: null,
    widget: null,
  });
  expect(state.resolve).not.toHaveBeenCalled();
});

it('开发宿主必须再携带参数；开启后保留原覆盖与密钥工具', async () => {
  const { dress, market } = callers(false);
  process.argv = argv;
  await expect(market.getPackKey({ packId: '123' })).rejects.toThrow('未启用');
  process.argv = [...argv, DEVELOPMENT_DRESS_FLAG];
  expect((await dress.getState()).manifest.activeBubble).toBe(11);
  expect(await market.getPackKey({ packId: '123' })).toEqual({ key: 'synthetic-key' });
  expect(state.key).toHaveBeenCalledWith('123', undefined);
});

it('未取得 QQ 装扮快照时仍可用目录里的通话背景', async () => {
  const { dress } = callers(false);
  const imageUrl = 'https://example.test/background.jpg';
  const videoUrl = 'https://example.test/background.mp4';
  await dress.setCallBackground({ itemId: 44, name: '通话背景', imageUrl, videoUrl });
  expect(state.homeDress?.callBgCheckedAt).toBeGreaterThan(0);
  expect((await dress.getState()).own).toMatchObject({
    callBgId: 44,
    callBgName: '通话背景',
    callBgUrl: imageUrl,
    callBgVideoUrl: videoUrl,
  });
  await dress.setCallBackground({ itemId: 0 });
  expect((await dress.getState()).own).toMatchObject({
    callBgId: 0,
    callBgUrl: '',
    callBgVideoUrl: '',
  });
});
