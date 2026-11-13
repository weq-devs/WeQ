// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import type { MessageMediaLocation } from '../src/shared/message_media';
type Location = MessageMediaLocation & { path: string };
const state = vi.hoisted(() => ({
  configId: 'source-a',
  canReveal: true,
  services: {} as object,
  resolve: vi.fn(async (_services: object, _target: object): Promise<Location[]> => []),
  reveal: vi.fn(async (_path: string) => {}),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ account: { context: { uin: '10001' } }, services: state.services }),
}));
vi.mock('../src/main/message_media_local', () => ({ messageMediaLocations: state.resolve }));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  getHost: () => ({ canReveal: state.canReveal, revealInFolder: state.reveal }),
}));
import { mediaResourceRouter } from '../src/main/ipc/routers/media_resource';

const input = {
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'source-a',
  target: {
    kind: 'ptt' as const,
    t: 1,
    name: 'sample',
    token: '',
    md5: '',
    msgId: '',
    conv: '',
    pack: '',
    hash: '',
    label: '语音',
  },
};
const location = { kind: 'saved' as const, key: 'saved-file' };
const revealInput = { ...input, location };
beforeEach(() => {
  state.configId = 'source-a';
  state.canReveal = true;
  state.services = { accountConfig: { getRecord: () => ({ configId: state.configId }) } };
  state.resolve
    .mockReset()
    .mockResolvedValue([{ ...location, path: '/synthetic/file', available: true }]);
  state.reveal.mockClear();
});
const api = () => mediaResourceRouter.createCaller({});

it('查询返回独立定位入口而不暴露路径，点击再次核实；文件消失不回退缓存', async () => {
  expect(await api().messageLocations(input)).toEqual([{ ...location, available: true }]);
  expect(state.reveal).not.toHaveBeenCalled();
  await api().revealMessageMedia(revealInput);
  expect(state.reveal).toHaveBeenCalledWith('/synthetic/file');
  state.reveal.mockClear();
  state.resolve.mockResolvedValue([
    { ...location, path: '/synthetic/file', available: false },
    { kind: 'cache', key: 'cache', path: '/synthetic/cache', available: true },
  ]);
  await expect(api().revealMessageMedia(revealInput)).rejects.toThrow('另存的文件已被移动或删除');
  expect(state.reveal).not.toHaveBeenCalled();
  await api().revealMessageMedia({ ...input, location: { kind: 'cache', key: 'cache' } });
  expect(state.reveal).toHaveBeenCalledWith('/synthetic/cache');
});
it('来源不匹配或异步查询期间切换账号时丢弃结果，不打开旧文件', async () => {
  await expect(
    api().messageLocations({ ...input, expectedAccountConfigId: 'source-b' }),
  ).rejects.toThrow('账号数据源已切换');
  expect(state.resolve).not.toHaveBeenCalled();
  state.resolve.mockImplementation(async () => {
    state.configId = 'source-b';
    return [{ ...location, path: '/synthetic/file', available: true }];
  });
  await expect(api().revealMessageMedia(revealInput)).rejects.toThrow('账号数据源已切换');
  expect(state.reveal).not.toHaveBeenCalled();
});
it('Web host 不允许通过接口打开服务器文件夹', async () => {
  state.canReveal = false;
  await expect(api().revealMessageMedia(revealInput)).rejects.toThrow('当前环境不支持');
  expect(state.resolve).not.toHaveBeenCalled();
  expect(state.reveal).not.toHaveBeenCalled();
});

it('菜单打开后路径变化，不把同类的另一份文件当作原定位对象', async () => {
  state.resolve.mockResolvedValue([
    { kind: 'cache', key: 'new-cache', path: '/synthetic/new-cache', available: true },
  ]);
  await expect(
    api().revealMessageMedia({ ...input, location: { kind: 'cache', key: 'old-cache' } }),
  ).rejects.toThrow('文件定位位置已更新');
  expect(state.reveal).not.toHaveBeenCalled();
});
