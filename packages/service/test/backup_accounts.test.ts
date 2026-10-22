import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { AgentLabStore } from '@weq/agentlab';
import { accountConfigId } from '../src/account/user_config';
import { DressConfigService } from '../src/account/dress_config';
import { DbToleranceService } from '../src/account/db_tolerance';
import { IntentSenseService } from '../src/account/intent_sense';
import { UserConfigService, DEFAULT_APP_SETTINGS } from '../src/bootstrap/user_config';
import { WeqBackupService } from '../src/bootstrap/backup_service';
import { buildWeqBackup, readWeqBackup } from '../src/bootstrap/backup_bundle';
import {
  applyPendingWeqBackupRestore,
  stageWeqBackupRestore,
} from '../src/bootstrap/backup_restore';
import {
  snapshotWeqAccountPreferences,
  validateWeqAccountPreference,
  weqAccountSettingPath,
} from '../src/bootstrap/backup_accounts';
import { makeBackupPersona } from './fixtures/backup_persona';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-backup-account-'));
  roots.push(root);
  const cache = join(root, 'cache'),
    sourceDir = join(root, 'synthetic-source-qq'),
    localDir = join(root, 'synthetic-local-qq');
  const source = accountConfigId('10001', sourceDir),
    local = accountConfigId('10001', localDir);
  const incoming = {
    configId: source,
    uin: '10001',
    dbKey: 'synthetic-source-key',
    algos: {},
    dataDir: sourceDir,
    lastLoginAt: 1,
    mailNotifications: true,
  };
  const existing = {
    configId: local,
    uin: '10001',
    uid: 'u_synthetic',
    dbKey: 'synthetic-local-key',
    algos: { 'nt_msg.db': { pageHmacAlgorithm: 'HMAC_SHA1', kdfHmacAlgorithm: 'HMAC_SHA256' } },
    dataDir: localDir,
    static: true,
    lastLoginAt: 2,
    mailNotifications: false,
    groupKeyword: { '12345': { keywords: [{ keyword: '旧偏好', memberUids: [] }] } },
    session: { a2: 'synthetic-local-runtime', fetchedAt: 1 },
  };
  write(join(root, 'config.json'), {
    settings: structuredClone(DEFAULT_APP_SETTINGS),
    totpSecret: 'synthetic-local-secret',
  });
  write(join(root, 'config', 'accounts', `${source}.json`), incoming);
  write(join(root, 'config', 'accounts', `${local}.json`), existing);
  mkdirSync(localDir);
  writeFileSync(join(localDir, 'nt_msg.db'), 'synthetic original QQ bytes');
  const config = new UserConfigService({ appDataRoot: () => root } as Platform);
  return {
    root,
    cache,
    source,
    local,
    sourceDir,
    localDir,
    incoming,
    existing,
    config,
    service: new WeqBackupService(root, config),
  };
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJRkAAAAASUVORK5CYII=',
  'base64',
);

