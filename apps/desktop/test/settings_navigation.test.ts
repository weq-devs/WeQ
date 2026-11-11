// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { searchAppEntries } from '../src/renderer/src/components/search/appSearchCatalog';
import {
  SETTINGS_GROUPS,
  SETTINGS_PAGE_LABELS,
  settingsGroupFor,
  settingsSectionFor,
} from '../src/renderer/src/components/settings/navigation';

describe('设置的两级导航', () => {
  it('常规首项合并为启动与主页，旧主页入口仍能定位', () => {
    expect(settingsGroupFor('startup').sections).toEqual([
      'startup',
      'appearance',
      'global',
      'weq-storage',
      'privacy',
    ]);
    expect(SETTINGS_PAGE_LABELS.startup).toBe('启动与主页');
    expect(settingsSectionFor('home')).toBe('startup');
  });
  it('关于包含版本后的配置备份，旧帮助和更新提醒深链归到新页面', () => {
    expect(settingsGroupFor('version').sections).toEqual([
      'version',
      'backup',
      'faq',
      'logs',
      'performance-monitor',
      'feedback',
    ]);
    expect(settingsSectionFor('help')).toBe('faq');
    expect(settingsSectionFor('updates')).toBe('version');
    for (const id of ['version', 'faq', 'logs', 'feedback', 'help', 'updates'] as const) {
      expect(settingsGroupFor(id).id).toBe('help');
    }
  });
  it('模型保留单个一级分类，克隆设置不再占用独立页面', () => {
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
      'reply-suggestions',
      'intent-sense',
      'interaction-profile',
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
      'message-display',
      'chat-interaction',
      'contact-card',
      'call-recording',
      'qzone',
      'mail',
    ]);
    expect(settingsGroupFor('qzone').id).toBe('basic');
    expect(settingsGroupFor('account').sections).not.toContain('qzone');
  });

  it('存储、备份和维护按用途拆分，原页面入口定位到各自分类', () => {
    expect(settingsGroupFor('storage').sections).toContain('weq-storage');
    expect(settingsGroupFor('media').sections).toContain('media');
    expect(settingsGroupFor('backup')).toEqual({
      id: 'help',
      label: '关于 WeQ',
      sections: ['version', 'backup', 'faq', 'logs', 'performance-monitor', 'feedback'],
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
          'media',
          'resource-loading',
        ],
      });
    }
  });

  it('性能归关于，媒体来源归数据，未选中的备份和凭据位置不变', () => {
    expect(settingsGroupFor('performance-monitor').id).toBe('help');
    expect(settingsGroupFor('media').id).toBe('data');
    expect(settingsGroupFor('accounts').sections).not.toContain('performance-monitor');
    expect(settingsGroupFor('diagnostics').id).toBe('account');
    expect(settingsGroupFor('backup').id).toBe('help');
    expect(settingsSectionFor('rkey')).toBe('credentials');
    expect(SETTINGS_PAGE_LABELS.diagnostics).toBe('QQ 协议工具');
    expect(SETTINGS_PAGE_LABELS['database-tolerance']).toBe('数据库容错');
    expect(SETTINGS_PAGE_LABELS['qq-accounts']).toBe('QQ 登录记录管理');
    expect(SETTINGS_PAGE_LABELS['qq-storage']).toBe('QQ 资源管理');
    expect(SETTINGS_PAGE_LABELS.agentlab).toBe('API 配置');
    expect(SETTINGS_PAGE_LABELS['model-usage']).toBe('API 用量');
  });

  it.each([
    ['诊断工具', 'QQ 协议工具', '凭据与账号'],
    ['QQ 账号管理', 'QQ 登录记录管理', '凭据与账号'],
    ['数据库宽容', '数据库容错', '数据库与资源'],
    ['资源目录管理', 'QQ 资源管理', '数据库与资源'],
    ['已保存的 provider', '已保存的服务商', 'AI 功能'],
    ['优先使用 CDN', '优先直连 QQ 加载图片', '数据库与资源'],
    ['媒体来源', '媒体来源', '数据库与资源'],
    ['性能监视', '性能监视', '关于 WeQ'],
  ])('旧名或新名 %s 展示规范名称 %s 与新路径', (keyword, title, group) => {
    const entry = searchAppEntries(keyword)[0];
    expect(entry?.title).toBe(title);
    expect(entry?.path).toContain(`设置 / ${group} /`);
  });

  it('保留原分区深链，每个二级页只归属一个分类', () => {
    const ids = SETTINGS_GROUPS.flatMap((group) => group.sections);
    expect(SETTINGS_GROUPS).toHaveLength(7);
    expect([...ids].sort()).toEqual(Object.keys(SETTINGS_PAGE_LABELS).sort());
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
