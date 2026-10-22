import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { makeBackupPersona as persona } from './fixtures/backup_persona';
import { AgentLabStore } from '@weq/agentlab';
import { ConversationStore } from '../src/account/agentlab_conversation';
import { MemoryStore } from '../src/account/agentlab_memory';
import { NotesStore } from '../src/account/agentlab_notes';
import { JsonGroupStore } from '../src/account/agentlab_group_store';
import { JsonRelationStore } from '../src/account/agentlab_relation_store';
import {
  AgentLabSessionStore,
  AgentLabGroupSessionMessageStore,
} from '../src/account/agentlab_session';
import { TokenUsageStore } from '../src/account/agentlab_usage';
import { AssistantService } from '../src/account/assistant';
import { snapshotWeqClones } from '../src/bootstrap/backup_clones';
import { buildWeqBackup, type WeqBackupFile } from '../src/bootstrap/backup_bundle';
import { DEFAULT_APP_SETTINGS } from '../src/bootstrap/user_config';
import { snapshotWeqApiSettings } from '../src/bootstrap/backup_settings';
import { bootstrapWeqBackupFiles } from '../src/bootstrap/backup_startup';
import {
  stageWeqBackupRestore,
  applyPendingWeqBackupRestore,
  cancelWeqBackupRestore,
  weqBackupRestoreStatus,
  pendingWeqClientSettings,
  acknowledgeWeqClientSettings,
} from '../src/bootstrap/backup_restore';

