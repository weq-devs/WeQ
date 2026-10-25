// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_GROUPS,
  settingsGroupFor,
  settingsScopeFor,
  settingsSectionFor,
} from '../src/renderer/src/components/settings/navigation';
import {
  searchAppEntries,
  APP_SEARCH_ENTRIES,
} from '../src/renderer/src/components/search/appSearchCatalog';

describe('basic_settings_navigation', () => {
  describe('基础功能内的通话录音入口', () => {
    it('基础功能位于常规之后，通话录音为第二项，深链身份与全局作用域不变', () => {
      const group = settingsGroupFor('call-recording');
      expect(SETTINGS_GROUPS[1]?.label).toBe('基础功能');
      expect(group.label).toBe('基础功能');
      expect(group.sections.indexOf('call-recording')).toBe(1);
      expect(settingsGroupFor('message-display').id).toBe(group.id);
      expect(group.sections.slice(2)).toEqual(['qzone', 'mail']);
      expect(settingsSectionFor('call-recording')).toBe('call-recording');
      expect(settingsScopeFor('call-recording')).toBeNull();
    });
    it('旧名和新名均可搜索到新位置，搜索只定位，不执行录音或目录选择', () => {
      for (const name of ['通话录音', '通话与录音']) {
        const result = searchAppEntries(name)[0]!;
        expect(result.title).toBe('通话录音');
        expect(result.target).toEqual({ kind: 'setting', section: 'call-recording' });
        expect(result.path).toBe('设置 / 基础功能 / 通话录音');
      }
      expect(searchAppEntries('消息显示')[0]?.target).toEqual({
        kind: 'setting',
        section: 'chat-messages',
        item: '自定义消息显示',
        settingId: 'custom-message-display',
      });
      expect(searchAppEntries('自启时显示窗口')[0]?.target).toEqual({
        kind: 'setting',
        section: 'startup',
        item: '自启时显示窗口',
      });
    });
  });
});

describe('feature_search', () => {
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
        settingId: 'message-seq',
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

    it('应用锁与备份的旧名称均定位新路径，具体隐私项仍可直接定位', () => {
      for (const keyword of ['应用锁', '隐私模式', '无操作自动上锁']) {
        const result = searchAppEntries(keyword)[0]!;
        expect(result.path).toBe('设置 / 常规 / 隐私');
        expect(result.target).toMatchObject({ kind: 'setting', section: 'privacy' });
      }
      for (const keyword of ['备份与恢复', '设置备份', '导入备份', '恢复默认设置']) {
        const result = searchAppEntries(keyword)[0]!;
        expect(result.path).toBe('设置 / 关于 WeQ / 配置备份与恢复');
        expect(result.target).toMatchObject({ kind: 'setting', section: 'backup' });
      }
    });

    it.each(['常驻显示', '悬停显示'])('%s 指向意图感知而不是没有该控件的推荐回复页', (item) => {
      expect(searchAppEntries(item)[0]?.target).toMatchObject({
        kind: 'setting',
        section: 'intent-sense',
        item,
      });
    });
  });
});