it('账号偏好按真实文件收集，自定义背景改为便携名，原配置与素材不被改写', async () => {
  const f = fixture();
  const intent = new IntentSenseService(
    {} as AccountSession,
    join(f.cache, 'intent_sense', f.source),
  );
  await intent.setConfig({
    enabled: true,
    engine: 'api',
    providerRef: { providerId: 'synthetic', model: 'synthetic' },
    analysisTemperature: 0.3,
    suggestionsEnabled: true,
  });
  new DbToleranceService(
    weqAccountSettingPath(f.root, f.cache, f.source, 'tolerance.json'),
  ).setLevel(1, 'synthetic');
  const antiRecall = {
    enabled: true,
    mode: 'selected',
    targets: [{ kind: 'group', id: '12345' }],
    notifyEnabled: true,
    notifyTargets: ['group:12345'],
  };
  write(weqAccountSettingPath(f.root, f.cache, f.source, 'anti-recall.json'), antiRecall);
  const outside = join(f.root, '合成 背景.png');
  writeFileSync(outside, png);
  const dress = new DressConfigService(join(f.root, 'config', 'accounts', f.source));
  dress.setCustomBackground(outside);
  dress.setBackgroundOpacity(0.4);
  dress.setActive('bubble', 123);
  const original = readFileSync(weqAccountSettingPath(f.root, f.cache, f.source, 'dress.json'));
  const snapshot = f.service.snapshot({ parts: ['accounts'], accountConfigIds: [f.source] }, {});
  const bundle = readWeqBackup(snapshot.archive);
  expect(bundle.files).toHaveLength(6);
  expect(snapshot.summary.accountConfigIds).toEqual([f.source]);
  expect(readFileSync(weqAccountSettingPath(f.root, f.cache, f.source, 'dress.json'))).toEqual(
    original,
  );
  expect(readFileSync(outside)).toEqual(png);
  const src = f.service.inspect(snapshot.archive, 'synthetic.zip');
  const preview = f.service.prepare(src.id, {
    parts: ['accounts'],
    conflict: 'overwrite',
    scopeMap: { [f.source]: f.local },
  });
  expect(preview.warnings.join(' ')).toContain('保留本机接入信息');
  f.service.stage(preview.id);
  expect(applyPendingWeqBackupRestore(f.root, f.cache)?.status).toBe('applied');
  const restored = JSON.parse(
    readFileSync(join(f.root, 'config', 'accounts', `${f.local}.json`), 'utf8'),
  );
  expect(restored).toMatchObject({
    configId: f.local,
    dbKey: f.existing.dbKey,
    algos: f.existing.algos,
    dataDir: f.localDir,
    static: true,
    session: f.existing.session,
    mailNotifications: true,
  });
  expect(restored.groupKeyword).toBeUndefined();
  expect(
    new IntentSenseService(
      {} as AccountSession,
      join(f.cache, 'intent_sense', f.local),
    ).getStatus(),
  ).toMatchObject({ enabled: true, analysisTemperature: 0.3 });
  expect(
    new DbToleranceService(
      weqAccountSettingPath(f.root, f.cache, f.local, 'tolerance.json'),
    ).getConfig().level,
  ).toBe(1);
  expect(
    JSON.parse(
      readFileSync(weqAccountSettingPath(f.root, f.cache, f.local, 'anti-recall.json'), 'utf8'),
    ),
  ).toEqual(antiRecall);
  const restoredDress = new DressConfigService(join(f.root, 'config', 'accounts', f.local));
  expect(restoredDress.read()).toMatchObject({
    background: 'custom',
    activeBubble: 123,
    backgroundOpacity: 0.4,
  });
  expect(restoredDress.getBackgroundFile()).toMatch(/bg-[0-9a-f]{64}\.png$/);
  expect(readFileSync(restoredDress.getBackgroundFile()!)).toEqual(png);
  expect(readFileSync(join(f.localDir, 'nt_msg.db'), 'utf8')).toBe('synthetic original QQ bytes');
});

it('实际应用的账号模型引用与 QQ 装扮资源缺失会提示，跳过该域不产生误告警', () => {
  const f = fixture();
  const archive = buildWeqBackup([
    { path: `accounts/${f.source}.json`, data: Buffer.from(JSON.stringify(f.incoming)) },
    {
      path: `accounts/${f.source}/intent.json`,
      data: Buffer.from(
        JSON.stringify({
          providerRef: { providerId: 'missing-synthetic', model: 'synthetic-model' },
        }),
      ),
    },
    {
      path: `accounts/${f.source}/dress.json`,
      data: Buffer.from(JSON.stringify({ installedFonts: [1] })),
    },
  ]);
  const source = f.service.inspect(archive, 'synthetic.zip');
  const preview = f.service.prepare(source.id, { parts: ['accounts'], conflict: 'overwrite' });
  expect(preview.warnings.some((warning) => warning.includes('意图／画像／推荐回复'))).toBe(true);
  expect(preview.warnings.some((warning) => warning.includes('装扮选择'))).toBe(true);
  const skipped = f.service.prepare(source.id, { parts: ['accounts'], conflict: 'skip' });
  expect(
    skipped.warnings.some(
      (warning) => warning.includes('意图／画像／推荐回复') || warning.includes('装扮选择'),
    ),
  ).toBe(false);
});

it('缺失偏好也作为默认值备份，覆盖时可恢复真正的默认账号设置', () => {
  const f = fixture();
  const snapshot = snapshotWeqAccountPreferences(f.root, f.cache, f.source);
  expect(snapshot.files).toHaveLength(4);
  for (const file of snapshot.files) expect(JSON.parse(file.data.toString())).toEqual({});
});

it('克隆数据域映射后实际本机账号能读取导入 persona，原域与 QQ 原件不动', () => {
  const f = fixture(),
    persona = makeBackupPersona();
  new AgentLabStore(join(f.cache, 'agentlab', f.source)).savePersona({ persona, pairs: [] });
  const snapshot = f.service.snapshot({ parts: ['clones'], cloneConfigIds: [f.source] }, {});
  const src = f.service.inspect(snapshot.archive, 'synthetic.zip');
  f.service.stage(
    f.service.prepare(src.id, {
      parts: ['clones'],
      conflict: 'overwrite',
      scopeMap: { [f.source]: f.local },
    }).id,
  );
  expect(applyPendingWeqBackupRestore(f.root, f.cache)?.status).toBe('applied');
  expect(
    new AgentLabStore(join(f.cache, 'agentlab', f.local)).getPersona(persona.id)?.persona,
  ).toEqual(persona);
  expect(
    new AgentLabStore(join(f.cache, 'agentlab', f.source)).getPersona(persona.id)?.persona,
  ).toEqual(persona);
  expect(
    JSON.parse(readFileSync(join(f.root, 'config', 'accounts', `${f.local}.json`), 'utf8')),
  ).toEqual(f.existing);
});

