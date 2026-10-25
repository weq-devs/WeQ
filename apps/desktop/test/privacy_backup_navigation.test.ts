import { describe, expect, it } from 'vitest';
import { searchAppEntries } from '../src/renderer/src/components/search/appSearchCatalog';

describe('隐私与备份迁移后的搜索入口', () => {
  it('应用锁与隐私模式的旧名称仍定位常规隐私页', () => {
    for (const keyword of ['应用锁', '隐私模式', '无操作自动上锁']) {
      const result = searchAppEntries(keyword)[0]!;
      expect(result.path).toBe('设置 / 常规 / 隐私');
      expect(result.target).toMatchObject({ kind: 'setting', section: 'privacy' });
    }
  });

  it('备份旧名称与操作只定位关于中的配置备份页', () => {
    for (const keyword of ['备份与恢复', '设置备份', '导入备份', '恢复默认设置']) {
      const result = searchAppEntries(keyword)[0]!;
      expect(result.path).toBe('设置 / 关于 WeQ / 配置备份与恢复');
      expect(result.target).toMatchObject({ kind: 'setting', section: 'backup' });
    }
  });
});
