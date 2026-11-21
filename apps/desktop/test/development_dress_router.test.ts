// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountConfig, HostBridge } from '@weq/service';
import { DEVELOPMENT_DRESS_FLAG } from '../../../packages/service/src/common/development_dress';
import { dressupRouter } from '../src/main/ipc/routers/dressup';
import { marketEmojiRouter } from '../src/main/ipc/routers/market_emoji';

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
  bubble: vi.fn(() => ({ itemId: 99 })),
  resolve: vi.fn(),
  key: vi.fn(async () => ({ key: 'synthetic-key' })),
  start: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: {
      accountConfig: {
        getRecord: () => ({ configId: 'synthetic', homeDress: state.homeDress }),
        setHomeDress: (dress: AccountConfig['homeDress']) => {
          state.homeDress = dress;
        },
      },
      dressInstall: {
        read: () => state.manifest,
        messageBubble: () => undefined,
        indexResources: () => [],
        localBubble: state.bubble,
        setActive: state.active,
      },
      msgDecoration: { resolve: state.resolve },
      emoji: { getMarketPackKey: state.key },
      exportManager: { startMarketPackDownload: state.start },
    },
  }),
}));
const argv = process.argv;
beforeEach(() => {
  vi.clearAllMocks();
  state.homeDress = undefined;
  vi.stubEnv('NODE_ENV', 'development');
  process.argv = [...argv, DEVELOPMENT_DRESS_FLAG];
});
afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
});
function callers(packaged: boolean) {
  const host = { isPackaged: () => packaged } as HostBridge;
  return {
    dress: dressupRouter.createCaller({ host }),
    market: marketEmojiRouter.createCaller({ host }),
  };
}

it('正式宿主即使带开发参数也拒绝装扮商城、安装、覆盖和素材保存', async () => {
  const { dress, market } = callers(true);
  const operations = [
    () => dress.rank({ kind: 'bubble' }),
    () => dress.search({ kind: 'font', keyword: 'synthetic' }),
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
