import { describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configFixture } from './support/user_config';
import { sharedPreferencePersistence } from '../src/common/shared_preferences';
import { JsonStore } from '../src/common/json_store';
import * as atomic from '../src/common/atomic_write';
import { IntentSenseService, DEFAULT_INTENT_SENSE_CONFIG } from '../src/account/intent_sense';
import { snapshotWeqSettings, snapshotWeqApiSettings } from '../src/bootstrap/backup_settings';

function save(root: string, name: string, value: unknown) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('统一设置来源', () => {
  it('以当前账号初始化，显式全局 false 与空列表不被旧账号接管', () => {
    const f = configFixture();
    f.service.patchSharedPreference('intent', { enabled: false, suggestionFallbackTexts: [] });
    save(f.root, 'cache/intent_sense/a/config.json', {
      enabled: true,
      engine: 'local',
      suggestionFallbackTexts: ['a'],
      conversationOverrides: { 'c2c:one': true },
    });
    save(f.root, 'cache/intent_sense/b/config.json', { enabled: true, engine: 'api' });
    f.service.migrateSharedAccountPreferences('a');
    expect(f.service.getSharedPreference('intent')).toMatchObject({
      enabled: false,
      engine: 'local',
      suggestionFallbackTexts: [],
    });
    expect(f.service.getSharedPreference('intent')).not.toHaveProperty('conversationOverrides');
    f.service.migrateSharedAccountPreferences('b');
    expect(f.service.getSharedPreference('intent').engine).toBe('local');
    expect(f.open().getSharedPreference('intent').engine).toBe('local');
  });

  it('缺项不从其他账号补齐，安装列表取并集，回执不含凭据', () => {
    const f = configFixture();
    save(f.root, 'config/accounts/a.json', { uin: '1', dbKey: 'secret', mailShowUnread: false });
    save(f.root, 'config/accounts/b.json', { uin: '2', dbKey: 'other', mailNotifications: true });
    save(f.root, 'config/accounts/a/dress.json', {
      localAppearanceVersion: 1,
      installedBubbles: [1, 2],
      activeBubble: 1,
    });
    save(f.root, 'config/accounts/b/dress.json', {
      localAppearanceVersion: 1,
      installedBubbles: [2, 3],
      activeBubble: 3,
    });
    f.service.migrateSharedAccountPreferences('a');
    expect(f.service.getSharedPreference('mail')).toMatchObject({
      mailShowUnread: false,
      mailNotifications: false,
    });
    expect(f.service.getSharedPreference('dress')).toMatchObject({
      installedBubbles: [1, 2, 3],
      activeBubble: 1,
    });
    const receipt = readFileSync(f.service.read().sharedPreferencesMigration!.receipt!, 'utf8');
    expect(receipt).not.toContain('secret');
    expect(receipt).not.toContain('dbKey');
  });

  it('坏旧文件不标记完成，修复后可重试', () => {
    const f = configFixture();
    const path = save(f.root, 'cache/intent_sense/a/config.json', {});
    writeFileSync(path, '{bad');
    expect(() => f.service.migrateSharedAccountPreferences('a')).toThrow('原件已保留');
    expect(f.service.read().sharedPreferencesMigration).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe('{bad');
    writeFileSync(path, JSON.stringify({ enabled: true }));
    f.service.migrateSharedAccountPreferences('a');
    expect(f.service.getSharedPreference('intent').enabled).toBe(true);
  });

  it('规则按账号保存，通用值只写入 config.json', () => {
    const f = configFixture();
    f.service.patchSharedPreference('intent', { enabled: false });
    const a = save(f.root, 'rules/a.json', {
      enabled: true,
      conversationOverrides: { 'c2c:x': true },
    });
    const b = save(f.root, 'rules/b.json', { enabled: true, conversationOverrides: {} });
    type Config = { enabled: boolean; conversationOverrides: Record<string, boolean> };
    const portA = sharedPreferencePersistence<Config, 'intent'>(f.service, 'intent', a, [
      'conversationOverrides',
    ]);
    const portB = sharedPreferencePersistence<Config, 'intent'>(f.service, 'intent', b, [
      'conversationOverrides',
    ]);
    const store = new JsonStore<Config>(a, () => ({ enabled: false, conversationOverrides: {} }), {
      persistence: portA,
    });
    expect(store.data.enabled).toBe(false);
    store.replace({ ...store.data, enabled: true, conversationOverrides: {} });
    expect(portB.read()).toEqual({ enabled: true, conversationOverrides: {} });
    expect(JSON.parse(readFileSync(a, 'utf8'))).toEqual({ conversationOverrides: {} });
  });

  it('不同字段连续写入均保留，同字段后提交生效', () => {
    const f = configFixture();
    f.service.patchSharedPreference('mail', { mailShowUnread: false });
    f.service.patchSharedPreference('mail', { mailNotifications: true });
    f.service.patchSharedPreference('mail', { mailShowUnread: true });
    expect(f.service.getSharedPreference('mail')).toEqual({
      mailShowUnread: true,
      mailNotifications: true,
    });
  });

  it('提交失败不标记迁移完成，重试不丢失迁移前的显式全局值', () => {
    const f = configFixture();
    f.service.patchSharedPreference('mail', { mailShowUnread: false });
    save(f.root, 'config/accounts/a.json', { mailShowUnread: true, mailPollIntervalMinutes: 8 });
    const write = vi.spyOn(f.service, 'write').mockImplementationOnce(() => {
      throw new Error('合成写入失败');
    });
    expect(() => f.service.migrateSharedAccountPreferences('a')).toThrow('合成写入失败');
    expect(f.service.read().sharedPreferencesMigration).toBeUndefined();
    expect(f.service.getSharedPreference('mail')).toEqual({ mailShowUnread: false });
    write.mockRestore();
    f.service.migrateSharedAccountPreferences('a');
    expect(f.service.getSharedPreference('mail')).toMatchObject({
      mailShowUnread: false,
      mailPollIntervalMinutes: 8,
    });
  });

  it('切号继承 AI 偏好而不继承会话开关，纯显示修改不清理分析缓存', async () => {
    const f = configFixture();
    f.service.migrateSharedAccountPreferences('a');
    const directory = (id: string) => f.service.cacheDir(`intent_sense/${id}`);
    const create = (id: string) =>
      new IntentSenseService({} as AccountSession, directory(id), {
        preferences: sharedPreferencePersistence(
          f.service,
          'intent',
          join(directory(id), 'config.json'),
          ['conversationOverrides'],
        ),
      });
    const a = create('a');
    const clear = vi.spyOn(a, 'clearCache');
    await a.setConfig({ persistentDisplay: false, loadingAnimation: false });
    await a.setConversationOverride('c2c', 'u_peer', false);
    expect(clear).not.toHaveBeenCalled();
    const b = create('b');
    expect(b.getStatus()).toMatchObject({
      persistentDisplay: false,
      loadingAnimation: false,
      conversationOverrides: {},
    });
    expect(create('a').getStatus().conversationOverrides).toEqual({ 'c2c:u_peer': false });
    expect(JSON.parse(readFileSync(join(directory('a'), 'config.json'), 'utf8'))).toEqual({
      conversationOverrides: { 'c2c:u_peer': false },
    });
  });

  it('新备份完整记录默认值，助手及外部 MCP 只进入 API 分区', () => {
    const f = configFixture();
    f.service.patchSharedPreference('assistant', {
      customPrompt: '合成提示词',
      mcpServers: 'fixture=https://example.invalid',
    });
    const settings = f.service.getSettings();
    const app = snapshotWeqSettings(settings);
    const api = snapshotWeqApiSettings(settings);
    expect(app.sharedPreferences).not.toHaveProperty('assistant');
    expect(app.sharedPreferences.mail).toEqual({
      mailNotifications: false,
      mailShowUnread: true,
      mailPollIntervalMinutes: 1,
    });
    expect(api.sharedAssistant).toMatchObject({
      customPrompt: '合成提示词',
      mcpServers: 'fixture=https://example.invalid',
    });
    expect(app.sharedPreferences.intent).not.toHaveProperty('conversationOverrides');
  });

  it('输入状态名单只合并目标数据源，其他端刚保存的名单不会被旧整表覆盖', () => {
    const f = configFixture();
    const a = { accountUin: '10001', accountConfigId: 'source-a', uid: 'u_a', name: '合成甲' };
    const b = { accountUin: '10001', accountConfigId: 'source-b', uid: 'u_b', name: '合成乙' };
    f.service.setTypingStatusHiddenForAccount('10001', 'source-a', [a]);
    f.service.setTypingStatusHiddenForAccount('10001', 'source-b', [b]);
    f.service.setTypingStatusHiddenForAccount('10001', 'source-a', []);
    expect(f.service.getSettings().typingStatus.hidden).toEqual([b]);
    expect(() => f.service.setTypingStatusHiddenForAccount('10001', 'source-a', [b])).toThrow(
      '不一致',
    );
  });
  it('没有旧配置时沿用真实默认值；全局分析选择不改变旧账号的独立画像与推荐模型', () => {
    const empty = configFixture();
    empty.service.migrateSharedAccountPreferences('a');
    expect(empty.service.getSharedPreference('intent').profileEngine).toBe(
      DEFAULT_INTENT_SENSE_CONFIG.profileEngine,
    );
    const f = configFixture();
    save(f.root, 'cache/intent_sense/a/config.json', {
      enabled: true,
      engine: 'api',
      providerRef: { providerId: 'old', model: 'old' },
    });
    f.service.patchSharedPreference('intent', {
      featureSettingsVersion: 2,
      engine: 'local',
      providerRef: { providerId: 'new', model: 'new' },
    });
    f.service.migrateSharedAccountPreferences('a');
    expect(f.service.getSharedPreference('intent')).toMatchObject({
      engine: 'local',
      providerRef: { providerId: 'new', model: 'new' },
      profileEngine: 'api',
      profileProviderRef: { providerId: 'old', model: 'old' },
      suggestionProviderRef: { providerId: 'old', model: 'old' },
    });
  });
  it('迁移画像范围时保留显式全局参数，自动协调继承的关联范围', () => {
    const f = configFixture();
    save(f.root, 'cache/intent_sense/a/config.json', {
      featureSettingsVersion: 2,
      profileMessages: 80,
      profileSamples: 50,
      profileMinSamples: 8,
    });
    f.service.patchSharedPreference('intent', { profileSamples: 150 });
    f.service.migrateSharedAccountPreferences('a');
    expect(f.service.getSharedPreference('intent')).toMatchObject({
      profileMessages: 150,
      profileSamples: 150,
      profileMinSamples: 8,
    });
  });
  it('坏规则文件在全局写入前拒绝，不留下只保存一半的通知偏好', () => {
    const f = configFixture();
    f.service.patchSharedPreference('antiRecall', { enabled: false });
    const path = save(f.root, 'rules/recall.json', {});
    writeFileSync(path, '{bad');
    const patch = vi.spyOn(f.service, 'patchSharedPreference');
    try {
      const port = sharedPreferencePersistence<
        { enabled: boolean; targets: Array<{ kind: 'group'; id: string }> },
        'antiRecall'
      >(f.service, 'antiRecall', path, ['targets']);
      expect(() =>
        port.write({ enabled: true, targets: [{ kind: 'group', id: '10001' }] }),
      ).toThrow('原件已保留');
      expect(patch).not.toHaveBeenCalled();
      expect(f.service.getSharedPreference('antiRecall').enabled).toBe(false);
    } finally {
      patch.mockRestore();
    }
  });
  it('会话规则落盘失败时回滚本次全局修改，不发布未保存的内存配置', () => {
    const f = configFixture();
    f.service.patchSharedPreference('antiRecall', { enabled: false });
    const path = save(f.root, 'rules/recall.json', { targets: [] });
    type Config = { enabled: boolean; targets: Array<{ kind: 'group'; id: string }> };
    const port = sharedPreferencePersistence<Config, 'antiRecall'>(f.service, 'antiRecall', path, [
      'targets',
    ]);
    const store = new JsonStore<Config>(path, () => ({ enabled: false, targets: [] }), {
      persistence: port,
    });
    const original = atomic.writeFileAtomicSync;
    const write = vi.spyOn(atomic, 'writeFileAtomicSync').mockImplementation((target, bytes) => {
      if (target === path) throw new Error('合成规则写入失败');
      original(target, bytes);
    });
    try {
      expect(() =>
        store.replace({ enabled: true, targets: [{ kind: 'group', id: '10001' }] }),
      ).toThrow('合成规则写入失败');
      expect(f.service.getSharedPreference('antiRecall')).toEqual({ enabled: false });
      expect(store.data).toEqual({ enabled: false, targets: [] });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ targets: [] });
    } finally {
      write.mockRestore();
    }
  });
});
