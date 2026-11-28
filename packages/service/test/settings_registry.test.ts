import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '../src/bootstrap/user_config';
import { DEFAULT_INTENT_SENSE_CONFIG } from '../src/account/intent_sense';
import { preferenceDefaults } from '../src/common/client_preferences';
import {
  SETTINGS_CATALOG,
  SETTINGS_FIELDS,
  APP_SETTING_FIELDS,
  CLIENT_SETTING_FIELDS,
  INTENT_SETTING_FIELDS,
  SETTINGS_PAGE_LABELS,
  APP_SETTINGS_RESET_POLICY,
  listSettings,
  settingDefinition,
  globalSettingsDefaults,
} from '../src/common/settings_catalog';
import {
  SETTINGS_RESET_CARDS,
  planSettingsReset,
  resetCards,
} from '../src/common/settings_catalog/reset';
import { SETTINGS_KEYWORDS } from '../src/common/settings_catalog/keywords';

describe('设置统一注册表', () => {
  it('设置身份、恢复身份、页面与分区完整且唯一，不产生悬空绑定', () => {
    expect(new Set(SETTINGS_CATALOG.map((item) => item.id)).size).toBe(SETTINGS_CATALOG.length);
    expect(new Set(SETTINGS_FIELDS.map((item) => item.id)).size).toBe(SETTINGS_FIELDS.length);
    for (const field of SETTINGS_FIELDS) {
      const item = settingDefinition(field.settingId);
      const card = SETTINGS_RESET_CARDS.find(([, id]) => id === field.card);
      expect(card, field.id).toBeDefined();
      expect([item.section, ...item.from], field.id).toContain(card?.[0]);
      // 共用开关可在多个页面原位恢复，但每个绑定都必须对应同源的主入口。
      expect(
        SETTINGS_FIELDS.some(
          (binding) =>
            binding.settingId === field.settingId &&
            binding.source === field.source &&
            binding.key === field.key &&
            SETTINGS_RESET_CARDS.some(([page, id]) => page === item.section && id === binding.card),
        ),
        field.id,
      ).toBe(true);
      expect(item.fields, field.id).toContain(field);
    }
    for (const id of Object.keys(SETTINGS_KEYWORDS))
      expect(() => settingDefinition(id)).not.toThrow();
    for (const item of SETTINGS_CATALOG)
      expect(Object.hasOwn(SETTINGS_PAGE_LABELS, item.section)).toBe(true);
  });

  it('默认值只引用实际配置字段，新增必需应用字段必须登记恢复策略', () => {
    for (const field of APP_SETTING_FIELDS)
      expect(Object.hasOwn(DEFAULT_APP_SETTINGS, field.key), field.id).toBe(true);
    for (const field of CLIENT_SETTING_FIELDS)
      expect(Object.hasOwn(preferenceDefaults, field.key), field.id).toBe(true);
    for (const field of INTENT_SETTING_FIELDS)
      expect(Object.hasOwn(DEFAULT_INTENT_SENSE_CONFIG, field.key), field.id).toBe(true);
    expect(Object.keys(APP_SETTINGS_RESET_POLICY).sort()).toEqual(
      Object.keys(DEFAULT_APP_SETTINGS).sort(),
    );
  });

  it('公开枚举与前端、搜索使用相同稳定身份，未知页面不返回全部配置', () => {
    expect(listSettings().map((item) => item.id)).toEqual(SETTINGS_CATALOG.map((item) => item.id));
    expect(listSettings({ page: 'appearance' }).every((item) => item.page === 'appearance')).toBe(
      true,
    );
    expect(listSettings({ query: '  深色模式  ' }).map((item) => item.id)).toContain('theme-mode');
    expect(listSettings({ page: 'qq-proxy' }).map(({ id, page }) => [id, page])).toEqual([
      ['qq-proxy-connection', 'account'],
    ]);
    expect(listSettings({ page: 'qq-status-reminders' }).map(({ id }) => id)).toEqual([
      'qq-status-indicator',
      'qq-online-notification',
    ]);
    expect(listSettings({ query: '不存在的设置字段' })).toEqual([]);
    expect(() => listSettings({ page: 'not-a-page' })).toThrow('未知设置页面');
    for (const item of listSettings()) {
      expect(item).not.toHaveProperty('current');
      expect(item).not.toHaveProperty('value');
      expect(item.reset.every((field) => !('current' in field) && !('defaultValue' in field))).toBe(
        true,
      );
    }
  });

  it('全局恢复与本页规划器均尊重目录选择、差异与失败重试', () => {
    const items = [
      { id: 'value', current: true, defaultValue: false },
      { id: 'path', current: '/synthetic/custom', defaultValue: null, directory: true },
      { id: 'same', current: 1, defaultValue: 1 },
    ];
    expect(planSettingsReset(items).map((item) => item.id)).toEqual(['value']);
    expect(planSettingsReset(items, { directories: ['path'] }).map((item) => item.id)).toEqual([
      'value',
      'path',
    ]);
    expect(planSettingsReset(items, { retry: ['same'] }).map((item) => item.id)).toEqual(['same']);
    expect(planSettingsReset(items, { retry: [] })).toEqual([]);
    expect(() => planSettingsReset(items, { retry: ['foreign'] })).toThrow('不属于当前范围');
    expect(() => planSettingsReset(items, { directories: ['foreign'] })).toThrow('不属于当前范围');
  });

  it('浏览器设置与 Remote 的搜索和恢复范围独立，旧浏览器卡片仍能恢复', () => {
    expect(listSettings({ page: 'browser-access' }).map(({ id }) => id)).toEqual([
      'web-enabled',
      'web-autostart',
    ]);
    expect(listSettings({ page: 'remote' }).map(({ id }) => id)).toContain('remote-pairing');
    expect(listSettings({ page: 'remote' }).map(({ id }) => id)).not.toContain('web-enabled');
    expect(resetCards({ page: 'remote' }).map(([, card]) => card)).toEqual(['remote']);
    expect(resetCards({ page: 'browser-access' }).map(([, card]) => card)).toEqual(['web']);
    expect(resetCards({ page: 'remote', card: 'web' })).toEqual(
      resetCards({ page: 'browser-access' }),
    );
  });

  it('全局恢复按同一策略选择偏好、API 与连接配置，不修改输入', () => {
    const current = structuredClone(DEFAULT_APP_SETTINGS);
    current.home.showGreeting = !DEFAULT_APP_SETTINGS.home.showGreeting;
    current.mcp = { enabled: true, port: 39001, token: 'synthetic-only' };
    current.webServiceAutoStart = true;
    const unchanged = structuredClone(current);
    const kept = globalSettingsDefaults(current, DEFAULT_APP_SETTINGS, {});
    expect(kept.home).toEqual(DEFAULT_APP_SETTINGS.home);
    expect(kept.mcp).toEqual(current.mcp);
    expect(kept.webServiceAutoStart).toBe(true);
    const cleared = globalSettingsDefaults(current, DEFAULT_APP_SETTINGS, {
      clearApi: true,
      resetConnections: ['webServiceAutoStart'],
    });
    expect(cleared.mcp).toEqual(DEFAULT_APP_SETTINGS.mcp);
    expect(cleared.webServiceAutoStart).toBe(DEFAULT_APP_SETTINGS.webServiceAutoStart);
    expect(current).toEqual(unchanged);
    kept.home.showGreeting = !kept.home.showGreeting;
    expect(current).toEqual(unchanged);
  });
});
