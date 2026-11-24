// @vitest-environment node
import { expect, it } from 'vitest';
import {
  SETTINGS_PAGE_LABELS,
  resolveSettingsTarget,
  settingsGroupFor,
} from '../src/renderer/src/components/settings/navigation';
import { resetCards } from '../src/shared/settings_reset';

it('QQ 在线能力归能力，数据库监听和读取归 QQ 数据库管理', () => {
  expect(SETTINGS_PAGE_LABELS.account).toBe('QQ 在线能力');
  expect(settingsGroupFor('account').id).toBe('capabilities');
  expect(settingsGroupFor('database-management').sections).not.toContain('account');
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

it('在线能力与代理各自恢复本页，旧代理单组恢复仍可用', () => {
  expect(resetCards({ page: 'account' }).map(([, card]) => card)).toEqual(['attach']);
  const proxyCards = resetCards({ page: 'qq-proxy' });
  expect(proxyCards.map(([, card]) => card)).toEqual(['qq-client-sync']);
  expect(resetCards({ page: 'account', card: 'qq-client-sync' })).toEqual(proxyCards);
});
