// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
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
      });
      expect(searchAppEntries('自定义消息显示')[0]?.target).toEqual({
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
    it.each([
      ['禁用 P2P 直连', 'call-recording'],
      ['转发时引用上一人文案', 'qzone'],
      ['不让 ta 看我的空间', 'qzone'],
      ['不看 ta 的空间', 'qzone'],
      ['允许远程连接', 'remote'],
      ['Tailscale', 'remote'],
      ['设备配对', 'remote'],
      ['已配对设备', 'remote'],
      ['安装到本机 AI 客户端', 'mcp'],
      ['MCP 客户端配置', 'mcp'],
      ['推送地址', 'sse'],
      ['QQ 公众号推送端口', 'assistant'],
      ['QQ 昵称', 'qq-accounts'],
      ['个性签名', 'qq-accounts'],
      ['在线状态', 'qq-accounts'],
      ['WeQ 验证器', 'privacy'],
    ])('%s 可检索且指向所属设置页面 %s', (keyword, section) => {
      expect(
        searchAppEntries(keyword).some(
          (entry) => entry.target.kind === 'setting' && entry.target.section === section,
        ),
      ).toBe(true);
    });
    it.each([
      ['定时导出', 'scheduled'],
      ['群文件导出', 'groupfile'],
      ['群相册导出', 'album'],
      ['邮件导出', 'mail'],
      ['导出联系人', 'contacts'],
      ['导出收藏', 'collection'],
      ['导出表情包', 'emojipack'],
      ['克隆与助手对话', 'generated'],
      ['个人空间相册', 'qzone'],
      ['克隆体机器人', 'persona-bot'],
    ])('%s 直接打开对应导出种类 %s', (keyword, exportMode) => {
      expect(searchAppEntries(keyword)[0]?.target).toEqual({
        kind: 'tool',
        tool: 'export',
        exportMode,
      });
    });
    it('频道私聊、漫游拉取和商城表情使用准确入口', () => {
      expect(searchAppEntries('频道私聊')[0]?.target).toEqual({
        kind: 'view',
        view: 'guild-direct',
      });
      expect(searchAppEntries('拉取漫游消息')[0]?.target).toEqual({
        kind: 'tool',
        tool: 'backfill',
      });
      expect(searchAppEntries('商城表情')[0]?.target).toEqual({
        kind: 'dressup',
        dressKind: 'emoji',
      });
      expect(searchAppEntries('通话背景')[0]?.target).toEqual({
        kind: 'dressup',
        dressKind: 'callbg',
      });
    });
    it('Web 端不列出只有电脑客户端才有的 Remote 控件', async () => {
      vi.stubEnv('VITE_WEQ_TARGET', 'web');
      vi.resetModules();
      try {
        const web = await import('../src/renderer/src/components/search/appSearchCatalog');
        for (const keyword of [
          '启用 Web 服务',
          '启动 WeQ 时自动开启 Web 服务',
          '允许远程连接',
          '设备配对',
          'Tailscale',
        ]) {
          expect(web.searchAppEntries(keyword), keyword).toEqual([]);
        }
        expect(web.searchAppEntries('Web 与 Remote')[0]?.target).toEqual({
          kind: 'setting',
          section: 'remote',
        });
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    });
    it('克隆入口打开统一消息目录的克隆范围，不再进入已隐藏列表的旧页面', () => {
      expect(searchAppEntries('克隆')[0]?.target).toEqual({
        kind: 'conversation-directory',
        scope: 'virtual',
      });
    });
    it('空白和未知关键词没有结果，名称匹配优先于别名', () => {
      expect(searchAppEntries('  ')).toEqual([]);
      expect(searchAppEntries('不存在的合成功能')).toEqual([]);
      expect(searchAppEntries('导出')[0]?.title).toBe('导出');
      expect(searchAppEntries('  oCr  ').some((entry) => entry.title === '图片识别')).toBe(true);
    });
    it('SSE 旧正文名称保留为搜索别名，统一定位最终页面名', () => {
      const entry = searchAppEntries('SSE 消息推送')[0]!;
      expect(entry.title).toBe('SSE 推送');
      expect(entry.target).toEqual({ kind: 'setting', section: 'sse' });
    });
    it.each([
      ['存储占用', '占用概览', 'qq-storage-analysis'],
      ['清理缓存', '资源清理', 'qq-storage-cleanup'],
      ['本地缓存', '资源浏览', 'resource-viewer'],
    ])('%s 的搜索展示采用资源融合后的名称 %s', (keyword, title, id) => {
      expect(
        searchAppEntries(keyword).some(
          (entry) =>
            entry.title === title &&
            entry.target.kind === 'setting' &&
            entry.target.settingId === id,
        ),
      ).toBe(true);
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