const faults = vi.hoisted(() => ({
  rename: null as ((from: string, to: string) => void) | null,
  remove: null as ((path: string) => void) | null,
  corruptBuffer: false,
}));
vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...real,
    renameSync: ((from, to) => {
      faults.rename?.(String(from).split('\\').join('/'), String(to).split('\\').join('/'));
      real.renameSync(from, to);
    }) as typeof real.renameSync,
    rmSync: ((path, options) => {
      faults.remove?.(String(path));
      real.rmSync(path, options);
    }) as typeof real.rmSync,
    writeFileSync: ((path, data, options) => {
      if (faults.corruptBuffer && Buffer.isBuffer(data)) {
        faults.corruptBuffer = false;
        const corrupt = Buffer.from(data);
        corrupt[0] = corrupt[0]! ^ 1;
        real.writeFileSync(path, corrupt, options);
      } else real.writeFileSync(path, data, options);
    }) as typeof real.writeFileSync,
  };
});
const roots: string[] = [];
afterEach(() => {
  faults.rename = null;
  faults.remove = null;
  faults.corruptBuffer = false;
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
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-backup-restore-'));
  roots.push(root);
  const cache = join(root, 'cache');
  mkdirSync(cache);
  const initial = {
    totpSecret: 'synthetic-local-totp',
    cacheDirOverride: cache,
    tencentFilesRootOverride: '/synthetic/local/qq',
    welcomePolicyVersion: 3,
    settings: {
      ...structuredClone(DEFAULT_APP_SETTINGS),
      renderTextMarkdown: true,
      mcp: { enabled: false, port: 48765, token: 'synthetic-local-mcp' },
    },
  };
  write(join(root, 'config.json'), initial);
  return {
    root,
    cache,
    initial,
    account: (id: string) => join(root, 'config', 'accounts', `${id}.json`),
    clone: (id: string) => join(cache, 'agentlab', id),
  };
}
function account(id: string, name: string) {
  return {
    configId: id,
    uin: id.split('_')[0],
    dbKey: 'synthetic-db-key',
    algos: {},
    lastLoginAt: 1,
    displayName: name,
  };
}
it('暂存不会修改运行数据；冷启动只恢复所选偏好并保留锁密钥、路径和 API', () => {
  const f = fixture();
  const archive = buildWeqBackup([
    file('settings/app.json', { renderTextMarkdown: false, toastDurations: { successSeconds: 2 } }),
    file('settings/client.json', { 'weq.theme-preference': 'dark' }),
  ]);
  const staged = stageWeqBackupRestore(f.root, archive, {
    parts: ['settings'],
    conflict: 'overwrite',
  });
  expect(read(join(f.root, 'config.json'))).toEqual(f.initial);
  expect(weqBackupRestoreStatus(f.root).pending?.id).toBe(staged.id);
  const result = applyPendingWeqBackupRestore(f.root, f.cache);
  expect(result).toMatchObject({ status: 'applied', clientPending: true });
  const config = read(join(f.root, 'config.json'));
  expect(config).toMatchObject({
    totpSecret: f.initial.totpSecret,
    cacheDirOverride: f.cache,
    tencentFilesRootOverride: f.initial.tencentFilesRootOverride,
    settings: {
      renderTextMarkdown: false,
      toastDurations: { successSeconds: 2 },
      mcp: f.initial.settings.mcp,
    },
  });
  expect(weqBackupRestoreStatus(f.root).pending).toBeNull();
  expect(pendingWeqClientSettings(f.root)).toEqual({
    id: staged.id,
    values: { 'weq.theme-preference': 'dark' },
  });
  expect(acknowledgeWeqClientSettings(f.root, 'not-the-request')).toBe(false);
  expect(pendingWeqClientSettings(f.root)).not.toBeNull();
  expect(acknowledgeWeqClientSettings(f.root, staged.id)).toBe(true);
  expect(acknowledgeWeqClientSettings(f.root, staged.id)).toBe(true);
  expect(weqBackupRestoreStatus(f.root).result?.clientPending).toBe(false);
  expect(pendingWeqClientSettings(f.root)).toBeNull();
  expect(applyPendingWeqBackupRestore(f.root, f.cache)).toBeNull();
});

it.each(['skip', 'overwrite'] as const)('账号冲突采用 %s，原 QQ 文件不被复制或改写', (conflict) => {
  const f = fixture();
  const original = account('10001', '本机账号');
  write(f.account('10001'), original);
  const qq = join(f.root, 'synthetic-qq-original', 'nt_msg.db');
  mkdirSync(dirname(qq));
  writeFileSync(qq, 'synthetic QQ original bytes');
  const imported = {
    ...account('10001', '导入账号'),
    dataDir: dirname(qq),
    qqOnline: true,
    qqPid: 1234,
    session: { a2: 'synthetic-runtime', fetchedAt: 1 },
  };
  stageWeqBackupRestore(f.root, buildWeqBackup([file('accounts/10001.json', imported)]), {
    parts: ['accounts'],
    conflict,
  });
  expect(read(f.account('10001'))).toEqual(original);
  const result = applyPendingWeqBackupRestore(f.root, f.cache)!;
  expect(result.status).toBe('applied');
  if (conflict === 'skip') {
    expect(read(f.account('10001'))).toEqual(original);
    expect(result.skipped).toEqual(['account:10001']);
  } else {
    expect(read(f.account('10001'))).toMatchObject({
      displayName: '导入账号',
      dataDir: dirname(qq),
    });
    expect(Object.hasOwn(read(f.account('10001')), 'session')).toBe(false);
  }
  expect(readFileSync(qq, 'utf8')).toBe('synthetic QQ original bytes');
});

it('替换自动进入目标的账号配置时清除旧自动进入，不自动打开新的来源', () => {
  const f = fixture();
  write(join(f.root, 'config.json'), {
    ...f.initial,
    autoEnter: { configId: '10001', uin: '10001', dataDir: '/synthetic/old' },
  });
  stageWeqBackupRestore(
    f.root,
    buildWeqBackup([file('accounts/10001.json', account('10001', '导入账号'))]),
    { parts: ['accounts'], conflict: 'overwrite' },
  );
  expect(applyPendingWeqBackupRestore(f.root, f.cache)?.status).toBe('applied');
  expect(read(join(f.root, 'config.json')).autoEnter).toBeNull();
});

it.each(['skip', 'overwrite'] as const)(
  'API 按稳定 ID %s 合并，同名不同 ID 不覆盖，TTS 位于真实设置字段',
  (conflict) => {
    const f = fixture();
    const existing = {
      id: 'shared-id',
      name: '同名服务',
      vendor: 'custom',
      baseUrl: 'https://old.invalid',
      apiKey: 'synthetic-old-key',
      models: [{ id: 'model', capabilities: ['chat'] }],
      createdAt: 1,
      updatedAt: 1,
    };
    write(join(f.root, 'config.json'), {
      ...f.initial,
      settings: { ...f.initial.settings, agentLab: { providers: [existing] } },
    });
    const value = structuredClone(DEFAULT_APP_SETTINGS);
    value.agentLab.providers = [
      { ...existing, apiKey: 'synthetic-imported-key' },
      { ...existing, id: 'new-id' },
    ];
    value.voiceTranscribe.ttsProviders = [
      {
        id: 'voice',
        name: '合成语音',
        vendor: 'cosyvoice',
        baseUrl: 'https://voice.invalid',
        apiKey: 'synthetic-voice',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const api = snapshotWeqApiSettings(value);
    stageWeqBackupRestore(f.root, buildWeqBackup([file('api/settings.json', api)]), {
      parts: ['api'],
      conflict,
    });
    const result = applyPendingWeqBackupRestore(f.root, f.cache)!;
    expect(result.status).toBe('applied');
    const config = read(join(f.root, 'config.json')) as unknown as {
      settings: typeof DEFAULT_APP_SETTINGS;
      totpSecret: string;
    };
    expect(config.settings.agentLab.providers).toHaveLength(2);
    expect(config.settings.agentLab.providers.find((row) => row.id === 'shared-id')?.apiKey).toBe(
      conflict === 'skip' ? existing.apiKey : 'synthetic-imported-key',
    );
    expect(config.settings.voiceTranscribe.ttsProviders).toEqual(api.ttsProviders);
    expect(Object.hasOwn(config.settings, 'ttsProviders')).toBe(false);
    expect(config.totpSecret).toBe(f.initial.totpSecret);
    if (conflict === 'skip') {
      expect(config.settings.mcp).toEqual(f.initial.settings.mcp);
      expect(result.skipped).toContain('api:llm:shared-id');
    }
  },
);

it('完整克隆桶冷启动替换，实际 Persona 与 Conversation Store 读取导入值', () => {
  const f = fixture();
  write(join(f.clone('10001'), 'old-persona.json'), { original: '保留至提交成功' });
  const imported = persona();
  const archive = buildWeqBackup([
    file('clones/10001/synthetic-persona.json', { persona: imported, pairs: [] }),
    file('clones/10001/conversations.json', {
      'synthetic-persona': [{ role: 'user', text: '导入的对话', ts: 1 }],
    }),
    file('clones/10001/assistant.json', { customPrompt: '合成助手配置' }),
    file('clones/10001/assistant_sessions.json', []),
  ]);
  stageWeqBackupRestore(f.root, archive, { parts: ['clones'], conflict: 'overwrite' });
  expect(existsSync(join(f.clone('10001'), 'old-persona.json'))).toBe(true);
  expect(applyPendingWeqBackupRestore(f.root, f.cache)?.status).toBe('applied');
  expect(new AgentLabStore(f.clone('10001')).getPersona(imported.id)?.persona).toEqual(imported);
  expect(
    new ConversationStore(join(f.clone('10001'), 'conversations.json'))
      .get(imported.id)
      .map((turn) => turn.text),
  ).toEqual(['导入的对话']);
  expect(existsSync(join(f.clone('10001'), 'old-persona.json'))).toBe(false);
});

it('替换中途失败完整回滚，不把计划中的条目计作已恢复', () => {
  const f = fixture();
  const original = account('10001', '本机账号');
  write(f.account('10001'), original);
  const archive = buildWeqBackup([
    file('settings/app.json', { renderTextMarkdown: false }),
    file('accounts/10001.json', account('10001', '导入账号')),
  ]);
  stageWeqBackupRestore(f.root, archive, {
    parts: ['settings', 'accounts'],
    conflict: 'overwrite',
  });
  faults.rename = (from, to) => {
    if (from.endsWith('/next') && to.endsWith('/config.json')) throw Error('合成写入故障');
  };
  const result = applyPendingWeqBackupRestore(f.root, f.cache)!;
  expect(result).toMatchObject({ status: 'failed', applied: [], error: '合成写入故障' });
  expect(result.needsRecovery).not.toBe(true);
  expect(read(f.account('10001'))).toEqual(original);
  expect(read(join(f.root, 'config.json'))).toEqual(f.initial);
  faults.rename = null;
  cancelWeqBackupRestore(f.root, f.cache);
  expect(weqBackupRestoreStatus(f.root).pending).toBeNull();
});

it('中断留下原目录时不能丢弃，重新读取持久事务后可恢复旧数据', () => {
  const f = fixture();
  const old = account('10001', '本机账号');
  write(f.account('10001'), old);
  stageWeqBackupRestore(
    f.root,
    buildWeqBackup([
      file('settings/app.json', { renderTextMarkdown: false }),
      file('accounts/10001.json', account('10001', '新账号')),
    ]),
    { parts: ['settings', 'accounts'], conflict: 'overwrite' },
  );
  faults.rename = (from, to) => {
    if ((from.endsWith('/next') && to.endsWith('/config.json')) || from.endsWith('/before'))
      throw Error('合成中断与回滚受阻');
  };
  expect(applyPendingWeqBackupRestore(f.root, f.cache)).toMatchObject({
    status: 'failed',
    needsRecovery: true,
  });
  expect(() => cancelWeqBackupRestore(f.root, f.cache)).toThrow('事务');
  expect(bootstrapWeqBackupFiles(f.root)).toMatchObject({
    ok: false,
    config: null,
    backups: null,
    result: { needsRecovery: true },
  });
  faults.rename = null;
  expect(applyPendingWeqBackupRestore(f.root, f.cache)).toMatchObject({
    status: 'failed',
    needsRecovery: false,
  });
  expect(read(f.account('10001'))).toEqual(old);
  expect(read(join(f.root, 'config.json'))).toEqual(f.initial);
  cancelWeqBackupRestore(f.root, f.cache);
  expect(weqBackupRestoreStatus(f.root).pending).toBeNull();
});

it('外置缓存配置在中断时已被移至原件区，文件启动仍能找到原缓存并完成回滚', () => {
  const f = fixture(),
    cache = join(f.root, 'synthetic-custom-cache');
  mkdirSync(cache);
  const original = { ...f.initial, cacheDirOverride: cache };
  write(join(f.root, 'config.json'), original);
  stageWeqBackupRestore(
    f.root,
    buildWeqBackup([file('settings/app.json', { renderTextMarkdown: false })]),
    { parts: ['settings'], conflict: 'overwrite' },
  );
  faults.rename = (from, to) => {
    if ((from.endsWith('/next') && to.endsWith('/config.json')) || from.endsWith('/before'))
      throw Error('合成中断');
  };
  expect(applyPendingWeqBackupRestore(f.root, cache)).toMatchObject({ needsRecovery: true });
  expect(existsSync(join(f.root, 'config.json'))).toBe(false);
  faults.rename = null;
  const started = bootstrapWeqBackupFiles(f.root);
  expect(started).toMatchObject({
    ok: true,
    cacheRoot: cache,
    result: { status: 'failed', needsRecovery: false },
  });
  // UserConfig 随后会补当前版本策略字段，原始字段仍全部保留。
  expect(read(join(f.root, 'config.json'))).toMatchObject(original);
});

it('提交后的清理失败仍如实报告已应用，下一次启动补清理而不重复导入', () => {
  const f = fixture();
  stageWeqBackupRestore(
    f.root,
    buildWeqBackup([file('settings/app.json', { renderTextMarkdown: false })]),
    { parts: ['settings'], conflict: 'overwrite' },
  );
  faults.remove = (path) => {
    if (path.includes('.weq-restore-')) throw Error('合成清理失败');
  };
  const result = applyPendingWeqBackupRestore(f.root, f.cache)!;
  expect(result.status).toBe('applied');
  expect(result.warnings.join(' ')).toContain('清理');
  expect(read(join(f.root, 'config.json'))).toMatchObject({
    settings: { renderTextMarkdown: false },
  });
  faults.remove = null;
  expect(applyPendingWeqBackupRestore(f.root, f.cache)?.status).toBe('applied');
  expect(weqBackupRestoreStatus(f.root).pending).toBeNull();
});

it('暂存校验失败和用户取消均不改运行数据，也不删除原备份', () => {
  const f = fixture();
  const archive = buildWeqBackup([file('settings/app.json', { renderTextMarkdown: false })]);
  const source = join(f.root, 'source.zip');
  writeFileSync(source, archive);
  const staged = stageWeqBackupRestore(f.root, archive, {
    parts: ['settings'],
    conflict: 'overwrite',
  });
  writeFileSync(join(f.root, 'restore', `${staged.id}.zip`), 'corrupt');
  expect(applyPendingWeqBackupRestore(f.root, f.cache)).toMatchObject({
    status: 'failed',
    applied: [],
  });
  expect(read(join(f.root, 'config.json'))).toEqual(f.initial);
  cancelWeqBackupRestore(f.root, f.cache);
  stageWeqBackupRestore(f.root, archive, { parts: ['settings'], conflict: 'overwrite' });
  cancelWeqBackupRestore(f.root, f.cache);
  expect(readFileSync(source)).toEqual(archive);
  expect(read(join(f.root, 'config.json'))).toEqual(f.initial);
});

it('缺失的非默认缓存根不创建替代目录，且错误不计作导入成功', () => {
  const f = fixture();
  const missing = join(f.root, 'not-mounted', 'cache');
  stageWeqBackupRestore(f.root, buildWeqBackup([file('clones/10001/assistant.json', {})]), {
    parts: ['clones'],
    conflict: 'overwrite',
  });
  expect(applyPendingWeqBackupRestore(f.root, missing)).toMatchObject({
    status: 'failed',
    applied: [],
  });
  expect(existsSync(missing)).toBe(false);
});

it('由真实存储服务写出的完整克隆／助手数据可往返，不复制一套伪造存储格式', () => {
  const f = fixture(),
    sourceRoot = join(f.root, 'source-agentlab'),
    source = join(sourceRoot, '10001');
  const item = persona();
  const asset = join(source, 'stickers', 'abcd.png');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJRkAAAAASUVORK5CYII=',
    'base64',
  );
  mkdirSync(dirname(asset), { recursive: true });
  writeFileSync(asset, png);
  const sticker = {
    md5: 'abcd',
    fileName: 'abcd.png',
    localPath: asset,
    cdnToken: '',
    count: 1,
    description: '合成表情',
    scenario: '',
    contexts: [],
  };
  item.stickers = [sticker];
  new AgentLabStore(source).savePersona({ persona: item, pairs: [] });
  const conversations = new ConversationStore(join(source, 'conversations.json'));
  conversations.append(item.id, [{ role: 'user', text: '合成对话', ts: 1 }]);
  new MemoryStore(join(source, 'memories.json')).add(item.id, ['合成记忆'], 1);
  new NotesStore(join(source, 'notes.json')).add(item.id, ['合成纠正'], '合成经历');
  const groups = new JsonGroupStore(join(source, 'groups.json'));
  groups.createGroup({ id: 'synthetic-group', name: '合成群', ownerId: '10001', now: 1 });
  groups.addMember({
    groupId: 'synthetic-group',
    memberId: item.id,
    kind: 'persona',
    displayName: item.name,
    joinedAt: 1,
  });
  const message = {
    id: 'synthetic-message',
    groupId: 'synthetic-group',
    senderId: item.id,
    senderKind: 'persona' as const,
    text: `合成群消息，原始文本中的路径保持 ${asset}`,
    ts: 1,
    actions: [{ kind: 'sticker' as const, sticker }],
  };
  groups.appendMessage(message);
  new JsonRelationStore(join(source, 'relations.json')).applyDelta(
    item.id,
    '10001',
    'user',
    { affinity: 1 },
    1,
  );
  const session = new AgentLabSessionStore(join(source, 'sessions.json')).create(item.id);
  new AgentLabGroupSessionMessageStore(join(source, 'group_session_messages.json')).append(
    `synthetic-group:${session.id}`,
    message,
  );
  const usage = new TokenUsageStore(join(source, 'usage.json'));
  usage.record({
    model: 'synthetic-model',
    kind: 'chat',
    scope: '合成场景',
    ts: 1,
    promptTokens: 1,
    completionTokens: 2,
    totalTokens: 3,
  });
  const assistant = new AssistantService(
    source,
    () => {
      throw Error('备份测试不应调用网络');
    },
    usage,
    conversations,
  );
  assistant.setConfig({ model: item.models.chat, customPrompt: '合成助手配置' });
  const assistantSession = assistant.createSession();
  const internal = assistant as unknown as {
    writeReport(value: Record<string, unknown>): { id: string };
    persistRun(id: string, state: Record<string, unknown>, status: 'aborted'): void;
  };
  const report = internal.writeReport({
    kind: 'html',
    title: '合成报告',
    content: '<h1>合成报告内容</h1>',
  });
  internal.persistRun(
    assistantSession.id,
    {
      question: '合成问题',
      basePrompt: '合成上下文',
      messages: [
        { role: 'system', content: '合成系统' },
        { role: 'user', content: '合成问题' },
      ],
      workspace: { notes: [] },
      summary: '',
      toolCallCount: 0,
    },
    'aborted',
  );
  const snapshot = snapshotWeqClones(sourceRoot);
  const original = snapshot.files.map((entry) => ({
    path: entry.path,
    data: Buffer.from(entry.data),
  }));
  stageWeqBackupRestore(f.root, buildWeqBackup(snapshot.files), {
    parts: ['clones'],
    conflict: 'overwrite',
  });
  expect(applyPendingWeqBackupRestore(f.root, f.cache)?.status).toBe('applied');
  const destination = f.clone('10001');
  expect(new MemoryStore(join(destination, 'memories.json')).get(item.id)[0]?.text).toBe(
    '合成记忆',
  );
  expect(new NotesStore(join(destination, 'notes.json')).get(item.id).corrections).toEqual([
    '合成纠正',
  ]);
  const restoredMessage = new JsonGroupStore(join(destination, 'groups.json')).listMessages(
    'synthetic-group',
  )[0]!;
  expect(restoredMessage.text).toBe(message.text);
  const action = restoredMessage.actions?.find((entry) => entry.kind === 'sticker');
  expect(action?.kind === 'sticker' && action.sticker.localPath).toBe(
    join(destination, 'stickers', 'abcd.png'),
  );
  const sessionAction = new AgentLabGroupSessionMessageStore(
    join(destination, 'group_session_messages.json'),
  )
    .list(`synthetic-group:${session.id}`)[0]!
    .actions?.find((entry) => entry.kind === 'sticker');
  expect(sessionAction?.kind === 'sticker' && sessionAction.sticker.localPath).toBe(
    join(destination, 'stickers', 'abcd.png'),
  );
  expect(readFileSync(join(destination, 'stickers', 'abcd.png'))).toEqual(png);
  expect(
    new JsonRelationStore(join(destination, 'relations.json'), () => 1).get(item.id, '10001')
      ?.objectKind,
  ).toBe('user');
  expect(new AgentLabSessionStore(join(destination, 'sessions.json')).list(item.id)[0]?.id).toBe(
    session.id,
  );
  const restoredUsage = new TokenUsageStore(join(destination, 'usage.json'));
  expect(restoredUsage.getStats()).toMatchObject({ totalTokens: 3, totalCalls: 1 });
  const restoredAssistant = new AssistantService(
    destination,
    () => {
      throw Error('备份测试不应调用网络');
    },
    restoredUsage,
    new ConversationStore(join(destination, 'conversations.json')),
  );
  expect(restoredAssistant.getConfig()).toEqual(assistant.getConfig());
  expect(restoredAssistant.listSessions()[0]?.id).toBe(assistantSession.id);
  expect(readFileSync(join(destination, 'reports', report.id), 'utf8')).toBe(
    '<h1>合成报告内容</h1>',
  );
  const after = snapshotWeqClones(sourceRoot).files;
  for (const entry of original)
    expect(after.find((file) => file.path === entry.path)?.data).toEqual(entry.data);
});

it('克隆资产引用定位到当前缓存根，恢复后文件与实际 persona 引用一致', () => {
  const f = fixture(),
    item = persona();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJRkAAAAASUVORK5CYII=',
    'base64',
  );
  item.stickers = [
    {
      md5: 'abcd',
      fileName: 'abcd.png',
      localPath: 'stickers/abcd.png',
      cdnToken: '',
      count: 1,
      description: '合成表情',
      scenario: '',
      contexts: [],
    },
  ];
  stageWeqBackupRestore(
    f.root,
    buildWeqBackup([
      file('clones/10001/synthetic-persona.json', { persona: item, pairs: [] }),
      { path: 'clones/10001/stickers/abcd.png', data: png },
    ]),
    { parts: ['clones'], conflict: 'overwrite' },
  );
  expect(applyPendingWeqBackupRestore(f.root, f.cache)?.status).toBe('applied');
  const restored = new AgentLabStore(f.clone('10001')).getPersona(item.id)!.persona;
  expect(restored.stickers[0]?.localPath).toBe(join(f.clone('10001'), 'stickers', 'abcd.png'));
  expect(readFileSync(restored.stickers[0]!.localPath!)).toEqual(png);
});

it.each([
  file('clones/10001/synthetic-persona.json', { persona: { id: 'synthetic-persona' }, pairs: [] }),
  file('clones/10001/conversations.json', { 'synthetic-persona': {} }),
  file('clones/10001/sessions.json', { 'synthetic-persona': [{ title: [] }] }),
  file('clones/10001/memories.json', { 'synthetic-persona': [{ text: [] }] }),
])('格式校验通过仍拒绝不可被业务服务加载的记录：$path', (entry) => {
  const f = fixture();
  expect(() =>
    stageWeqBackupRestore(f.root, buildWeqBackup([entry]), {
      parts: ['clones'],
      conflict: 'overwrite',
    }),
  ).toThrow('数据结构');
  expect(weqBackupRestoreStatus(f.root).pending).toBeNull();
  expect(read(join(f.root, 'config.json'))).toEqual(f.initial);
});

it('悬空链接也属于已有目标，不用新文件覆盖原来的链接关系', () => {
  const f = fixture();
  mkdirSync(dirname(f.account('10001')), { recursive: true });
  symlinkSync(join(f.root, 'not-present-original.json'), f.account('10001'));
  stageWeqBackupRestore(
    f.root,
    buildWeqBackup([file('accounts/10001.json', account('10001', '导入账号'))]),
    { parts: ['accounts'], conflict: 'overwrite' },
  );
  expect(applyPendingWeqBackupRestore(f.root, f.cache)).toMatchObject({
    status: 'failed',
    applied: [],
  });
  expect(lstatSync(f.account('10001')).isSymbolicLink()).toBe(true);
});

it('暂存归档写入失败只留下未就绪记录，重启不能把未完成暂存应用为成功', () => {
  const f = fixture();
  faults.rename = (_from, to) => {
    if (to.endsWith('.zip')) throw Error('合成暂存写入失败');
  };
  expect(() =>
    stageWeqBackupRestore(
      f.root,
      buildWeqBackup([file('settings/app.json', { renderTextMarkdown: false })]),
      { parts: ['settings'], conflict: 'overwrite' },
    ),
  ).toThrow('合成暂存写入失败');
  expect(weqBackupRestoreStatus(f.root).pending?.phase).toBe('writing');
  faults.rename = null;
  expect(applyPendingWeqBackupRestore(f.root, f.cache)).toMatchObject({
    status: 'failed',
    applied: [],
    error: expect.stringContaining('暂存未完成'),
  });
  expect(read(join(f.root, 'config.json'))).toEqual(f.initial);
  cancelWeqBackupRestore(f.root, f.cache);
});

it('服务器事务尚未提交时不交出或确认界面偏好，防止混合恢复状态', () => {
  const f = fixture();
  write(f.account('10001'), account('10001', '本机账号'));
  const staged = stageWeqBackupRestore(
    f.root,
    buildWeqBackup([
      file('settings/client.json', { 'weq.theme-preference': 'dark' }),
      file('settings/app.json', { renderTextMarkdown: false }),
      file('accounts/10001.json', account('10001', '导入账号')),
    ]),
    { parts: ['settings', 'accounts'], conflict: 'overwrite' },
  );
  faults.rename = (from, to) => {
    if ((from.endsWith('/next') && to.endsWith('/config.json')) || from.endsWith('/before'))
      throw Error('合成回滚受阻');
  };
  expect(applyPendingWeqBackupRestore(f.root, f.cache)?.needsRecovery).toBe(true);
  expect(existsSync(join(f.root, 'restore', 'client.json'))).toBe(true);
  expect(pendingWeqClientSettings(f.root)).toBeNull();
  expect(acknowledgeWeqClientSettings(f.root, staged.id)).toBe(false);
  faults.rename = null;
  expect(applyPendingWeqBackupRestore(f.root, f.cache)?.needsRecovery).toBe(false);
  cancelWeqBackupRestore(f.root, f.cache);
});

it('清理待补期间已确认的界面偏好不会在下次启动重新变成待确认', () => {
  const f = fixture();
  const staged = stageWeqBackupRestore(
    f.root,
    buildWeqBackup([
      file('settings/app.json', { renderTextMarkdown: false }),
      file('settings/client.json', { 'weq.theme-preference': 'dark' }),
    ]),
    { parts: ['settings'], conflict: 'overwrite' },
  );
  faults.remove = (path) => {
    if (path.includes('.weq-restore-')) throw Error('合成清理受阻');
  };
  expect(applyPendingWeqBackupRestore(f.root, f.cache)).toMatchObject({
    status: 'applied',
    clientPending: true,
  });
  expect(acknowledgeWeqClientSettings(f.root, staged.id)).toBe(true);
  faults.remove = null;
  expect(applyPendingWeqBackupRestore(f.root, f.cache)).toMatchObject({
    status: 'applied',
    clientPending: false,
  });
  expect(pendingWeqClientSettings(f.root)).toBeNull();
});

it('暂存文件先完整校验，写入损坏时原目标尚未被替换', () => {
  const f = fixture();
  stageWeqBackupRestore(
    f.root,
    buildWeqBackup([file('settings/app.json', { renderTextMarkdown: false })]),
    { parts: ['settings'], conflict: 'overwrite' },
  );
  faults.corruptBuffer = true;
  expect(applyPendingWeqBackupRestore(f.root, f.cache)).toMatchObject({
    status: 'failed',
    applied: [],
    error: expect.stringContaining('暂存写入校验失败'),
  });
  expect(read(join(f.root, 'config.json'))).toEqual(f.initial);
  cancelWeqBackupRestore(f.root, f.cache);
});

it('提交标记写入失败也会回滚，不因内存阶段已设为 committed 而跳过回滚', () => {
  const f = fixture();
  stageWeqBackupRestore(
    f.root,
    buildWeqBackup([file('settings/app.json', { renderTextMarkdown: false })]),
    { parts: ['settings'], conflict: 'overwrite' },
  );
  faults.rename = (from, to) => {
    if (to.endsWith('/journal.json') && readFileSync(from, 'utf8').includes('"phase":"committed"'))
      throw Error('合成提交标记失败');
  };
  const result = applyPendingWeqBackupRestore(f.root, f.cache)!;
  expect(result.status).toBe('failed');
  expect(result.needsRecovery).not.toBe(true);
  expect(read(join(f.root, 'config.json'))).toEqual(f.initial);
  faults.rename = null;
  cancelWeqBackupRestore(f.root, f.cache);
});

it('准备期中断可凭工作区标记恢复归属，不依赖逐文件重写整份事务记录', () => {
  const f = fixture();
  stageWeqBackupRestore(
    f.root,
    buildWeqBackup([file('settings/app.json', { renderTextMarkdown: false })]),
    { parts: ['settings'], conflict: 'overwrite' },
  );
  faults.rename = (from, to) => {
    if (to.endsWith('/journal.json') && !readFileSync(from, 'utf8').includes('"phase":"preparing"'))
      throw Error('合成准备结束时中断');
  };
  expect(applyPendingWeqBackupRestore(f.root, f.cache)?.needsRecovery).toBe(true);
  expect(read(join(f.root, 'restore', 'journal.json')).phase).toBe('preparing');
  faults.rename = null;
  expect(applyPendingWeqBackupRestore(f.root, f.cache)).toMatchObject({
    status: 'failed',
    needsRecovery: false,
  });
  expect(read(join(f.root, 'config.json'))).toEqual(f.initial);
  cancelWeqBackupRestore(f.root, f.cache);
});

it.each(['prepare', 'rename'] as const)(
  '%s 期间本机未选配置被外部修改时保留新修改，不覆盖锁密钥',
  (when) => {
    const f = fixture();
    const updated = { ...f.initial, totpSecret: 'synthetic-new-local-secret' };
    stageWeqBackupRestore(
      f.root,
      buildWeqBackup([file('settings/app.json', { renderTextMarkdown: false })]),
      { parts: ['settings'], conflict: 'overwrite' },
    );
    let changed = false;
    faults.rename = (from, to) => {
      const match =
        when === 'prepare'
          ? to.endsWith('/journal.json') &&
            readFileSync(from, 'utf8').includes('"phase":"applying"')
          : from.endsWith('/config.json') && to.endsWith('/before');
      if (!changed && match) {
        changed = true;
        write(join(f.root, 'config.json'), updated);
      }
    };
    const result = applyPendingWeqBackupRestore(f.root, f.cache)!;
    expect(changed).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.needsRecovery).not.toBe(true);
    expect(read(join(f.root, 'config.json'))).toEqual(updated);
    faults.rename = null;
    cancelWeqBackupRestore(f.root, f.cache);
  },
);
