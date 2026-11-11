// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  configId: 'source-a',
  canReveal: true,
  services: {} as object,
  resolve: vi.fn(
    async (_services: object, _target: object): Promise<string | null> => '/synthetic/file',
  ),
  reveal: vi.fn(async (_path: string) => {}),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ account: { context: { uin: '10001' } }, services: state.services }),
}));
vi.mock('../src/main/message_media_local', () => ({ localMessageMedia: state.resolve }));
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
beforeEach(() => {
  state.configId = 'source-a';
  state.canReveal = true;
  state.services = { accountConfig: { getRecord: () => ({ configId: state.configId }) } };
  state.resolve.mockReset().mockResolvedValue('/synthetic/file');
  state.reveal.mockClear();
});
const api = () => mediaResourceRouter.createCaller({});

it('查询只返回可用性，点击再次核实后才显示文件；文件消失时不调用系统', async () => {
  expect(await api().messageLocalAvailable(input)).toBe(true);
  expect(state.reveal).not.toHaveBeenCalled();
  await api().revealMessageMedia(input);
  expect(state.reveal).toHaveBeenCalledWith('/synthetic/file');
  state.reveal.mockClear();
  state.resolve.mockResolvedValue(null);
  await expect(api().revealMessageMedia(input)).rejects.toThrow('尚无本地文件');
  expect(state.reveal).not.toHaveBeenCalled();
});
it('来源不匹配或异步查询期间切换账号时丢弃结果，不打开旧文件', async () => {
  await expect(
    api().messageLocalAvailable({ ...input, expectedAccountConfigId: 'source-b' }),
  ).rejects.toThrow('账号数据源已切换');
  expect(state.resolve).not.toHaveBeenCalled();
  state.resolve.mockImplementation(async () => {
    state.configId = 'source-b';
    return '/synthetic/file';
  });
  await expect(api().revealMessageMedia(input)).rejects.toThrow('账号数据源已切换');
  expect(state.reveal).not.toHaveBeenCalled();
});
it('Web host 不允许通过接口打开服务器文件夹', async () => {
  state.canReveal = false;
  await expect(api().revealMessageMedia(input)).rejects.toThrow('当前环境不支持');
  expect(state.resolve).not.toHaveBeenCalled();
  expect(state.reveal).not.toHaveBeenCalled();
});
