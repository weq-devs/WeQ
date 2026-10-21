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
