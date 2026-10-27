import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { AgentLabConfigService } from '../src/bootstrap/agentlab_config';
import { UserConfigService } from '../src/bootstrap/user_config';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-providers-'));
  roots.push(root);
  const platform = { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
  const config = new UserConfigService(platform);
  return {
    config,
    service: new AgentLabConfigService(config),
    reload: () => new AgentLabConfigService(new UserConfigService(platform)),
  };
}
describe('多 provider 持久化与调用隔离', () => {
  it('慢模型期限跨重启生效，旧客户端编辑不清除，非法期限不覆盖配置', () => {
    const f = fixture();
    const provider = {
      id: 'slow',
      name: '合成慢模型',
      vendor: 'custom',
      baseUrl: 'https://synthetic.invalid',
      apiKey: 'synthetic',
      models: [{ id: 'model', capabilities: ['chat' as const] }],
    };
    f.service.saveProvider({ ...provider, timeoutMs: 600_000 });
    const ref = { providerId: 'slow', model: 'model' };
    expect(f.reload().resolveEndpoint(ref).timeoutMs).toBe(600_000);
    f.service.saveProvider({ ...provider, name: '改名' });
    expect(f.reload().resolveEndpoint(ref).timeoutMs).toBe(600_000);
    for (const timeoutMs of [0, -1, 1.5, NaN, 2_147_483_648]) {
      expect(() => f.service.saveProvider({ ...provider, timeoutMs })).toThrow();
      expect(f.reload().resolveEndpoint(ref).timeoutMs).toBe(600_000);
    }
  });
  it('显式默认按调用时的全局选择解析，旧显式模型不跟随修改', () => {
    const f = fixture();
    f.service.saveProvider({
      id: 'synthetic',
      name: '合成服务',
      vendor: 'custom',
      baseUrl: 'https://synthetic.invalid/v1',
      apiKey: 'synthetic-key',
      models: [
        { id: 'first', capabilities: ['chat', 'vision', 'embedding'] },
        { id: 'second', capabilities: ['chat'] },
      ],
    });
    const first = { providerId: 'synthetic', model: 'first' };
    f.service.setDefaultModel(first);
    expect(f.service.resolveEndpoint({ useDefault: true }, 'embedding').model).toBe('first');
    expect(f.service.resolveEndpoint({ useDefault: true }, 'vision').model).toBe('first');
    const exportSnapshot = f.service.resolveModels({
      chat: { useDefault: true },
      embedding: first,
      vision: { useDefault: true },
    });
    expect(exportSnapshot).toEqual({ chat: first, embedding: first, vision: first });
    f.service.setDefaultModel({ providerId: 'synthetic', model: 'second' });
    expect(exportSnapshot.chat).toEqual(first);
    expect(f.service.resolveEndpoint({ useDefault: true }).model).toBe('second');
    expect(f.service.resolveModelRef({ useDefault: true })).toEqual({
      providerId: 'synthetic',
      model: 'second',
    });
    expect(f.service.resolveEndpoint(first).model).toBe('first');
    expect(() => f.service.resolveEndpoint({ useDefault: true }, 'embedding')).toThrow('支持');
    expect(() => f.service.resolveEndpoint({ useDefault: true }, 'vision')).toThrow('支持');
    f.service.setDefaultModel(null);
    expect(() => f.service.resolveEndpoint({ useDefault: true })).toThrow('未设置默认模型');
    expect(f.service.resolveEndpoint(first).model).toBe('first');
  });
  it('默认模型显式保存，跨重启和 provider 编辑保留；清空不自动选择其他模型', () => {
    const f = fixture();
    expect(f.service.getDefaultModelStatus()).toEqual({ ref: null, available: false, error: null });
    const provider = {
      id: 'default-provider',
      name: '合成服务',
      vendor: 'custom',
      baseUrl: 'https://synthetic.invalid/v1',
      apiKey: 'synthetic-key',
      models: [{ id: 'chat-model', capabilities: ['chat' as const] }],
    };
    f.service.saveProvider(provider);
    expect(f.service.getDefaultModelStatus().ref).toBeNull();
    const ref = { providerId: provider.id, model: 'chat-model' };
    expect(f.service.setDefaultModel(ref)).toEqual({ ref, available: true, error: null });
    const reopened = f.reload();
    expect(reopened.resolveDefaultEndpoint()).toMatchObject({
      model: ref.model,
      baseUrl: provider.baseUrl,
    });
    reopened.saveProvider({ ...provider, name: '改名', apiKey: 'synthetic-new-key' });
    expect(f.reload().getDefaultModelStatus()).toEqual({ ref, available: true, error: null });
    expect(f.reload().resolveDefaultEndpoint().apiKey).toBe('synthetic-new-key');
    f.service.setDefaultModel(null);
    expect(f.reload().getDefaultModelStatus()).toEqual({
      ref: null,
      available: false,
      error: null,
    });
    expect(() => f.reload().resolveDefaultEndpoint()).toThrow('未设置默认模型');
  });

  it('拒绝无效默认选择；已选模型被删除时保留引用并明确不可用，不扩大为其他端点', () => {
    const f = fixture();
    const provider = {
      id: 'synthetic',
      name: '合成服务',
      vendor: 'custom',
      baseUrl: 'https://synthetic.invalid/v1',
      apiKey: 'synthetic-key',
      models: [
        { id: 'chat', capabilities: ['chat' as const] },
        { id: 'embedding', capabilities: ['embedding' as const] },
      ],
    };
    f.service.saveProvider(provider);
    for (const ref of [
      { providerId: 'missing', model: 'chat' },
      { providerId: 'synthetic', model: 'missing' },
      { providerId: 'synthetic', model: 'embedding' },
    ]) {
      expect(() => f.service.setDefaultModel(ref)).toThrow();
      expect(f.reload().getDefaultModelStatus().ref).toBeNull();
    }
    const ref = { providerId: 'synthetic', model: 'chat' };
    f.service.setDefaultModel(ref);
    f.service.saveProvider({ ...provider, models: [provider.models[1]!] });
    expect(f.reload().getDefaultModelStatus()).toMatchObject({ ref, available: false });
    expect(() => f.reload().resolveDefaultEndpoint()).toThrow('模型');
    f.service.deleteProvider(provider.id);
    expect(f.reload().getDefaultModelStatus()).toMatchObject({ ref, available: false });
    expect(() => f.reload().resolveDefaultEndpoint()).toThrow('provider');
    expect(f.service.setDefaultModel(null).ref).toBeNull();
  });
  it('同名、同厂商、同模型的不同端点和密钥重启后仍按 providerId 分别解析', () => {
    const f = fixture();
    const base = {
      name: 'Synthetic Provider',
      vendor: 'openai-compatible',
      models: [{ id: 'shared-model', capabilities: ['chat' as const] }],
    };
    f.service.saveProvider({
      ...base,
      id: 'legacy-provider',
      baseUrl: 'https://one.example.invalid/v1',
      apiKey: 'synthetic-first',
    });
    f.service.saveProvider({
      ...base,
      id: 'new-provider',
      baseUrl: 'https://two.example.invalid/v1',
      apiKey: 'synthetic-second',
    });
    const reopened = f.reload();
    expect(reopened.listProviders()).toHaveLength(2);
    expect(
      reopened.resolveEndpoint({ providerId: 'legacy-provider', model: 'shared-model' }),
    ).toMatchObject({
      baseUrl: 'https://one.example.invalid/v1',
      apiKey: 'synthetic-first',
      model: 'shared-model',
    });
    expect(
      reopened.resolveEndpoint({ providerId: 'new-provider', model: 'shared-model' }),
    ).toMatchObject({ baseUrl: 'https://two.example.invalid/v1', apiKey: 'synthetic-second' });
    reopened.saveProvider({
      ...base,
      id: 'legacy-provider',
      name: '改名仍保留引用',
      baseUrl: 'https://one.example.invalid/v2',
      apiKey: 'synthetic-updated-first',
    });
    const edited = f.reload();
    expect(edited.listProviders()).toHaveLength(2);
    expect(
      edited.resolveEndpoint({ providerId: 'legacy-provider', model: 'shared-model' }).apiKey,
    ).toBe('synthetic-updated-first');
    expect(
      edited.resolveEndpoint({ providerId: 'new-provider', model: 'shared-model' }).apiKey,
    ).toBe('synthetic-second');
    expect(edited.deleteProvider('new-provider')).toBe(true);
    expect(f.reload().getProvider('legacy-provider')?.name).toBe('改名仍保留引用');
    expect(f.reload().getProvider('new-provider')).toBeNull();
  });

  it('同地址不同密钥及语音提供方都可并存，不把模型列表补回或并入其他配置', () => {
    const f = fixture();
    const base = {
      name: '同地址',
      vendor: 'openai-compatible',
      baseUrl: 'https://one.example.invalid/v1',
      models: [{ id: 'model-a', capabilities: ['chat' as const] }],
    };
    f.service.saveProvider({ ...base, id: 'a', apiKey: 'synthetic-a' });
    f.service.saveProvider({
      ...base,
      id: 'b',
      apiKey: 'synthetic-b',
      models: [{ id: 'model-b', capabilities: ['embedding'] }],
    });
    f.config.setSettings({
      voiceTranscribe: {
        ttsProviders: ['voice-a', 'voice-b'].map((id) => ({
          id,
          name: '同名语音',
          vendor: 'cosyvoice',
          baseUrl: 'https://voice.example.invalid/v1',
          apiKey: `synthetic-${id}`,
          createdAt: 1,
          updatedAt: 1,
        })),
      },
    });
    const reopened = f.reload();
    expect(reopened.getProvider('a')?.models.map((model) => model.id)).toEqual(['model-a']);
    expect(reopened.getProvider('b')?.models.map((model) => model.id)).toEqual(['model-b']);
    expect(reopened.getTtsProvider('voice-a')?.apiKey).toBe('synthetic-voice-a');
    expect(reopened.getTtsProvider('voice-b')?.apiKey).toBe('synthetic-voice-b');
  });
});
