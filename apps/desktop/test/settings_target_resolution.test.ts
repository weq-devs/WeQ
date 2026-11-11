// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_PAGE_LABELS,
  SETTINGS_GROUPS,
  resolveSettingsTarget,
  settingsGroupFor,
  type SectionId,
} from '../src/renderer/src/components/settings/navigation';

describe('设置重构的规范目标与旧入口分流', () => {
  it('七组页面各归其位，主页并入启动，聊天拆成三个二级页面', () => {
    expect(SETTINGS_GROUPS.map((group) => group.label)).toEqual([
      '常规',
      '基础功能',
      'AI 功能',
      '凭据与账号',
      '数据库与资源',
      'WeQ 服务',
      '关于 WeQ',
    ]);
    const sections = SETTINGS_GROUPS.flatMap((group) => group.sections);
    expect(sections).toHaveLength(Object.keys(SETTINGS_PAGE_LABELS).length);
    expect(new Set(sections)).toEqual(new Set(Object.keys(SETTINGS_PAGE_LABELS)));
    expect(SETTINGS_GROUPS[0]?.sections).not.toContain('home');
    expect(SETTINGS_GROUPS[0]?.sections[0]).toBe('startup');
    expect(SETTINGS_GROUPS[1]?.sections).toEqual([
      'chat-messages',
      'message-display',
      'chat-interaction',
      'call-recording',
      'qzone',
      'mail',
    ]);
  });

  it.each<{
    section: SectionId;
    item?: string;
    target: string;
    settingId?: string;
  }>([
    { section: 'home', target: 'startup', settingId: 'home-settings' },
    { section: 'home', item: '一言屏蔽词', target: 'startup', settingId: 'home-blocked-words' },
    { section: 'applock', target: 'privacy', settingId: 'app-lock' },
    { section: 'applock', item: '启用应用锁', target: 'privacy', settingId: 'app-lock' },
    { section: 'applock', item: '解锁方式', target: 'privacy', settingId: 'unlock-method' },
    { section: 'applock', item: '空闲自动锁定', target: 'privacy', settingId: 'auto-lock' },
    { section: 'saving', target: 'global' },
    { section: 'storage', target: 'weq-storage' },
    {
      section: 'storage',
      item: '优先使用 CDN',
      target: 'resource-loading',
      settingId: 'prefer-cdn',
    },
    {
      section: 'remote',
      item: '优先使用 CDN',
      target: 'resource-loading',
      settingId: 'prefer-cdn',
    },
    { section: 'global', target: 'global' },
    {
      section: 'global',
      item: '默认发送正在输入状态',
      target: 'chat-interaction',
      settingId: 'typing-status',
    },
    { section: 'account', target: 'account' },
    {
      section: 'account',
      item: '同步已读状态到 QQ',
      target: 'chat-messages',
      settingId: 'read-sync',
    },
    {
      section: 'account',
      item: '手动标记时上报已读位置',
      target: 'chat-messages',
      settingId: 'read-sync',
    },
    { section: 'message-display', item: '显示消息序号（seq）', target: 'message-display' },
    { section: 'anti-recall', target: 'chat-interaction', settingId: 'anti-recall' },
    { section: 'media', target: 'media', settingId: 'linked-resources' },
    {
      section: 'media',
      item: '允许使用外部安卓图片缓存',
      target: 'media',
      settingId: 'external-chatpic',
    },
    { section: 'rkey', target: 'credentials', settingId: 'external-rkey' },
    {
      section: 'accounts',
      item: '关联资源目录',
      target: 'media',
      settingId: 'linked-resources',
    },
    { section: 'database', target: 'database-tolerance' },
    {
      section: 'database',
      item: '数据库异常时弹窗提醒',
      target: 'database-repair',
      settingId: 'damage-reminder',
    },
    { section: 'database-status', target: 'database-tolerance', settingId: 'tolerance-records' },
    { section: 'maintenance', target: 'database-management' },
    {
      section: 'maintenance',
      item: '数据库修复',
      target: 'database-repair',
      settingId: 'database-repair',
    },
    {
      section: 'maintenance',
      item: '导出明文数据库',
      target: 'database-management',
      settingId: 'database-export',
    },
    {
      section: 'maintenance',
      item: '存储占用',
      target: 'qq-storage',
      settingId: 'qq-storage-analysis',
    },
    {
      section: 'maintenance',
      item: '清理缓存',
      target: 'qq-storage',
      settingId: 'qq-storage-cleanup',
    },
    {
      section: 'maintenance',
      item: '本地缓存',
      target: 'qq-storage',
      settingId: 'resource-viewer',
    },
    { section: 'maintenance', item: '密钥扫描', target: 'credentials', settingId: 'key-scan' },
    {
      section: 'maintenance',
      item: '其它设备密钥',
      target: 'credentials',
      settingId: 'other-device-key',
    },
    { section: 'applock', item: '隐私模式', target: 'privacy', settingId: 'privacy-mode' },
    { section: 'daemon', target: 'version', settingId: 'builtin-components' },
    { section: 'assistant', target: 'assistant' },
    { section: 'tts', target: 'agentlab' },
    { section: 'local-models', target: 'voice' },
    { section: 'intent-models', target: 'intent-sense' },
    { section: 'help', target: 'faq' },
    { section: 'updates', target: 'version' },
  ])('$section / $item → $target', ({ section, item, target, settingId }) => {
    const resolved = resolveSettingsTarget({ section, item });
    expect(resolved.section).toBe(target);
    if (settingId) expect(resolved.settingId).toBe(settingId);
    expect(settingsGroupFor(resolved.section).sections).toContain(resolved.section);
    expect(resolveSettingsTarget(resolved)).toEqual(resolved);
  });

  it('稳定 ID 优先于旧标签，同名条目不跨页面误分流', () => {
    expect(
      resolveSettingsTarget({ section: 'accounts', settingId: 'external-chatpic' }),
    ).toMatchObject({ section: 'media', settingId: 'external-chatpic' });
    expect(
      resolveSettingsTarget({
        section: 'storage',
        item: '已经改名的标签',
        settingId: 'prefer-cdn',
      }),
    ).toMatchObject({ section: 'resource-loading', settingId: 'prefer-cdn' });
    expect(resolveSettingsTarget({ section: 'call-recording', item: '保存位置' }).section).toBe(
      'call-recording',
    );
    expect(resolveSettingsTarget({ section: 'storage', item: '未知未来设置' })).toEqual({
      section: 'weq-storage',
      item: '未知未来设置',
    });
  });
});
