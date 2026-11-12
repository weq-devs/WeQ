import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactWorkspace } from '../src/renderer/src/components/ContactWorkspace';
import { useTabActive } from '../src/renderer/src/components/RetainedTabs';
import type { Contact } from '../src/renderer/src/im-template/template/types';
import type { ContactWorkspaceTab } from '../src/renderer/src/lib/profileNavigation';

vi.mock('../src/renderer/src/components/contactProfile/ContactContent', () => ({
  ContactContent: () => h('p', null, '当前资料'),
}));
vi.mock('../src/renderer/src/components/contactProfile/ContactGroupWorkspace', () => ({
  ContactGroupWorkspace: () => h('p', null, '群聊选择'),
}));
vi.mock('../src/renderer/src/components/PersonalityHomeDialog', () => ({
  PersonalityHomeDialog: () => h('p', null, '装扮内容'),
}));
vi.mock('../src/renderer/src/components/MutualMarkDialog', () => ({
  MutualMarkDialog: () => h('p', null, '互动标识内容'),
}));
vi.mock('../src/renderer/src/components/ProfileExtras', () => ({
  EducationSection: () => h('p', null, '教育内容'),
  ProfileExtrasContent: ({ view }: { view: string }) => h(Activity, { name: view }),
  ProfileExtraDialog: ({
    view,
    anchor,
    onClose,
  }: {
    view: string;
    anchor: HTMLElement;
    onClose: () => void;
  }) =>
    h(
      'div',
      { role: 'dialog', 'data-anchor': anchor?.textContent },
      h(Activity, { name: view }),
      h('button', { 'aria-label': '关闭签名历史', onClick: onClose }),
    ),
}));
vi.mock('../src/renderer/src/components/intentSense/IntentProfileDialog', () => ({
  IntentProfileDialog: () => h(Activity, { name: '画像内容' }),
}));
vi.mock('../src/renderer/src/components/intentSense/context', () => ({
  useIntentSenseStatus: () => ({ data: { profileEnabled: true } }),
}));
vi.mock('../src/renderer/src/components/ContactHistory', () => ({
  ContactHistory: ({ section }: { section: string }) => h(Activity, { name: `历史-${section}` }),
}));
vi.mock('../src/renderer/src/components/settings/SelfQQControls', () => ({
  SelfQQControls: () => h('p', null, '编辑内容'),
}));
vi.mock('../src/renderer/src/components/SelfAvatarHistory', () => ({
  SelfAvatarHistory: () => null,
}));

function Activity({ name }: { name: string }) {
  return h('p', { 'data-active': String(useTabActive()) }, name);
}
const contact: Contact = {
  id: 'u_fixture',
  uid: 'u_fixture',
  identityLabel: 'QQ',
  identityValue: '10002',
  displayName: '测试',
  nick: '测试',
  username: 'test',
  avatarUrl: null,
  createdAt: '',
  isFriend: true,
};
const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.innerHTML = '';
});
function render(tab?: ContactWorkspaceTab) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      h(ContactWorkspace, {
        contact,
        tab,
        personalityProfile: {
          name: '测试',
          avatarUrl: null,
          interests: [],
          privileges: [],
          album: [],
        },
        onNavigateAway: vi.fn(),
      }),
    ),
  );
  return host;
}
it('默认显示四页，不提前挂载历史、问答或画像', () => {
  const host = render();
  expect(
    [...host.querySelectorAll('.weq-profile-directory button')].map((node) => node.textContent),
  ).toEqual(['个人资料', '与我的关系', '群内资料', '个性展示']);
  expect(host.textContent).not.toContain('画像内容');
  expect(host.textContent).not.toContain('历史-profile');
  expect(host.textContent).not.toContain('questions');
  expect(host.textContent).not.toContain('签名历史');
  expect(host.querySelector('.weq-profile-tech')).toBeNull();
});
it.each([
  ['portrait', '与我的关系', '画像内容'],
  ['questions', '个性展示', 'questions'],
  ['history', '个人资料', '历史-profile'],
] as const)('旧入口 %s 自动展开所属内容', (tab, section, content) => {
  const host = render(tab);
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe(section);
  expect(host.textContent).toContain(content);
  const value = [...host.querySelectorAll('[data-active]')].find(
    (node) => node.textContent === content,
  )!;
  expect(value.getAttribute('data-active')).toBe('true');
});
it('收起资料历史保留内容但暂停读取', () => {
  const host = render('history');
  const button = [...host.querySelectorAll('button')].find(
    (node) => node.textContent === '资料变更记录',
  )!;
  act(() => button.click());
  expect(host.querySelector('[data-active]')?.getAttribute('data-active')).toBe('false');
  expect(button.getAttribute('aria-expanded')).toBe('false');
});
it('旧签名章节返回个人资料，不恢复已移除的独立签名历史按钮或技术详情', () => {
  const host = render('signatures');
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('个人资料');
  expect(host.textContent).not.toContain('签名历史');
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector('.weq-profile-tech')).toBeNull();
});
