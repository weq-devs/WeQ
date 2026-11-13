// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
import { readFile, access } from 'node:fs/promises';
import { webNotices, type WebNotice } from '../src/main/web/notices';

const f = vi.hoisted(() => ({
  configId: 'source-a',
  pid: 1,
  switched: false,
  list: vi.fn(),
  remember: vi.fn(),
  sendFile: vi.fn(),
  trustPath: vi.fn(),
  untrustPath: vi.fn(),
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
    fileResource: { trustPath: f.trustPath, untrustPath: f.untrustPath },
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
  it('通用设备选文件无需在线 QQ，完整发布后才授权预览，丢弃时撤销信任', async () => {
    const api = accountRouter.createCaller({});
    f.pid = 0;
    const upload = await api.pickedFileStart({ ...binding, size: 3, name: 'fixture.zip' });
    let path = '';
    try {
      await expect(api.pickedFileFinish({ ...binding, uploadId: upload.id })).rejects.toThrow(
        '完整',
      );
      expect(f.trustPath).not.toHaveBeenCalled();
      await api.pickedFileChunk({ ...binding, uploadId: upload.id, offset: 0, base64: 'YWJj' });
      const file = await api.pickedFileFinish({ ...binding, uploadId: upload.id });
      path = file.path;
      expect(file).toMatchObject({ fileName: 'fixture.zip', size: 3 });
      expect(await readFile(path, 'utf8')).toBe('abc');
      expect(f.trustPath).toHaveBeenCalledWith(path);
      f.switched = true;
      await expect(api.pickedFileFinish({ ...binding, uploadId: upload.id })).rejects.toThrow(
        '失效',
      );
    } finally {
      f.switched = false;
      await api.pickedFileDiscard({ ...binding, uploadId: upload.id });
    }
    expect(f.untrustPath).toHaveBeenCalledWith(path);
    await expect(access(path)).rejects.toThrow();
  });
  it('Web 提醒只投递订阅的账号与来源，切号停止，取消订阅释放监听', async () => {
    const stream = await accountRouter.createCaller({}).onWebNotice(binding);
    const received: WebNotice[] = [];
    const before = webNotices.listenerCount('notice');
    const sub = stream.subscribe({ next: (notice) => received.push(notice) });
    const notice: WebNotice = {
      uin: '10001',
      configId: 'source-a',
      kind: 'mail',
      title: '邮件',
      body: '收到新邮件。',
    };
    try {
      webNotices.emit('notice', { ...notice, uin: '20002' });
      webNotices.emit('notice', { ...notice, configId: 'source-b' });
      expect(received).toHaveLength(0);
      webNotices.emit('notice', notice);
      expect(received).toEqual([notice]);
      f.switched = true;
      webNotices.emit('notice', notice);
      expect(received).toHaveLength(1);
    } finally {
      sub.unsubscribe();
    }
    expect(webNotices.listenerCount('notice')).toBe(before);
  });
  it('Web 分段附件复用原文件管线，成功和失败都回收临时文件', async () => {
    const api = accountRouter.createCaller({});
    for (const fail of [false, true]) {
      const upload = await api.browserFileStart({ ...binding, size: 3 });
      await expect(
        api.sendFile({ ...binding, peerType: 'group', targetId: '123', uploadId: upload.id }),
      ).rejects.toThrow('完整');
      await expect(
        api.browserFileChunk({ ...binding, uploadId: upload.id, offset: 1, base64: 'AQID' }),
      ).rejects.toThrow('偏移');
      await api.browserFileChunk({ ...binding, uploadId: upload.id, offset: 0, base64: 'AQID' });
      let path = '';
      f.sendFile.mockImplementationOnce(async (input) => {
        path = input.path;
        expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3]));
        input.beforeSend();
        if (fail) throw new Error('合成发送失败');
        return { ok: true };
      });
      const sent = api.sendFile({
        ...binding,
        peerType: 'group',
        targetId: '123',
        fileName: 'fixture.txt',
        uploadId: upload.id,
      });
      if (fail) await expect(sent).rejects.toThrow('合成发送失败');
      else expect(await sent).toEqual({ ok: true });
      await expect(access(path)).rejects.toThrow();
      await api.browserFileDiscard({ ...binding, uploadId: upload.id });
    }
  });
  it('Web 附件绑定账号，不接受混合来源或无效编码', async () => {
    const api = accountRouter.createCaller({});
    const upload = await api.browserFileStart({ ...binding, size: 1 });
    try {
      await expect(
        api.browserFileChunk({ ...binding, uploadId: upload.id, offset: 0, base64: 'invalid' }),
      ).rejects.toThrow('编码');
      f.switched = true;
      await expect(
        api.browserFileChunk({ ...binding, uploadId: upload.id, offset: 0, base64: 'AQ==' }),
      ).rejects.toThrow('失效');
      f.switched = false;
      await expect(
        api.sendFile({
          ...binding,
          peerType: 'group',
          targetId: '123',
          path: '/fixture',
          uploadId: upload.id,
        }),
      ).rejects.toThrow('来源');
    } finally {
      f.switched = false;
      await api.browserFileDiscard({ ...binding, uploadId: upload.id });
    }
  });
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
