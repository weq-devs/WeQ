import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';

const f = vi.hoisted(() => ({
  configId: 'source-a',
  pid: 1,
  switched: false,
  list: vi.fn(),
  remember: vi.fn(),
  sendFile: vi.fn(),
}));
vi.mock('../src/main/ocr/local', () => ({
  resolveLocalOcrModel: () => null,
  resolveLocalOcrFilterModel: () => null,
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: f.configId, qqOnline: true, qqPid: f.pid }) },
    groupFile: { list: f.list },
    contentSearch: { remember: f.remember },
    messageSend: { sendFile: f.sendFile },
  };
  return {
    getAppContext: () => ({
      account: { context: { uin: '10001' } },
      services: f.switched ? { ...services } : services,
    }),
  };
});
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
beforeEach(() => {
  vi.resetAllMocks();
  f.configId = 'source-a';
  f.pid = 1;
  f.switched = false;
  f.list.mockImplementation(async (_group: number, directory: string) => ({
    targetDirectory: directory,
    files: [],
    folders: [],
  }));
  f.sendFile.mockResolvedValue({ ok: true });
});
describe('群文件管理器 IPC 来源', () => {
  it('目录查询保留账号绑定、群与目录，正常结果才进入已浏览索引', async () => {
    expect(
      await accountRouter
        .createCaller({})
        .listGroupFiles({ ...binding, groupCode: '123', folderId: 'nested' }),
    ).toMatchObject({ targetDirectory: 'nested' });
    expect(f.list).toHaveBeenCalledWith(123, 'nested');
    expect(f.remember).toHaveBeenCalledTimes(1);
  });
  it.each(['config', 'services', 'pid', 'directory'] as const)(
    '查询返回时 %s 改变，丢弃旧结果而不污染索引',
    async (mode) => {
      f.list.mockImplementation(async () => {
        if (mode === 'config') f.configId = 'source-b';
        if (mode === 'services') f.switched = true;
        if (mode === 'pid') f.pid = 2;
        return {
          targetDirectory: mode === 'directory' ? 'other' : 'nested',
          files: [],
          folders: [],
        };
      });
      await expect(
        accountRouter
          .createCaller({})
          .listGroupFiles({ ...binding, groupCode: '123', folderId: 'nested' }),
      ).rejects.toThrow();
      expect(f.remember).not.toHaveBeenCalled();
    },
  );
  it('本机文件沿用发送管线，传递真实目录与改名，长上传前复核来源及 QQ 运行时', async () => {
    await accountRouter.createCaller({}).sendFile({
      ...binding,
      peerType: 'group',
      targetId: '123',
      folderId: 'nested',
      path: '/synthetic/file.txt',
      fileName: '新名称.txt',
    });
    const sent = f.sendFile.mock.calls[0]![0];
    expect(sent).toMatchObject({
      peerType: 'group',
      targetId: '123',
      folderId: 'nested',
      path: '/synthetic/file.txt',
      fileName: '新名称.txt',
    });
    expect(() => sent.beforeSend()).not.toThrow();
    f.pid = 2;
    expect(() => sent.beforeSend()).toThrow('切换');
    expect(f.sendFile).toHaveBeenCalledTimes(1);
  });
});
