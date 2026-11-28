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
  it.each(['会话浏览', '消息阅读', '消息区域'])(
    '%s 搜索统一显示会话浏览并保留旧名称入口',
    (keyword) => {
      expect(SETTINGS_PAGE_LABELS['message-display']).toBe('会话浏览');
      expect(searchAppEntries(keyword)[0]).toMatchObject({
        path: '设置 / 聊天 / 会话浏览',
        target: { kind: 'setting', section: 'message-display' },
      });
    },
  );
  it.each([
    ['引用自动提及', 'quote-auto-mention', 'chat-interaction'],
    ['退格取消引用', 'quote-backspace-remove', 'chat-interaction'],
    ['表情自动替换', 'slash-emoji-auto-replace', 'chat-interaction'],
    ['显示群成员昵称', 'group-message-name', 'message-content'],
    ['显示群成员等级', 'group-message-level', 'message-content'],
    ['显示群成员头衔与身份', 'group-message-title', 'message-content'],
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
  it('助手默认模型与 API 默认聊天模型可以分别搜索', () => {
    expect(searchAppEntries('助手默认聊天模型')[0]?.target).toMatchObject({
      kind: 'setting',
      section: 'weq-assistant',
      settingId: 'weq-assistant-default-model',
    });
  });
  it('代理和提醒归 QQ 在线能力，长期授权保留独立入口', () => {
    expect(SETTINGS_PAGE_LABELS.startup).toBe('启动与退出');
    expect(SETTINGS_PAGE_LABELS.appearance).toBe('主题与布局');
    expect(SETTINGS_PAGE_LABELS.global).toBe('通知与提醒');
    expect(settingsSectionFor('home')).toBe('home');
    expect(
      searchAppEntries('在线能力与授权')
        .filter((entry) => entry.id.startsWith('settings.page.'))
        .map((entry) => entry.target),
    ).toEqual(
      ['account', 'long-term-authorization'].map((section) => ({
        kind: 'setting',
        section,
      })),
    );
  });
  it.each([
    ['qq-proxy', 'QQ 代理连接', 'qq-proxy-connection'],
    ['qq-status-reminders', '状态提醒', 'qq-status-reminders'],
  ] as const)('旧页面 %s 和搜索仍可定位对应卡片', (section, keyword, settingId) => {
    expect(resolveSettingsTarget({ section })).toMatchObject({ section: 'account', settingId });
    expect(searchAppEntries(keyword)[0]).toMatchObject({
      path: '设置 / QQ / 能力档位',
      target: { kind: 'setting', section: 'account', settingId },
    });
  });
  it.each([
    ['qzone', 'QQ 空间', '转发时引用上一人文案', 'qzone-forward'],
    ['mail', 'QQ 邮箱', '邮件查询间隔', 'mail-poll-interval'],
  ] as const)('%s 的设置页和条目保留搜索入口', (section, label, keyword, settingId) => {
    const page = searchAppEntries(label).find((entry) => entry.id === `settings.page.${section}`);
    expect(page).toMatchObject({
      path: `${label} / 设置`,
      target: { kind: 'setting', section },
    });
    expect(searchAppEntries(keyword)[0]).toMatchObject({
      path: `${label} / 设置`,
      target: { kind: 'setting', section, settingId },
    });
  });
  it.each([
    ['使用仿 Windows 窗口按钮', 'windows-style-controls', 'appearance', '外观 / 主题与布局'],
    ['关闭按钮行为', 'window-close-behavior', 'startup', '通用 / 启动与退出'],
  ] as const)('%s 搜索与旧入口都定位新页面', (item, settingId, section, path) => {
    expect(searchAppEntries(item)[0]).toMatchObject({
      path: `设置 / ${path}`,
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
  it('存储和备份归应用，帮助、更新和日志与性能归关于，旧入口仍可用', () => {
    expect(settingsSectionFor('help')).toBe('faq');
    expect(settingsSectionFor('updates')).toBe('version');
    expect(settingsSectionFor('storage')).toBe('weq-storage');
    for (const id of ['storage', 'backup', 'accounts'] as const) {
      expect(settingsGroupFor(id).id).toBe('app');
    }
    expect(settingsGroupFor('performance-monitor').id).toBe('about');
    expect(settingsGroupFor('help').sections).toEqual(['version', 'faq', 'logs', 'feedback']);
  });
  it.each(['WeQ 存储管理', '桌面缓存'])('%s 搜索显示应用中的存储管理路径', (keyword) => {
    const entry = searchAppEntries(keyword)[0];
    expect(entry?.path).toBe('设置 / 应用 / WeQ 存储管理');
    expect(entry?.target).toMatchObject({ kind: 'setting', section: 'weq-storage' });
  });
  it('模型和增强包的旧入口仍定位对应页面', () => {
    expect(settingsSectionFor('voice')).toBe('recognition');
    expect(settingsSectionFor('ocr')).toBe('recognition');
    expect(settingsSectionFor('local-models')).toBe('enhancement-packs');
    expect(settingsSectionFor('intent-models')).toBe('enhancement-packs');
    expect(settingsSectionFor('tts')).toBe('agentlab');
  });

  it('资源加载与 QQ 数据维护的旧入口分别归入通用和 QQ', () => {
    expect(settingsSectionFor('rkey')).toBe('resource-loading');
    expect(settingsSectionFor('media')).toBe('resource-loading');
    expect(settingsGroupFor('media').id).toBe('general');
    expect(settingsSectionFor('database-tolerance')).toBe('database-management');
    expect(settingsSectionFor('qq-accounts')).toBe('qq-accounts');
    for (const id of ['database', 'database-status', 'maintenance'] as const) {
      expect(settingsGroupFor(id).id).toBe('qq');
    }
  });

  it.each([
    ['诊断工具', '高级工具', 'QQ'],
    ['QQ 协议工具', '高级工具', 'QQ'],
    ['QQ 设备标识与登录账号', '登录管理', 'QQ'],
    ['QQ 账号管理', '设备标识与登录账号', 'QQ'],
    ['QQ 登录记录管理', '设备标识与登录账号', 'QQ'],
    ['登录账号列表', '设备标识与登录账号', 'QQ'],
    ['数据库宽容', '数据库管理', 'QQ'],
    ['资源目录管理', '资源管理', 'QQ'],
    ['已保存的 provider', '已保存的服务商', 'AI'],
    ['优先使用 CDN', '优先直连 QQ 加载图片', '通用'],
    ['媒体来源', '资源加载', '通用'],
    ['省流量模式', '省流量模式', '通用'],
    ['性能监视', '性能监视', '关于'],
  ])('旧名或新名 %s 展示规范名称 %s 与新路径', (keyword, title, group) => {
    const entry = searchAppEntries(keyword)[0];
    expect(entry?.title).toBe(title);
    expect(entry?.path).toContain(`设置 / ${group} /`);
  });

  it('保留原分区深链，每个二级页只归属一个分类', () => {
    const ids = SETTINGS_GROUPS.flatMap((group) => group.sections);
    expect([...ids].sort()).toEqual(Object.keys(SETTINGS_PAGE_LABELS).sort());
    expect(settingsSectionFor('applock')).toBe('privacy');
    expect(settingsGroupFor('privacy').id).toBe('app');
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
