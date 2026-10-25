import { describe, expect, it } from 'vitest';
import {
  APP_SEARCH_ENTRIES,
  searchAppEntries,
} from '../src/renderer/src/components/search/appSearchCatalog';
import { SETTINGS_GROUPS } from '../src/renderer/src/components/settings/navigation';

describe('功能与设置目录搜索', () => {
  it('空白和未知关键词没有结果，名称匹配优先于别名', () => {
    expect(searchAppEntries('  ')).toEqual([]);
    expect(searchAppEntries('不存在的合成功能')).toEqual([]);
    expect(searchAppEntries('导出')[0]?.title).toBe('导出');
    expect(searchAppEntries('  oCr  ').some((entry) => entry.title === '图片识别')).toBe(true);
  });

  it('功能指向真实入口，设置别名指向具体控件而不是执行配置变更', () => {
    expect(searchAppEntries('年度报告')[0]?.target).toEqual({ kind: 'view', view: 'annual' });
    expect(searchAppEntries('导出查看器')[0]?.target).toEqual({ kind: 'tool', tool: 'viewer' });
    expect(searchAppEntries('深色模式')[0]?.target).toEqual({
      kind: 'setting',
      section: 'appearance',
      item: '基础模式',
    });
    expect(searchAppEntries('消息序号')[0]?.target).toEqual({
      kind: 'setting',
      section: 'chat-messages',
      item: '显示消息序号（seq）',
    });
    expect(searchAppEntries('缓存目录')[0]?.target).toEqual({
      kind: 'setting',
      section: 'weq-storage',
      item: '缓存目录',
    });
  });

  it('所有可见设置分区均可搜索，条目身份唯一且排名稳定', () => {
    const sections = new Set(
      APP_SEARCH_ENTRIES.flatMap((entry) =>
        entry.target.kind === 'setting' ? [entry.target.section] : [],
      ),
    );
    for (const section of SETTINGS_GROUPS.flatMap((group) => group.sections)) {
      expect(sections.has(section), section).toBe(true);
    }
    expect(new Set(APP_SEARCH_ENTRIES.map((entry) => entry.id)).size).toBe(
      APP_SEARCH_ENTRIES.length,
    );
    expect(searchAppEntries('设置')).toEqual(searchAppEntries('设置'));
  });
});
