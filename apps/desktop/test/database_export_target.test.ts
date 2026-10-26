// @vitest-environment node
import { expect, it } from 'vitest';
import {
  createDatabaseExportTarget,
  databaseExportTargetMatches,
} from '../src/shared/database_export_target';

const source = { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic-source' };

it('冻结来源和精确数据库路径，去重但不把空选择解释成全部', () => {
  const paths = ['/synthetic/with space.db', '/synthetic/with space.db'];
  const target = createDatabaseExportTarget(source, paths);
  paths.push('/synthetic/other.db');
  expect(target.dbPaths).toEqual(['/synthetic/with space.db']);
  expect(Object.isFrozen(target)).toBe(true);
  expect(Object.isFrozen(target.dbPaths)).toBe(true);
  expect(() => createDatabaseExportTarget(source, [])).toThrow('明确选择');
  expect(() => createDatabaseExportTarget(source, [''])).toThrow('明确选择');
});

it('必须同时匹配账号与配置来源，同号换源不能复用导出目标', () => {
  const target = createDatabaseExportTarget(source, ['/synthetic/msg.db']);
  expect(databaseExportTargetMatches(target, source)).toBe(true);
  expect(databaseExportTargetMatches(target, null)).toBe(false);
  expect(databaseExportTargetMatches(target, { ...source, expectedAccountUin: '10002' })).toBe(
    false,
  );
  expect(databaseExportTargetMatches(target, { ...source, expectedAccountConfigId: 'other' })).toBe(
    false,
  );
  expect(() =>
    createDatabaseExportTarget({ ...source, expectedAccountConfigId: '' }, ['x']),
  ).toThrow('来源');
});
