// @vitest-environment node
import { expect, it } from 'vitest';
import {
  SETTINGS_GROUPS,
  SETTINGS_PAGE_LABELS,
  resolveSettingsTarget,
  settingsGroupFor,
} from '../src/renderer/src/components/settings/navigation';
import { resetCards } from '../src/shared/settings_reset';

it('在线能力与授权归常规，数据分类不再保留独立监听页面', () => {
  expect(SETTINGS_PAGE_LABELS.account).toBe('在线能力与授权');
  expect(settingsGroupFor('account').id).toBe('general');
  expect(SETTINGS_GROUPS.find((group) => group.id === 'general')?.sections.slice(0, 2)).toEqual([
    'startup',
    'account',
  ]);
  expect(SETTINGS_GROUPS.find((group) => group.id === 'data')?.sections).not.toContain('account');
});

it.each([
  [{ section: 'account', item: '启用数据库监听' }, 'realtime-enabled'],
  [{ section: 'account', item: '监听与读取' }, 'database-listening'],
  [{ section: 'logs', item: '数据库读取并发上限' }, 'database-read-concurrency'],
] as const)('旧监听与读取入口 %j 定位数据库管理内的实际设置', (target, settingId) => {
  expect(resolveSettingsTarget(target)).toMatchObject({
    section: 'database-management',
    settingId,
  });
});

it.each(['realtime', 'database-read'] as const)('旧账号页单组恢复 %s 仍指向同一设置', (card) => {
  expect(resetCards({ page: 'account', card })[0]?.slice(0, 2)).toEqual([
    'database-management',
    card,
  ]);
  expect(resetCards({ page: 'database-management', card })[0]?.slice(0, 2)).toEqual([
    'database-management',
    card,
  ]);
});

it('在线能力页整页恢复不再包含数据库设置', () => {
  const cards = resetCards({ page: 'account' }).map((entry) => entry[1]);
  expect(cards).toContain('attach');
  expect(cards).not.toContain('realtime');
  expect(cards).not.toContain('database-read');
});
