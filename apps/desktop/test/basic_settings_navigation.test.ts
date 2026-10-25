import { describe, expect, it } from 'vitest';
import {
  SETTINGS_GROUPS,
  settingsGroupFor,
  settingsScopeFor,
  settingsSectionFor,
} from '../src/renderer/src/components/settings/navigation';
import { searchAppEntries } from '../src/renderer/src/components/search/appSearchCatalog';

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
