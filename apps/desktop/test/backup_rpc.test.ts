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
import { backgroundTasks } from '../src/main/background_tasks';
import { procedure, router } from '../src/main/ipc/trpc';
import { runtimeMaintenance, MAINTENANCE_DRAIN_TIMEOUT_MS } from '../src/main/runtime_maintenance';

const context = vi.hoisted(() => ({
  current: null as WeqFileStartup | null,
  closing: vi.fn(async () => {}),
}));
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
  getAppContext: () => ({ bootstrap: null, clearAccount: context.closing }),
}));
vi.mock('../src/main/ipc/routers/db_repair', () => ({ isDbRepairBusy: () => false }));
vi.mock('../src/main/ipc/routers/intent_sense', () => ({ isIntentModelDownloading: () => false }));
vi.mock('../src/main/weq_assistant/server', () => ({
  assistantResourceServer: { stop: async () => {} },
}));
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
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
  return { root, caller: routes.createCaller({}), routes, host };
}
it('恢复默认 RPC 只返回必要确认信息，未选择的自启保持不变', async () => {
  const f = fixture();
  const tasks = backgroundTasks.snapshot();
  const host = {
    ...f.host,
    canAutostart: true,
    getAutostart: vi.fn(async () => ({
      supported: true,
      enabled: true,
      registered: true,
      requiresApproval: false,
    })),
    setAutostart: vi.fn(async () => ({
      supported: true,
      enabled: false,
      registered: false,
      requiresApproval: false,
    })),
  };
  setHost(host);
  const files = context.current!;
  if (!files.ok) throw Error(files.error);
  files.config.setSettings({
    webServiceAutoStart: true,
    showWindowOnAutostart: true,
    mcp: { token: 'synthetic-private-token' },
  });
  const info = await f.caller.backupDefaultsInfo();
  expect(info.connections.map((item) => item.id)).toEqual(
    expect.arrayContaining(['systemAutostart', 'webServiceAutoStart', 'showWindowOnAutostart']),
  );
  expect(JSON.stringify(info)).not.toContain('synthetic-private-token');
  const result = await f.caller.backupDefaults({
    clearApi: true,
    resetConnections: ['showWindowOnAutostart'],
  });
  expect(result.status).toBe('applied');
  expect(backgroundTasks.snapshot()).toEqual(tasks);
  expect(host.setAutostart).not.toHaveBeenCalled();
  expect(files.config.getSettings()).toMatchObject({
    webServiceAutoStart: true,
    showWindowOnAutostart: false,
    mcp: { token: '' },
  });
});

it('恢复默认后系统自启变更失败，返回且持久记录具体未完成项', async () => {
  const f = fixture();
  setHost({
    ...f.host,
    canAutostart: true,
    setAutostart: async () => {
      throw Error('合成系统自启错误');
    },
  });
  const result = await f.caller.backupDefaults({ resetConnections: ['systemAutostart'] });
  expect(result.status).toBe('applied');
  expect(result.warnings.join('；')).toContain('合成系统自启错误');
  expect((await f.caller.backupStatus()).result?.warnings).toEqual(result.warnings);
});
it('账号收尾失败时取消本次暂存，弹窗重试可重新提交而不被旧暂存阻塞', async () => {
  const f = fixture();
  const tasks = backgroundTasks.snapshot();
  const revision = runtimeMaintenance.status().revision;
  context.closing.mockRejectedValueOnce(new Error('合成账号收尾失败'));
  await expect(f.caller.backupDefaults()).rejects.toThrow('合成账号收尾失败');
  expect(runtimeMaintenance.status().revision).toBe(revision);
  expect((await f.caller.backupStatus()).pending).toBeNull();
  expect((await f.caller.backupDefaults()).status).toBe('applied');
  expect(backgroundTasks.snapshot()).toEqual(tasks);
});
it('恢复默认等待旧请求超时后返回错误，不暂存、不关闭账号，旧请求结束后可重试', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let release!: () => void;
  const caller = router({
    account: router({
      pendingRead: procedure.query(() => new Promise<void>((resolve) => (release = resolve))),
    }),
    bootstrap: f.routes,
  }).createCaller({});
  const old = caller.account.pendingRead();
  await vi.advanceTimersByTimeAsync(0);
  const revision = runtimeMaintenance.status().revision;
  const failed = expect(caller.bootstrap.backupDefaults()).rejects.toThrow('account.pendingRead');
  await vi.advanceTimersByTimeAsync(MAINTENANCE_DRAIN_TIMEOUT_MS);
  await failed;
  expect(context.closing).not.toHaveBeenCalled();
  expect(runtimeMaintenance.status()).toMatchObject({ state: 'ready', revision });
  expect((await f.caller.backupStatus()).pending).toBeNull();
  release();
  await old;
  expect((await f.caller.backupDefaults()).status).toBe('applied');
});
it('真实备份 RPC 无 Native 可读取、导出、分片导入、预览并直接应用，无待重启任务', async () => {
  const f = fixture();
  const tasks = backgroundTasks.snapshot();
  expect(await f.caller.backupDefaultsInfo()).toEqual({
    hasApi: false,
    paths: [],
    connections: [],
  });
  expect(await f.caller.backupStartup()).toMatchObject({
    ok: true,
    canRestart: false,
    client: null,
  });
  const output = await f.caller.backupExport({ parts: ['settings'], includeClient: false });
  expect(output).toMatchObject({ downloadUrl: '/synthetic-download' });
  const bytes = readFileSync(join(f.root, 'synthetic.zip'));
  setHost({ ...f.host, pickFile: async () => join(f.root, 'synthetic.zip') });
  expect(await f.caller.backupPick()).toMatchObject({ name: 'synthetic.zip' });
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
  expect(backgroundTasks.snapshot()).toEqual(tasks);
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