it('跳过策略以整个账号偏好域处理，不只保留账号接入记录却覆盖偏好', () => {
  const f = fixture();
  const old = { enabled: false, analysisTemperature: 0.9 };
  write(weqAccountSettingPath(f.root, f.cache, f.local, 'intent.json'), old);
  write(weqAccountSettingPath(f.root, f.cache, f.source, 'intent.json'), {
    enabled: true,
    analysisTemperature: 0.3,
  });
  const snap = f.service.snapshot({ parts: ['accounts'], accountConfigIds: [f.source] }, {});
  stageWeqBackupRestore(f.root, snap.archive, {
    parts: ['accounts'],
    conflict: 'skip',
    scopeMap: { [f.source]: f.local },
  });
  expect(applyPendingWeqBackupRestore(f.root, f.cache)?.skipped).toContain(`account:${f.local}`);
  expect(
    JSON.parse(
      readFileSync(weqAccountSettingPath(f.root, f.cache, f.local, 'intent.json'), 'utf8'),
    ),
  ).toEqual(old);
});

it('跨 QQ 号、目标不存在和多个来源同目标的映射都在写入前拒绝', () => {
  const f = fixture();
  const snapshot = f.service.snapshot({ parts: ['accounts'], accountConfigIds: [f.source] }, {});
  for (const target of ['10002', '10001_deadbeef'])
    expect(() =>
      stageWeqBackupRestore(f.root, snapshot.archive, {
        parts: ['accounts'],
        conflict: 'overwrite',
        scopeMap: { [f.source]: target },
      }),
    ).toThrow();
  const both = f.service.snapshot(
    { parts: ['accounts'], accountConfigIds: [f.source, f.local] },
    {},
  );
  expect(() =>
    stageWeqBackupRestore(f.root, both.archive, {
      parts: ['accounts'],
      conflict: 'overwrite',
      scopeMap: { [f.source]: f.local },
    }),
  ).toThrow('多个来源');
  expect(existsSync(join(f.root, 'restore', 'pending.json'))).toBe(false);
});

it('普通导入默认保留本机保存位置和图片目录，明确选择后才还原源路径', () => {
  for (const keepLocalPaths of [true, false]) {
    const f = fixture();
    f.config.setSettings({
      defaultExportDir: '/synthetic/local-exports',
      exportSaveMode: 'preset',
      externalChatpic: { dir: '/synthetic/local-pictures', enabled: false },
    });
    const data = buildWeqBackup([
      {
        path: 'settings/app.json',
        data: Buffer.from(
          JSON.stringify({
            defaultExportDir: '/synthetic/source-exports',
            exportSaveMode: 'after',
            externalChatpic: { dir: '/synthetic/source-pictures', enabled: true },
          }),
        ),
      },
    ]);
    stageWeqBackupRestore(f.root, data, {
      parts: ['settings'],
      conflict: 'overwrite',
      keepLocalPaths,
    });
    expect(applyPendingWeqBackupRestore(f.root, f.cache)?.status).toBe('applied');
    expect(
      new UserConfigService({ appDataRoot: () => f.root } as Platform).getSettings(),
    ).toMatchObject({
      defaultExportDir: keepLocalPaths ? '/synthetic/local-exports' : '/synthetic/source-exports',
      exportSaveMode: keepLocalPaths ? 'preset' : 'after',
      externalChatpic: {
        dir: keepLocalPaths ? '/synthetic/local-pictures' : '/synthetic/source-pictures',
        enabled: true,
      },
    });
  }
});

it.each([
  ['intent.json', { analysisTemperature: 8 }],
  ['intent.json', { conversationOverrides: { group: 'true' } }],
  ['anti-recall.json', { targets: [{ kind: 'unknown', id: '1' }] }],
  ['tolerance.json', { level: '2' }],
  ['dress.json', { backgroundFile: '../../nt_msg.db' }],
  ['dress.json', { backgroundOpacity: 3 }],
] as const)('拒绝无效账号偏好 %s：%j', (name, value) => {
  expect(() => validateWeqAccountPreference(name, value)).toThrow();
});
