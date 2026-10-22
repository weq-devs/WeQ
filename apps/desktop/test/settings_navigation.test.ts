import { describe, expect, it } from 'vitest';
import {
  SETTINGS_GROUPS,
  settingsGroupFor,
  settingsSectionFor,
} from '../src/renderer/src/components/settings/navigation';

describe('设置的两级导航', () => {
  it('帮助与关于只有四个目标页，旧帮助和更新提醒深链归到新页面', () => {
    expect(settingsGroupFor('version').sections).toEqual(['version', 'faq', 'logs', 'feedback']);
    expect(settingsSectionFor('help')).toBe('faq');
    expect(settingsSectionFor('updates')).toBe('version');
    for (const id of ['version', 'faq', 'logs', 'feedback', 'help', 'updates'] as const) {
      expect(settingsGroupFor(id).id).toBe('help');
    }
  });
  it('模型保留单个一级分类，识别、克隆与画像分别归位', () => {
    expect(SETTINGS_GROUPS.map((group) => group.label)).toEqual([
      '常规',
      '个性显示',
      '隐私与安全',
      '账号与消息',
      '空间与邮箱',
      '数据与存储',
      '模型与识别',
      '服务与集成',
      '高级与诊断',
      '帮助与关于',
    ]);
    expect(settingsGroupFor('model-usage').sections).toEqual([
      'agentlab',
      'model-usage',
      'intent-sense',
      'interaction-profile',
      'reply-suggestions',
      'clone-settings',
      'voice',
      'ocr',
    ]);
    expect(settingsSectionFor('voice')).toBe('voice');
    expect(settingsSectionFor('ocr')).toBe('ocr');
    expect(settingsSectionFor('local-models')).toBe('voice');
    expect(settingsSectionFor('intent-models')).toBe('intent-sense');
    expect(settingsSectionFor('tts')).toBe('agentlab');
    expect(settingsGroupFor('credentials').id).toBe('advanced');
    expect(settingsGroupFor('startup').id).toBe('general');
    expect(settingsGroupFor('database').id).toBe('data');
    expect(settingsGroupFor('mail').sections).toEqual(['qzone', 'mail']);
    expect(settingsGroupFor('qzone').id).toBe('space-mail');
    expect(settingsGroupFor('account').sections).not.toContain('qzone');
  });

  it('保留原分区深链，每个二级页只归属一个分类', () => {
    const ids = SETTINGS_GROUPS.flatMap((group) => group.sections);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'maintenance',
      'diagnostics',
      'anti-recall',
      'qzone',
      'voice',
      'help',
      'version',
    ] as const) {
      expect(settingsGroupFor(id).sections).toContain(settingsSectionFor(id));
    }
  });
});
