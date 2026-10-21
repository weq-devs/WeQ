import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupBadgeDisplayControls } from '../src/renderer/src/components/GroupBadgeDisplayControls';
import { GroupMessageBadge } from '../src/renderer/src/components/GroupMessageBadge';
import {
  DEFAULT_GROUP_BADGE_DISPLAY,
  GROUP_BADGE_STORAGE_KEY,
  groupBadgeKey,
  parseGroupBadgePreferences,
  useGroupBadgeDisplay,
} from '../src/renderer/src/state/groupBadge';
import { useViewState } from '../src/renderer/src/state/view';

const member = { customTitle: '合成头衔', memberLevel: 42, levelName: '活跃', levelBracket: 3 };
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  localStorage.removeItem(GROUP_BADGE_STORAGE_KEY);
  useGroupBadgeDisplay.getState().reload();
  useViewState.getState().setOpenedUin('10001');
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  localStorage.removeItem(GROUP_BADGE_STORAGE_KEY);
  useGroupBadgeDisplay.getState().reload();
  useViewState.getState().setOpenedUin(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(role?: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(
        'div',
        null,
        createElement(GroupBadgeDisplayControls, { groupId: '20001' }),
        createElement(GroupMessageBadge, { groupId: '20001', member: { ...member, role } }),
        createElement(
          'div',
          { 'data-other': true },
          createElement(GroupMessageBadge, { groupId: '20002', member }),
        ),
      ),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const toggle = (label: string) => {
    const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    act(() => button.click());
  };
  const badge = () => host.querySelector('.member-badge')?.textContent;
  return { host, toggle, badge };
}
describe('每群头衔与等级显示偏好', () => {
  it.each([undefined, 'owner', 'admin'])(
    '默认显示 %s 的头衔及数字等级，两个开关独立生效',
    (role) => {
      const f = mount(role);
      const title = role === 'owner' ? '群主' : role === 'admin' ? '管理员' : member.customTitle;
      expect(f.badge()).toBe(`Lv42 · ${title}`);
      f.toggle('显示头衔');
      expect(f.badge()).toBe('Lv42');
      f.toggle('显示等级');
      expect(f.host.querySelectorAll('.member-badge')).toHaveLength(1);
      expect(f.host.querySelector('[data-other]')?.textContent).toBe('Lv42 · 合成头衔');
      f.toggle('显示头衔');
      expect(f.badge()).toBe(title);
      f.toggle('显示等级');
      expect(f.badge()).toBe(`Lv42 · ${title}`);
      expect(JSON.parse(localStorage.getItem(GROUP_BADGE_STORAGE_KEY)!)).toEqual({});
    },
  );
  it('按账号与群隔离，重载与其他窗口变更后保持偏好', () => {
    const f = mount();
    f.toggle('显示头衔');
    act(() => useViewState.getState().setOpenedUin('10002'));
    expect(f.badge()).toBe('Lv42 · 合成头衔');
    act(() => useViewState.getState().setOpenedUin('10001'));
    expect(f.badge()).toBe('Lv42');
    act(() => useGroupBadgeDisplay.getState().reload());
    expect(f.badge()).toBe('Lv42');
    localStorage.setItem(GROUP_BADGE_STORAGE_KEY, '{}');
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: GROUP_BADGE_STORAGE_KEY })));
    expect(f.badge()).toBe('Lv42 · 合成头衔');
  });
  it('没有账号时禁用开关，保存失败保留原值并反馈错误', () => {
    const f = mount();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    f.toggle('显示头衔');
    expect(f.badge()).toBe('Lv42 · 合成头衔');
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('保存失败');
    act(() => useViewState.getState().setOpenedUin(null));
    expect(f.host.querySelector<HTMLButtonElement>('[aria-label="显示头衔"]')?.disabled).toBe(true);
  });
  it('校验持久化结构，不接受字符串布尔值或损坏内容', () => {
    expect(groupBadgeKey(null, '20001')).toBeNull();
    expect(parseGroupBadgePreferences('broken')).toEqual({});
    expect(parseGroupBadgePreferences('[]')).toEqual({});
    const key = groupBadgeKey('10001', '20001')!;
    expect(
      parseGroupBadgePreferences(
        JSON.stringify({ [key]: { showTitle: 'false', showLevel: true } }),
      ),
    ).toEqual({});
    expect(
      parseGroupBadgePreferences(JSON.stringify({ [key]: DEFAULT_GROUP_BADGE_DISPLAY })),
    ).toEqual({ [key]: DEFAULT_GROUP_BADGE_DISPLAY });
    expect(
      parseGroupBadgePreferences(
        JSON.stringify({ bad: false, [key]: DEFAULT_GROUP_BADGE_DISPLAY }),
      ),
    ).toEqual({ [key]: DEFAULT_GROUP_BADGE_DISPLAY });
  });
  it('保存前合并其他窗口的群偏好，不用内存旧快照覆盖', () => {
    const other = groupBadgeKey('10002', '20002')!;
    const current = groupBadgeKey('10001', '20001')!;
    localStorage.setItem(
      GROUP_BADGE_STORAGE_KEY,
      JSON.stringify({ [other]: { showTitle: false, showLevel: true } }),
    );
    useGroupBadgeDisplay.getState().setDisplay(current, { showLevel: false });
    expect(useGroupBadgeDisplay.getState().preferences).toEqual({
      [other]: { showTitle: false, showLevel: true },
      [current]: { showTitle: true, showLevel: false },
    });
  });
});
