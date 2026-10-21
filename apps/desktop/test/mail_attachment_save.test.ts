import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportTaskManager, type MsgService } from '@weq/service';
import { MailFailure } from '@weq/service/mail';
import { mailRouter } from '../src/main/ipc/routers/mail';

const state = vi.hoisted(() => ({ configId: 'source-a', services: {} as object }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ account: { context: { uin: '10001' } }, services: state.services }),
}));
const attachmentId = '11111111-1111-4111-8111-111111111111';
const input = { selfUin: '10001', expectedAccountConfigId: 'source-a', id: attachmentId };
const attachment = { name: '合成附件.TXT', size: 7, available: true };
const download = vi.fn(async (_id: string, path: string, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  writeFileSync(path, 'fixture');
});
let root: string, manager: ExportTaskManager;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'weq-mail-save-'));
  manager = new ExportTaskManager({} as MsgService, join(root, 'cache'));
  state.configId = 'source-a';
  attachment.name = '合成附件.TXT';
  download.mockClear();
  state.services = {
    accountConfig: { getRecord: () => ({ configId: state.configId }) },
    exportManager: manager,
    mail: {
      attachments: {
        get: (id: string) => {
          if (id !== attachmentId) throw new MailFailure('business', '附件已失效');
          return attachment;
        },
      },
      download,
    },
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('附件令牌固定身份，按原扩展名保存且不覆盖同名文件', async () => {
  const target = join(root, attachment.name);
  writeFileSync(target, 'personal');
  const id = await mailRouter.createCaller({}).saveAttachment({
    ...input,
    savePolicy: { mode: 'preset', filePath: target, uniqueFileName: true },
  });
  await vi.waitFor(() => expect(manager.getTask(id)?.save?.status).toBe('saved'));
  const task = manager.getTask(id)!;
  expect(task.resource?.output).toEqual({ kind: 'file', name: '合成附件', extension: 'TXT' });
  expect(download.mock.calls[0]![0]).toBe(attachmentId);
  expect(readFileSync(task.save!.path!, 'utf8')).toBe('fixture');
  expect(readFileSync(target, 'utf8')).toBe('personal');
});
it('整封邮件复用公共目录任务，旧来源不入队，完成后保留正文与元数据', async () => {
  const read = vi.fn(async () => ({
    id: 'mail-fixture',
    subject: '合成邮件',
    html: '<p>正文</p>',
    attachments: [],
    unread: true,
  }));
  Object.assign((state.services as { mail: object }).mail, { read });
  const api = mailRouter.createCaller({});
  await expect(
    api.exportMessages({
      selfUin: '10001',
      expectedAccountConfigId: 'wrong',
      ids: ['mail-fixture'],
      savePolicy: { mode: 'after' },
    }),
  ).rejects.toThrow('数据源已切换');
  const id = await api.exportMessages({
    selfUin: '10001',
    expectedAccountConfigId: 'source-a',
    ids: ['mail-fixture'],
    savePolicy: { mode: 'after' },
  });
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('completed'));
  const task = manager.getTask(id)!;
  expect(task.resource?.kind).toBe('mail-messages');
  const entries = JSON.parse(readFileSync(join(task.bundleDir!, 'files', 'index.json'), 'utf8'));
  expect(
    readFileSync(join(task.bundleDir!, 'files', entries[0].directory, 'body.html'), 'utf8'),
  ).toContain('正文');
  expect(read).toHaveBeenCalledWith('mail-fixture', expect.any(AbortSignal), false);
});
it('无扩展名附件保持真实单文件，不补 bin 或 json 后缀', async () => {
  attachment.name = 'README';
  const id = await mailRouter
    .createCaller({})
    .saveAttachment({ ...input, savePolicy: { mode: 'after' } });
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('completed'));
  const task = manager.getTask(id)!;
  expect(task.resource?.output).toEqual({ kind: 'file', name: 'README', extension: '' });
  expect(task.filePath?.endsWith('/README')).toBe(true);
  expect(task.bundleDir).toBeUndefined();
  expect(task.save?.status).toBe('pending');
});
it('失效令牌和旧来源不创建任务', async () => {
  await expect(
    mailRouter.createCaller({}).saveAttachment({
      ...input,
      id: '22222222-2222-4222-8222-222222222222',
      savePolicy: { mode: 'after' },
    }),
  ).rejects.toThrow('已失效');
  state.configId = 'source-b';
  await expect(
    mailRouter.createCaller({}).saveAttachment({ ...input, savePolicy: { mode: 'after' } }),
  ).rejects.toThrow('数据源已切换');
  expect(manager.listTasks()).toEqual([]);
  expect(download).not.toHaveBeenCalled();
});
it('下载中切换来源不发布旧结果，底层异常不泄露票据', async () => {
  download.mockImplementationOnce(async (_id, path) => {
    writeFileSync(path, 'fixture');
    state.configId = 'source-b';
  });
  const api = mailRouter.createCaller({});
  const id = await api.saveAttachment({ ...input, savePolicy: { mode: 'after' } });
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('failed'));
  expect(manager.getTask(id)?.filePath).toBeUndefined();
  state.configId = 'source-a';
  download.mockRejectedValueOnce(new Error('sid=synthetic-secret'));
  const failed = await api.saveAttachment({ ...input, savePolicy: { mode: 'after' } });
  await vi.waitFor(() => expect(manager.getTask(failed)?.status).toBe('failed'));
  expect(manager.getTask(failed)?.error).not.toContain('synthetic-secret');
});
it('公共任务取消中止原下载，不把半成品标为已保存', async () => {
  let active: AbortSignal | undefined;
  download.mockImplementationOnce(async (_id, _path, signal) => {
    active = signal;
    await new Promise<void>((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(new MailFailure('business', '已取消')), {
        once: true,
      }),
    );
  });
  const id = await mailRouter
    .createCaller({})
    .saveAttachment({ ...input, savePolicy: { mode: 'after' } });
  await vi.waitFor(() => expect(active).toBeDefined());
  manager.cancelTask(id);
  await vi.waitFor(() => expect(manager.getTask(id)?.error).toContain('中断'));
  expect(active?.aborted).toBe(true);
  expect(manager.getTask(id)?.filePath).toBeUndefined();
  expect(manager.getTask(id)?.save?.status).not.toBe('saved');
});
