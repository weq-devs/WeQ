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
  it('新增隐私截图与受限横幅由公开搜索条目定位稳定设置项，不执行操作', () => {
    expect(searchAppEntries('截图隐私')[0]?.target).toMatchObject({
      kind: 'setting',
      section: 'privacy',
      settingId: 'privacy-menu-capture',
    });
    expect(searchAppEntries('受限横幅')[0]?.target).toMatchObject({
      kind: 'setting',
      section: 'account',
      settingId: 'restricted-mode-banner',
    });
  });
});
