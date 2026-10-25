import { describe, expect, it } from 'vitest';
import {
  SETTINGS_GROUPS,
  settingsGroupFor,
  settingsSectionFor,
} from '../src/renderer/src/components/settings/navigation';

describe('设置的两级导航', () => {
  it('关于包含版本后的配置备份，旧帮助和更新提醒深链归到新页面', () => {
    expect(settingsGroupFor('version').sections).toEqual([
      'version',
      'backup',
      'faq',
      'logs',
      'feedback',
    ]);
    expect(settingsSectionFor('help')).toBe('faq');
    expect(settingsSectionFor('updates')).toBe('version');
    for (const id of ['version', 'faq', 'logs', 'feedback', 'help', 'updates'] as const) {
      expect(settingsGroupFor(id).id).toBe('help');
    }
  });
  it('模型保留单个一级分类，识别、克隆与画像分别归位', () => {
    expect(SETTINGS_GROUPS.map((group) => group.label)).toEqual([
      '常规',
      '基础功能',
      'AI 功能',
      '凭据与账号',
      '数据库与资源',
      'WeQ 服务',
      '关于 WeQ',
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
    expect(settingsGroupFor('credentials').id).toBe('account');
    expect(settingsGroupFor('startup').id).toBe('general');
    expect(settingsGroupFor('database').id).toBe('data');
    expect(settingsGroupFor('mail').sections).toEqual([
      'chat-messages',
      'call-recording',
      'qzone',
      'mail',
    ]);
    expect(settingsGroupFor('qzone').id).toBe('basic');
    expect(settingsGroupFor('account').sections).not.toContain('qzone');
  });

  it('存储、备份和维护按用途拆分，原页面入口定位到各自分类', () => {
    expect(settingsGroupFor('storage').sections).toContain('weq-storage');
    expect(settingsGroupFor('media').sections).toContain('accounts');
    expect(settingsGroupFor('backup')).toEqual({
      id: 'help',
      label: '关于 WeQ',
      sections: ['version', 'backup', 'faq', 'logs', 'feedback'],
    });
    for (const id of ['database', 'database-status', 'maintenance'] as const) {
      expect(settingsGroupFor(id)).toEqual({
        id: 'data',
        label: '数据库与资源',
        sections: [
          'database-repair',
          'database-tolerance',
          'database-management',
          'qq-storage',
          'resource-loading',
        ],
      });
    }
  });

  it('保留原分区深链，每个二级页只归属一个分类', () => {
    const ids = SETTINGS_GROUPS.flatMap((group) => group.sections);
    expect(SETTINGS_GROUPS).toHaveLength(7);
    expect(ids).toHaveLength(37);
    expect(settingsSectionFor('applock')).toBe('privacy');
    expect(settingsGroupFor('privacy').id).toBe('general');
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
