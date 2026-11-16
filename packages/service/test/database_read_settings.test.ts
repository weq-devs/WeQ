import { afterEach, expect, it } from 'vitest';
import { DEFAULT_DATABASE_READ_CONCURRENCY, configureDatabaseReadConcurrency } from '@weq/db';
import { configFixture } from './support/user_config';

afterEach(() => configureDatabaseReadConcurrency(DEFAULT_DATABASE_READ_CONCURRENCY));
it('数据库读取并发上限为宿主级设置，保存后重开和无关设置更新均保留', () => {
  const f = configFixture();
  expect(f.service.getSettings().databaseReadConcurrency).toBe(DEFAULT_DATABASE_READ_CONCURRENCY);
  f.service.setSettings({ databaseReadConcurrency: 8 });
  f.service.setSettings({ showMessageTime: true });
  expect(f.open().getSettings().databaseReadConcurrency).toBe(8);
  f.service.setSettings({ databaseReadConcurrency: 1 });
  expect(f.open().getSettings().databaseReadConcurrency).toBe(1);
});
it('旧配置缺项和损坏值回到默认，非法修改不覆盖当前有效值', () => {
  for (const value of [0, 9, 1.5, '4', null, Infinity]) {
    const f = configFixture({ settings: { databaseReadConcurrency: value } });
    expect(f.service.getSettings().databaseReadConcurrency).toBe(DEFAULT_DATABASE_READ_CONCURRENCY);
  }
  const f = configFixture();
  f.service.setSettings({ databaseReadConcurrency: 6 });
  expect(f.service.setSettings({ databaseReadConcurrency: 100 }).databaseReadConcurrency).toBe(6);
});
