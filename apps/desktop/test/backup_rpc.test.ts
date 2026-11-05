// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  bootstrapWeqBackupFiles,
  applyPendingWeqBackupRestore,
  setHost,
  type HostBridge,
  type WeqFileStartup,
} from '@weq/service';
import { backupProcedures } from '../src/main/ipc/routers/backup';
import { router } from '../src/main/ipc/trpc';

const context = vi.hoisted(() => ({ current: null as WeqFileStartup | null }));
vi.mock('../src/main/context/backup_context', () => ({
  getBackupContext: () => context.current,
  applyLiveBackupContext: () => {
    const files = context.current!;
    const result = applyPendingWeqBackupRestore(files.root, files.cacheRoot);
    if (files.ok) files.config.reload();
    files.result = result;
    return result;
  },
}));
vi.mock('../src/main/context/app_context', () => ({
  retryBackupRecovery: () => true,
  getAppContext: () => ({ bootstrap: null, clearAccount: async () => {} }),
}));
vi.mock('../src/main/ipc/routers/db_repair', () => ({ isDbRepairBusy: () => false }));
vi.mock('../src/main/ipc/routers/intent_sense', () => ({ isIntentModelDownloading: () => false }));
vi.mock('../src/main/weq_assistant/server', () => ({
  assistantResourceServer: { stop: async () => {} },
}));
const roots: string[] = [];
afterEach(() => {
  context.current = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-backup-rpc-'));
  roots.push(root);
  context.current = bootstrapWeqBackupFiles(root);
  const host: HostBridge = {
    canReveal: false,
    canAutostart: false,
    pickDirectory: async () => null,
    pickFile: async () => null,
    pickSaveTarget: async () => ({ path: join(root, 'synthetic.zip'), downloadId: 'synthetic' }),
    registerDownload: () => ({ url: '/synthetic-download' }),
    revealPath: async () => {},
    revealInFolder: async () => {},
    openExternal: async () => {},
    openHtmlReport: async () => null,
    renderHtmlToPdf: async () => Buffer.alloc(0),
    renderHtmlToSlidesPng: async () => [],
    renderHtmlToLongPng: async () => Buffer.alloc(0),
    openBotConsole: async () => null,
    appVersion: () => 'synthetic',
    isPackaged: () => false,
    currentExePath: () => '/synthetic',
  };
  setHost(host);
  const routes = router(backupProcedures);
  return { root, caller: routes.createCaller({}), routes };
}
it('真实备份 RPC 无 Native 可读取、导出、分片导入、预览并直接应用，无待重启任务', async () => {
  const f = fixture();
  expect(await f.caller.backupStartup()).toMatchObject({
    ok: true,
    canRestart: false,
    client: null,
  });
  const output = await f.caller.backupExport({ parts: ['settings'], includeClient: false });
  expect(output).toMatchObject({ downloadUrl: '/synthetic-download' });
  const bytes = readFileSync(join(f.root, 'synthetic.zip'));
  const id = await f.caller.backupBeginUpload({ name: 'synthetic.zip', bytes: bytes.length });
  await f.caller.backupUploadChunk({ id, offset: 0, data: bytes.toString('base64') });
  const source = await f.caller.backupFinishUpload({ id });
  const preview = await f.caller.backupPrepare({
    sourceId: source.id,
    parts: ['settings'],
    conflict: 'overwrite',
  });
  await f.caller.backupStage({ previewId: preview.id });
  const status = await f.caller.backupStatus();
  expect(status.pending).toBeNull();
  expect(status.result?.status).toBe('applied');
  await f.caller.backupCancel();
  expect((await f.caller.backupStatus()).pending).toBeNull();
  await expect(f.caller.backupRestart()).rejects.toThrow('服务管理器');
});
it('备份路由仍执行现有授权中间件，拒绝时不导出任何数据', async () => {
  const f = fixture();
  const caller = f.routes.createCaller({
    authorize: () => {
      throw Error('synthetic-unauthorized');
    },
  });
  await expect(caller.backupInventory()).rejects.toThrow('synthetic-unauthorized');
  await expect(caller.backupExport({ parts: ['api'] })).rejects.toThrow('synthetic-unauthorized');
});
