// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { searchAppEntries } from '../src/renderer/src/components/search/appSearchCatalog';
import {
  SETTINGS_GROUPS,
  SETTINGS_PAGE_LABELS,
  settingsGroupFor,
  settingsSectionFor,
  resolveSettingsTarget,
} from '../src/renderer/src/components/settings/navigation';

describe('设置的两级导航', () => {
  it.each(['消息阅读', '消息区域'])('%s 搜索统一显示消息阅读并保留旧名称入口', (keyword) => {
    expect(SETTINGS_PAGE_LABELS['message-display']).toBe('消息阅读');
    expect(searchAppEntries(keyword)[0]).toMatchObject({
      path: '设置 / 基础功能 / 消息阅读',
      target: { kind: 'setting', section: 'message-display' },
    });
  });
  it.each([
    ['引用自动提及', 'quote-auto-mention', 'chat-interaction'],
    ['退格取消引用', 'quote-backspace-remove', 'chat-interaction'],
    ['表情自动替换', 'slash-emoji-auto-replace', 'chat-interaction'],
    ['显示群成员昵称', 'group-message-name', 'message-display'],
    ['显示群成员等级', 'group-message-level', 'message-display'],
    ['显示群成员头衔与身份', 'group-message-title', 'message-display'],
  ])('%s 搜索直达群消息或引用设置', (keyword, settingId, section) => {
    expect(searchAppEntries(keyword)[0]?.target).toMatchObject({
      kind: 'setting',
      section,
      settingId,
    });
  });
  it.each([
    ['默认聊天模型', 'llm-default-model'],
    ['默认视觉模型', 'llm-default-vision-model'],
    ['默认向量模型', 'llm-default-embedding-model'],
    ['嵌入模型', 'llm-default-embedding-model'],
  ])('%s 搜索直达对应默认模型设置', (keyword, settingId) => {
    const entry = searchAppEntries(keyword)[0];
    expect(entry?.target).toMatchObject({ kind: 'setting', section: 'agentlab', settingId });
  });
  it('常规在启动后展示在线能力与授权，旧主页入口仍能定位', () => {
    expect(settingsGroupFor('startup').sections).toEqual([
      'startup',
      'account',
      'appearance',
      'global',
      'privacy',
    ]);
    expect(SETTINGS_PAGE_LABELS.startup).toBe('启动与退出');
    expect(SETTINGS_PAGE_LABELS.appearance).toBe('外观与布局');
    expect(SETTINGS_PAGE_LABELS.global).toBe('通知与提醒');
    expect(settingsSectionFor('home')).toBe('startup');
  });
  it.each([
    ['使用仿 Windows 窗口按钮', 'windows-style-controls', 'appearance', '外观与布局'],
    ['关闭按钮行为', 'window-close-behavior', 'startup', '启动与退出'],
  ] as const)('%s 搜索与旧入口都定位新页面', (item, settingId, section, label) => {
    expect(searchAppEntries(item)[0]).toMatchObject({
      path: `设置 / 常规 / ${label}`,
      target: { kind: 'setting', section, settingId },
    });
    expect(resolveSettingsTarget({ section: 'global', item })).toMatchObject({
      section,
      settingId,
    });
    expect(resolveSettingsTarget({ section: 'global', settingId })).toMatchObject({
      section,
      settingId,
    });
  });
  it('关于第二项为 WeQ 存储管理，旧帮助和更新提醒深链归到新页面', () => {
    expect(settingsGroupFor('version').sections).toEqual([
      'version',
      'weq-storage',
      'accounts',
      'backup',
      'logs',
      'faq',
      'feedback',
    ]);
    expect(settingsSectionFor('help')).toBe('faq');
    expect(settingsSectionFor('updates')).toBe('version');
    for (const id of ['version', 'faq', 'logs', 'feedback', 'help', 'updates'] as const) {
      expect(settingsGroupFor(id).id).toBe('help');
    }
  });
  it.each(['weq-storage', 'storage'] as const)('存储入口 %s 定位关于中的第二项', (id) => {
    expect(settingsSectionFor(id)).toBe('weq-storage');
    expect(settingsGroupFor(id).id).toBe('help');
    expect(settingsGroupFor(id).sections[1]).toBe('weq-storage');
    expect(settingsGroupFor('startup').sections).not.toContain('weq-storage');
  });
  it.each(['WeQ 存储管理', '桌面缓存'])('%s 搜索显示关于中的存储管理路径', (keyword) => {
    const entry = searchAppEntries(keyword)[0];
    expect(entry?.path).toBe('设置 / 关于 WeQ / WeQ 存储管理');
    expect(entry?.target).toMatchObject({ kind: 'setting', section: 'weq-storage' });
  });
  it('模型保留单个一级分类，克隆设置不再占用独立页面', () => {
    expect(SETTINGS_GROUPS.map((group) => group.label)).toEqual([
      '常规',
      '基础功能',
      '增强功能',
      '凭据与数据',
      'WeQ 服务',
      '关于 WeQ',
    ]);
    expect(settingsGroupFor('model-usage').sections).toEqual([
      'enhancement-packs',
      'recognition',
      'agentlab',
      'model-usage',
      'reply-suggestions',
      'intent-sense',
      'interaction-profile',
    ]);
    expect(settingsSectionFor('voice')).toBe('recognition');
    expect(settingsSectionFor('ocr')).toBe('recognition');
    expect(settingsSectionFor('local-models')).toBe('enhancement-packs');
    expect(settingsSectionFor('intent-models')).toBe('enhancement-packs');
    expect(settingsSectionFor('tts')).toBe('agentlab');
    expect(settingsGroupFor('credentials').id).toBe('data');
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
    expect(settingsGroupFor('media').sections).toContain('resource-loading');
    expect(settingsGroupFor('backup')).toEqual({
      id: 'help',
      label: '关于 WeQ',
      sections: ['version', 'weq-storage', 'accounts', 'backup', 'logs', 'faq', 'feedback'],
    });
    for (const id of ['database', 'database-status', 'maintenance'] as const) {
      expect(settingsGroupFor(id)).toEqual({
        id: 'data',
        label: '凭据与数据',
        sections: [
          'credentials',
          'resource-loading',
          'qq-storage',
          'database-management',
          'diagnostics',
        ],
      });
    }
  });

  it('账号配置归关于，媒体与登录记录合并到对应页面，旧分区仍可跳转', () => {
    expect(settingsGroupFor('performance-monitor').id).toBe('help');
    expect(settingsGroupFor('media').id).toBe('data');
    expect(settingsGroupFor('accounts').sections).not.toContain('performance-monitor');
    expect(settingsGroupFor('diagnostics').id).toBe('data');
    expect(settingsGroupFor('accounts').id).toBe('help');
    expect(settingsGroupFor('backup').id).toBe('help');
    expect(settingsSectionFor('rkey')).toBe('credentials');
    expect(SETTINGS_PAGE_LABELS.diagnostics).toBe('QQ 高级工具');
    expect(settingsSectionFor('database-tolerance')).toBe('database-management');
    expect(settingsSectionFor('qq-accounts')).toBe('diagnostics');
    expect(settingsSectionFor('media')).toBe('resource-loading');
    expect(SETTINGS_PAGE_LABELS['database-management']).toBe('QQ 数据库管理');
    expect(SETTINGS_PAGE_LABELS['qq-storage']).toBe('QQ 资源管理');
    expect(SETTINGS_PAGE_LABELS.agentlab).toBe('API 配置');
    expect(SETTINGS_PAGE_LABELS['model-usage']).toBe('API 用量');
  });

  it.each([
    ['诊断工具', 'QQ 高级工具', '凭据与数据'],
    ['QQ 协议工具', 'QQ 高级工具', '凭据与数据'],
    ['QQ 账号管理', '登录记录与设备标识', '凭据与数据'],
    ['QQ 登录记录管理', '登录记录与设备标识', '凭据与数据'],
    ['数据库宽容', 'QQ 数据库管理', '凭据与数据'],
    ['资源目录管理', 'QQ 资源管理', '凭据与数据'],
    ['已保存的 provider', '已保存的服务商', '增强功能'],
    ['优先使用 CDN', '优先直连 QQ 加载图片', '凭据与数据'],
    ['媒体来源', '资源加载', '凭据与数据'],
    ['性能监视', '性能监视', '关于 WeQ'],
  ])('旧名或新名 %s 展示规范名称 %s 与新路径', (keyword, title, group) => {
    const entry = searchAppEntries(keyword)[0];
    expect(entry?.title).toBe(title);
    expect(entry?.path).toContain(`设置 / ${group} /`);
  });

  it('保留原分区深链，每个二级页只归属一个分类', () => {
    const ids = SETTINGS_GROUPS.flatMap((group) => group.sections);
    expect(SETTINGS_GROUPS).toHaveLength(6);
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
