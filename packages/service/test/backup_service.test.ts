import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { WeqBackupService } from '../src/bootstrap/backup_service';
import { UserConfigService, DEFAULT_APP_SETTINGS } from '../src/bootstrap/user_config';
import {
  buildWeqBackup,
  readWeqBackup,
  WEQ_BACKUP_LIMITS,
  type WeqBackupFile,
} from '../src/bootstrap/backup_bundle';
import {
  applyPendingWeqBackupRestore,
  pendingWeqClientSettings,
  acknowledgeWeqClientSettings,
  reassignWeqClientSettings,
  skipWeqClientSettings,
} from '../src/bootstrap/backup_restore';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const file = (path: string, value: unknown): WeqBackupFile => ({
  path,
  data: Buffer.from(JSON.stringify(value)),
});
function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-backup-service-'));
  roots.push(root);
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.renderTextMarkdown = false;
  settings.mcp.token = 'synthetic-local-token';
  settings.agentLab.providers = [
    {
      id: 'synthetic-provider',
      name: '合成服务',
      vendor: 'custom',
      baseUrl: 'https://synthetic.invalid',
      apiKey: 'synthetic-api-secret',
      models: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  write(join(root, 'config.json'), { settings, totpSecret: 'synthetic-totp-secret' });
  write(join(root, 'config', 'accounts', '10001.json'), {
    configId: '10001',
    uin: '10001',
    dbKey: 'synthetic-db-key',
    algos: {},
    displayName: '合成账号',
    lastLoginAt: 1,
    qqOnline: true,
    session: { a2: 'synthetic-runtime-ticket', fetchedAt: 1 },
  });
  write(join(root, 'cache', 'agentlab', '10001', 'assistant.json'), {
    customPrompt: '合成助手配置',
  });
  const platform = { appDataRoot: () => root } as Platform;
  const config = new UserConfigService(platform);
  return {
    root,
    platform,
    config,
    service: new WeqBackupService(root, config),
    cache: config.cacheBaseDir(),
  };
}

it('真实 UserConfig 的四分区快照不改原配置，公开清单不回显密钥', () => {
  const f = fixture();
  const before = readFileSync(join(f.root, 'config.json'));
  const inventory = f.service.inventory();
  expect(inventory.accounts).toEqual([
    { configId: '10001', uin: '10001', displayName: '合成账号' },
  ]);
  expect(inventory.cloneScopes).toEqual(['10001']);
  expect(JSON.stringify(inventory)).not.toContain('secret');
  expect(JSON.stringify(inventory)).not.toContain('db-key');
  const result = f.service.snapshot(
    { parts: ['settings', 'api', 'accounts', 'clones'] },
    { 'weq.theme-preference': 'dark' },
  );
  const bundle = readWeqBackup(result.archive);
  expect(result.summary.parts.map((part) => part.part)).toEqual([
    'settings',
    'accounts',
    'api',
    'clones',
  ]);
  expect(JSON.stringify(result.summary)).not.toContain('secret');
  expect(Buffer.concat(bundle.files.map((entry) => entry.data)).toString()).not.toContain(
    'totp-secret',
  );
  expect(Buffer.concat(bundle.files.map((entry) => entry.data)).toString()).not.toContain(
    'runtime-ticket',
  );
  expect(readFileSync(join(f.root, 'config.json'))).toEqual(before);
});

it('未勾选的数据不进入包，也不因未勾选域的旧选择阻止设置备份', () => {
  const f = fixture();
  const result = f.service.snapshot(
    { parts: ['settings'], accountConfigIds: ['99999'], cloneConfigIds: ['99999'] },
    {},
  );
  const bundle = readWeqBackup(result.archive);
  expect(bundle.files.map((entry) => entry.path)).toEqual([
    'settings/app.json',
    'settings/client.json',
    'settings/export-presets.json',
  ]);
  expect(Buffer.concat(bundle.files.map((entry) => entry.data)).toString()).not.toContain(
    'synthetic-api-secret',
  );
  expect(() =>
    f.service.snapshot({ parts: ['accounts'], accountConfigIds: ['99999'] }, {}),
  ).toThrow('变化');
});

it('确认使用冻结的源包与选择；外部缓冲变化和确认后改选不改变恢复目标', () => {
  const f = fixture();
  const archive = buildWeqBackup([
    file('accounts/10001.json', {
      configId: '10001',
      uin: '10001',
      dbKey: 'synthetic-imported-key',
      algos: {},
      lastLoginAt: 2,
      displayName: '导入账号',
    }),
  ]);
  const source = f.service.inspect(archive, 'synthetic.zip');
  archive.fill(0);
  const choice = { parts: ['accounts' as const], conflict: 'skip' as 'skip' | 'overwrite' };
  const preview = f.service.prepare(source.id, choice);
  expect(preview.skipped).toEqual(['account:10001']);
  choice.conflict = 'overwrite';
  f.service.stage(preview.id);
  expect(() => f.service.stage(preview.id)).toThrow('失效');
  expect(applyPendingWeqBackupRestore(f.root, f.cache)?.skipped).toEqual(['account:10001']);
  expect(
    JSON.parse(readFileSync(join(f.root, 'config', 'accounts', '10001.json'), 'utf8')).displayName,
  ).toBe('合成账号');
});

it('不同文件与已关闭预览的迟到确认不能使用别人的新源包', () => {
  const f = fixture();
  const archive = buildWeqBackup([file('settings/app.json', { renderTextMarkdown: true })]);
  const first = f.service.inspect(archive, 'first.zip');
  const preview = f.service.prepare(first.id, { parts: ['settings'], conflict: 'overwrite' });
  const second = f.service.inspect(archive, 'second.zip');
  expect(() => f.service.stage(preview.id)).toThrow('失效');
  f.service.dispose(first.id);
  expect(() =>
    f.service.prepare(second.id, { parts: ['settings'], conflict: 'overwrite' }),
  ).not.toThrow();
  f.service.dispose(second.id);
  expect(() =>
    f.service.prepare(second.id, { parts: ['settings'], conflict: 'overwrite' }),
  ).toThrow('失效');
  expect(f.service.inventory().restore.pending).toBeNull();
});

it('恢复默认偏好需要冷启动，保留 API、账号与本机锁密钥，界面偏好有单独回执', () => {
  const f = fixture();
  const before = f.config.getSettings();
  const upload = f.service.beginUpload('abandoned.zip', 1);
  const result = f.service.stageDefaults();
  expect(() => f.service.finishUpload(upload)).toThrow('失效');
  expect(f.config.getSettings().renderTextMarkdown).toBe(false);
  expect(applyPendingWeqBackupRestore(f.root, f.cache)).toMatchObject({
    status: 'applied',
    clientPending: true,
  });
  const reopened = new UserConfigService(f.platform);
  expect(reopened.getSettings().renderTextMarkdown).toBe(DEFAULT_APP_SETTINGS.renderTextMarkdown);
  expect(reopened.getSettings().agentLab).toEqual(before.agentLab);
  expect(reopened.getSettings().mcp).toEqual(before.mcp);
  expect(reopened.listAccountConfigs()[0]?.dbKey).toBe('synthetic-db-key');
  expect(reopened.getTotpSecret()).toBe('synthetic-totp-secret');
  expect(pendingWeqClientSettings(f.root)).toEqual({ id: result.id, values: {} });
});

it('未选 API 的导入只校验和暂存所选业务数据，不写入未选凭据', () => {
  const f = fixture();
  const source = f.service.inspect(
    buildWeqBackup([
      file('settings/app.json', { renderTextMarkdown: true }),
      file('api/settings.json', {
        agentLab: { providers: [{ apiKey: 'synthetic-not-selected' }] },
      }),
    ]),
    'synthetic.zip',
  );
  const preview = f.service.prepare(source.id, { parts: ['settings'], conflict: 'overwrite' });
  expect(preview.summary.parts.map((part) => part.part)).toEqual(['settings']);
  f.service.stage(preview.id);
  expect(applyPendingWeqBackupRestore(f.root, f.cache)?.status).toBe('applied');
  const reopened = new UserConfigService(f.platform);
  expect(reopened.getSettings().agentLab.providers[0]?.apiKey).toBe('synthetic-api-secret');
});

it('分片上传有界、顺序校验、重复幂等，结束后旧上传与旧预览失效', () => {
  const f = fixture();
  const archive = buildWeqBackup([file('settings/app.json', { renderTextMarkdown: true })]);
  expect(() => f.service.beginUpload('large.zip', WEQ_BACKUP_LIMITS.maxArchiveBytes + 1)).toThrow(
    '大小',
  );
  const id = f.service.beginUpload('synthetic.zip', archive.length);
  expect(() => f.service.finishUpload(id)).toThrow('尚未完成');
  expect(() => f.service.uploadChunk(id, 1, archive.subarray(0, 4).toString('base64'))).toThrow(
    '顺序',
  );
  expect(() => f.service.uploadChunk(id, 0, '%%%%')).toThrow('无效');
  const chunk = archive.subarray(0, 10).toString('base64');
  expect(f.service.uploadChunk(id, 0, chunk)).toBe(10);
  expect(f.service.uploadChunk(id, 0, chunk)).toBe(10);
  expect(() => f.service.uploadChunk(id, 0, Buffer.alloc(10).toString('base64'))).toThrow('顺序');
  f.service.uploadChunk(id, 10, archive.subarray(10).toString('base64'));
  const source = f.service.finishUpload(id);
  const preview = f.service.prepare(source.id, { parts: ['settings'], conflict: 'overwrite' });
  const next = f.service.beginUpload('next.zip', 1);
  expect(() => f.service.stage(preview.id)).toThrow('失效');
  expect(() => f.service.uploadChunk(id, 0, chunk)).toThrow('失效');
  f.service.dispose(next);
  expect(() => f.service.finishUpload(next)).toThrow('失效');
});

it('界面偏好可单独不导出或不导入，不创建待确认回执', () => {
  const f = fixture();
  const snapshot = f.service.snapshot(
    { parts: ['settings'], includeClient: false },
    { unknown: 'ignored' },
  );
  expect(readWeqBackup(snapshot.archive).files.map((entry) => entry.path)).not.toContain(
    'settings/client.json',
  );
  const source = f.service.inspect(
    f.service.snapshot({ parts: ['settings'] }, { 'weq.theme-preference': 'dark' }).archive,
    'synthetic.zip',
  );
  const preview = f.service.prepare(source.id, {
    parts: ['settings'],
    conflict: 'overwrite',
    includeClient: false,
  });
  f.service.stage(preview.id);
  expect(applyPendingWeqBackupRestore(f.root, f.cache)).toMatchObject({
    status: 'applied',
    clientPending: false,
  });
  expect(pendingWeqClientSettings(f.root)).toBeNull();
});

it('界面恢复绑定发起设备；其他设备不能确认，可明确转移或放弃', () => {
  const f = fixture();
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const staged = f.service.stageDefaults(first);
  expect(pendingWeqClientSettings(f.root, first)).toBeNull();
  applyPendingWeqBackupRestore(f.root, f.cache);
  expect(pendingWeqClientSettings(f.root, second)).toBeNull();
  expect(acknowledgeWeqClientSettings(f.root, staged.id, second)).toBe(false);
  expect(reassignWeqClientSettings(f.root, staged.id, second)).toBe(true);
  expect(pendingWeqClientSettings(f.root, first)).toBeNull();
  expect(pendingWeqClientSettings(f.root, second)).toMatchObject({
    id: staged.id,
    clientId: second,
  });
  expect(acknowledgeWeqClientSettings(f.root, staged.id, second)).toBe(true);
  expect(acknowledgeWeqClientSettings(f.root, staged.id, second)).toBe(true);
  const next = f.service.stageDefaults(first);
  applyPendingWeqBackupRestore(f.root, f.cache);
  expect(skipWeqClientSettings(f.root, next.id)).toBe(true);
  expect(skipWeqClientSettings(f.root, next.id)).toBe(true);
  expect(pendingWeqClientSettings(f.root, first)).toBeNull();
  expect(f.service.inventory().restore.result?.warnings).toContain(
    '已选择保留本机界面偏好，未应用包内界面偏好。',
  );
});
