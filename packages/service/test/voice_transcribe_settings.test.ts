import { describe, expect, it } from 'vitest';
import { snapshotWeqSettings, validateWeqAppSettings } from '../src/bootstrap/backup_settings';
import { configFixture } from './support/user_config';

describe('语音消息自动转文字设置', () => {
  it('旧配置默认关闭，独立持久化且不丢失模型选择', () => {
    const f = configFixture({ settings: { voiceTranscribe: { modelId: 'legacy-model' } } });
    expect(f.open().getSettings().voiceTranscribe.autoTranscribe).toBe(false);
    f.service.setSettings({ voiceTranscribe: { autoTranscribe: true } });
    f.service.setSettings({ showMessageTime: true });
    expect(f.open().getSettings().voiceTranscribe).toMatchObject({
      modelId: 'legacy-model',
      autoTranscribe: true,
      ttsProviders: [],
    });
    f.service.setSettings({ voiceTranscribe: { modelId: '' } });
    expect(f.open().getSettings().voiceTranscribe.autoTranscribe).toBe(true);
    f.service.setSettings({ voiceTranscribe: { autoTranscribe: false } });
    expect(f.open().getSettings().voiceTranscribe.autoTranscribe).toBe(false);
  });

  it('备份恢复保留开关，兼容旧备份并拒绝非布尔值', () => {
    const f = configFixture();
    f.service.setSettings({ voiceTranscribe: { autoTranscribe: true } });
    const backup = snapshotWeqSettings(f.service.getSettings());
    expect(backup.voiceTranscribe.autoTranscribe).toBe(true);
    expect(() => validateWeqAppSettings(backup)).not.toThrow();
    const restored = configFixture();
    restored.service.setSettings(backup);
    expect(restored.open().getSettings().voiceTranscribe.autoTranscribe).toBe(true);
    expect(() => validateWeqAppSettings({ voiceTranscribe: { modelId: '' } })).not.toThrow();
    expect(() => validateWeqAppSettings({ voiceTranscribe: { autoTranscribe: 'true' } })).toThrow();
  });
});
