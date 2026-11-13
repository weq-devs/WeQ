import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupProfileFeatures } from '../src/renderer/src/components/groupProfile/GroupProfileFeatures';
import {
  ConversationSettingsNavigationContext,
  GroupResourceNavigationContext,
} from '../src/renderer/src/lib/conversationSettingsNavigation';
import type { GroupConversation } from '../src/renderer/src/im-template/template/types';
import type { GroupWorkspaceTab } from '../src/renderer/src/lib/profileNavigation';

vi.mock('../src/renderer/src/hooks/useGroupResourceWindows', () => ({
  useGroupResourceWindows: () => ({ open: vi.fn(), windows: [] }),
}));
vi.mock('../src/renderer/src/components/RetainedTabs', () => ({ useTabActive: () => true }));
vi.mock('../src/renderer/src/components/GroupAnnouncementsDialog', () => ({
  GroupAnnouncementsDialog: () => h('section', { 'data-feature-body': '公告' }),
}));
vi.mock('../src/renderer/src/components/GroupSignDialog', () => ({
  GroupSignDialog: () => h('section', { 'data-feature-body': '打卡' }),
}));
vi.mock('../src/renderer/src/components/GroupFeatureSurface', () => ({
  GroupFeatureSurface: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/qq-actions/GroupActions', () => ({
  GroupTodos: () => h('section', { 'data-feature-body': '待办' }),
}));
vi.mock('../src/renderer/src/components/ConversationSettingsDialog', () => ({
  ConversationSettingsDialog: () => null,
}));
vi.mock('../src/renderer/src/components/groupProfile/GroupWorkspace', () => ({
  GroupProfileEssence: () => h('section', { 'data-feature-body': '精华' }),
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function mount(section?: GroupWorkspaceTab) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const openResource = vi.fn(() => true);
  const openSettings = vi.fn();
  const conversation = {
    id: '22222',
    group: { name: '资料中的群' },
    members: [],
  } as unknown as GroupConversation;
  act(() =>
    root.render(
      h(
        ConversationSettingsNavigationContext.Provider,
        { value: openSettings },
        h(
          GroupResourceNavigationContext.Provider,
          { value: openResource },
          h(GroupProfileFeatures, {
            conversation,
            scope: 'account:source',
            section,
            albumId: 'album',
            folderId: 'folder',
            fileId: 'file',
          }),
        ),
      ),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, openResource, openSettings };
}
it('正文不铺开群内容，六个紧凑入口按需打开', () => {
  const { host } = mount();
  expect(host.querySelectorAll('button')).toHaveLength(6);
  expect(host.querySelector('[data-feature-body]')).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('[data-feature="announcements"]')!.click());
  expect(host.querySelector('[data-feature-body]')?.getAttribute('data-feature-body')).toBe('公告');
});
it.each(['albums', 'files'] as const)('旧 %s 定位进入同一资源宿主并保留目标参数', (section) => {
  const { openResource, host } = mount(section);
  expect(openResource).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: section,
      groupCode: '22222',
      groupName: '资料中的群',
      initialAlbumId: 'album',
      initialFolderId: 'folder',
      initialFileId: 'file',
    }),
  );
  expect(host.querySelector('[data-feature-body]')).toBeNull();
});
it.each([
  ['content', '公告'],
  ['announcements', '公告'],
  ['todos', '待办'],
  ['sign', '打卡'],
  ['essence', '精华'],
] as const)('旧 %s 入口打开对应浮窗', (section, label) => {
  const { host } = mount(section);
  expect(host.querySelector('[data-feature-body]')?.getAttribute('data-feature-body')).toBe(label);
});
it('旧群管理入口只打开会话设置中的群管理，不渲染资料页管理表单', () => {
  const { openSettings, host } = mount('management');
  expect(openSettings).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'group', conv: '22222', initialSection: 'group-management' }),
  );
  expect(host.querySelector('[data-feature-body]')).toBeNull();
});
