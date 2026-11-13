import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactWorkspace } from '../src/renderer/src/components/ContactWorkspace';
import { useTabActive } from '../src/renderer/src/components/RetainedTabs';
import type { Contact } from '../src/renderer/src/im-template/template/types';
import type { ContactWorkspaceTab } from '../src/renderer/src/lib/profileNavigation';
import { RelationshipDirectoryContext } from '../src/renderer/src/lib/contactRelationship';

vi.mock('../src/renderer/src/components/gift/GiftWall', () => ({
  GiftWall: () => h(Activity, { name: '礼物墙内容' }),
}));

vi.mock('../src/renderer/src/components/contactProfile/ContactContent', () => ({
  ContactContent: () => h('p', null, '当前资料'),
}));
vi.mock('../src/renderer/src/components/contactProfile/ContactGroupWorkspace', () => ({
  ContactGroupWorkspace: () => h('p', null, '群聊选择'),
}));
vi.mock('../src/renderer/src/components/PersonalityHomeDialog', () => ({
  PersonalityHomeDialog: () => h('p', null, '装扮内容'),
}));
vi.mock('../src/renderer/src/components/contactProfile/ContactDressRow', () => ({
  ContactDressRow: () => h('p', null, '装扮素材'),
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
function render(tab?: ContactWorkspaceTab, self = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      h(
        RelationshipDirectoryContext.Provider,
        {
          value: {
            selfUid: self ? contact.uid : 'u_self',
            friends: new Map(),
            friendsComplete: false,
            groups: new Map(),
          },
        },
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
    ),
  );
  return host;
}
it('画像入口定位到画像分区，普通关系页不强制滚动', () => {
  const bounds = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function () {
      return { top: this.getAttribute('data-profile-anchor') === 'portrait' ? 360 : 0 } as DOMRect;
    });
  try {
    const normal = render('marks');
    expect(normal.querySelector('.weq-profile-workspace-body')?.scrollTop).toBe(0);
    const portrait = render('portrait');
    expect(portrait.querySelector('.weq-profile-workspace-body')?.scrollTop).toBe(360);
  } finally {
    bounds.mockRestore();
  }
});
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
it('本人资料移除关系页，礼物墙位于最后且点击前不挂载', () => {
  const host = render(undefined, true);
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('.weq-profile-directory button')];
  expect(tabs.map((node) => node.textContent)).toEqual([
    '个人资料',
    '群内资料',
    '个性展示',
    '礼物墙',
  ]);
  expect(host.textContent).not.toContain('礼物墙内容');
  act(() => tabs.at(-1)!.click());
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('礼物墙');
  expect(host.querySelector('[data-active]')?.getAttribute('data-active')).toBe('true');
  expect(host.textContent).not.toContain('与我的关系');
});
it.each(['marks', 'portrait'] as const)('本人旧入口 %s 不恢复关系页或画像', (tab) => {
  const host = render(tab, true);
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('个人资料');
  expect(host.textContent).not.toContain('画像内容');
  expect(host.textContent).not.toContain('与我的关系');
});
it('礼物墙直达只对本人显示，不能在他人资料里展示本人的礼物', () => {
  const mine = render('giftwall', true);
  expect(mine.querySelector('[aria-current="page"]')?.textContent).toBe('礼物墙');
  expect(mine.textContent).toContain('礼物墙内容');
  const other = render('giftwall');
  expect(other.querySelector('[aria-current="page"]')?.textContent).toBe('个人资料');
  expect(other.textContent).not.toContain('礼物墙');
});
it.each([
  ['portrait', '与我的关系', '画像内容'],
  ['questions', '个性展示', 'questions'],
] as const)('旧入口 %s 自动展开所属内容', (tab, section, content) => {
  const host = render(tab);
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe(section);
  expect(host.textContent).toContain(content);
  const value = [...host.querySelectorAll('[data-active]')].find(
    (node) => node.textContent === content,
  )!;
  expect(value.getAttribute('data-active')).toBe('true');
});
it('旧历史入口不恢复汇总区，页内不重复章节标题或教育分区', () => {
  const host = render('history');
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('个人资料');
  expect(host.querySelector('.weq-contact-section-title')).toBeNull();
  expect(host.textContent).not.toContain('资料变更记录');
  expect(host.textContent).not.toContain('教育经历');
});
it('互动标识和互动画像同级常驻，不使用折叠控件', () => {
  const host = render('portrait');
  expect(
    [...host.querySelectorAll('.weq-profile-section-block--prominent h3')].map(
      (node) => node.textContent,
    ),
  ).toEqual(['互动标识', '互动画像']);
  expect(host.querySelector('.weq-profile-disclosure-trigger')).toBeNull();
  expect(host.querySelector('[data-active]')?.getAttribute('data-active')).toBe('true');
});
it('旧签名章节返回个人资料，不恢复已移除的独立签名历史按钮或技术详情', () => {
  const host = render('signatures');
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('个人资料');
  expect(host.textContent).not.toContain('签名历史');
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector('.weq-profile-tech')).toBeNull();
});
