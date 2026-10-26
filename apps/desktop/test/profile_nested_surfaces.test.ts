import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ContactProfileDialog,
  GroupProfileDialog,
} from '../src/renderer/src/im-template/template/profilePanes';
import type { Contact, GroupConversation } from '../src/renderer/src/im-template/template/types';
import { GroupInfoPanel } from '../src/renderer/src/im-template/template/groupInfoPanel';
import { ChatNavigationContext } from '../src/renderer/src/lib/chatNavigation';
import { QzoneNavigationContext } from '../src/renderer/src/lib/qzoneNavigation';
import { ContactWorkspaceNavigationContext } from '../src/renderer/src/lib/profileNavigation';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ invalidate: async () => undefined }),
    account: {
      intentSense: {
        getStatus: { useQuery: () => ({ data: { profileEnabled: true } }) },
        getProfile: {
          useQuery: () => ({
            data: {
              affinity: 70,
              tier: 3,
              trend: [],
              mbti: { letters: 'ENFP', dims: [], heuristic: true },
              radar: [
                { axis: '主动', value: 50 },
                { axis: '回应', value: 70 },
                { axis: '表达', value: 65 },
                { axis: '倾听', value: 60 },
                { axis: '分享', value: 80 },
              ],
              topics: [{ topic: '学习', count: 5 }],
              sampled: 8,
              analyzedSamples: 2,
              engine: 'heuristic',
            },
            isLoading: false,
            refetch: vi.fn(),
          }),
        },
      },
      // `withQQAccountScope` 要拿到当前数据源才渲染资料卡上的 QQ 操作入口。
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: 'source-a' } }) },
      getGroupAlbumAccessState: {
        useQuery: () => ({ data: { qqOnline: true }, isLoading: false }),
      },
      qqWrite: {
        commonRelationships: {
          useQuery: () => ({ data: undefined, isLoading: false, isFetching: false }),
        },
      },
      dressup: {
        peerStats: { useQuery: () => ({ data: undefined, isLoading: false }) },
        peerHome: { useQuery: () => ({ data: undefined, isLoading: false }) },
        peerQqShow: { useQuery: () => ({ data: undefined, isLoading: false }) },
      },
      mutualMark: {
        get: {
          useQuery: () => ({
            isLoading: false,
            data: {
              categories: [
                {
                  id: 'fixture',
                  name: '合成标识',
                  marks: [
                    {
                      id: 'fixture',
                      name: '测试标识',
                      intro: '',
                      level: 1,
                      levels: [{ level: 1, name: '测试等级', threshold: 1, desc: '测试条件' }],
                      iconUrl: '',
                      iconFormat: '',
                    },
                  ],
                },
              ],
            },
          }),
        },
      },
    },
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const contactFixture: Contact = {
  id: 'u_fixture',
  identityLabel: 'QQ',
  identityValue: '10003',
  username: 'fixture',
  displayName: '合成好友',
  avatarUrl: null,
  createdAt: '2024-03-05T08:00:00+08:00',
  signature: '合成的好友签名。保持好奇，也认真生活。',
  nick: '合成昵称',
  categoryName: '同学',
  qid: 'fixture-qid',
  age: 21,
  gender: 1,
  birthMonth: 6,
  birthDay: 15,
  intimacy: 120,
  onlineStatus: '在线',
  extInfo: {
    interactMarks: [],
    privileges: [
      { bizId: 1, opened: true, level: 3, iconUrl: 'https://fixture.invalid/privilege.png' },
    ],
    school: '合成大学',
    city: '合成城市',
    interests: ['摄影', '音乐', '阅读'],
    album: [
      {
        photoId: 'fixture-photo',
        urls: [
          { size: 3, url: 'https://fixture.invalid/photo.png' },
          { size: 2, url: 'https://fixture.invalid/photo-full.png' },
        ],
      },
    ],
  },
};
const groupFixture = {
  id: 'group-fixture',
  type: 'group',
  otherUser: null,
  group: {
    id: 'group-fixture',
    name: '合成群聊',
    identityLabel: '群号',
    identityValue: '10002',
    avatarUrl: null,
    announcement: '合成群公告',
    description: '合成群简介',
    memberCount: 28,
    maxMemberCount: 200,
    createTime: '2024-03-05T08:00:00+08:00',
    labels: '学习交流',
    entranceQ: '合成的入群问题',
    role: 'member',
  },
  members: Array.from({ length: 14 }, (_, index) => ({
    id: `u_fixture_${index}`,
    uin: String(20000 + index),
    identityLabel: 'QQ',
    identityValue: String(20000 + index),
    username: `fixture_${index}`,
    displayName: `合成成员 ${index + 1}`,
    avatarUrl: null,
    role: index === 0 ? 'owner' : 'member',
    joinedAt: new Date(0).toISOString(),
  })),
} as GroupConversation;

it.each(['friend', 'group'] as const)(
  '联系人页内嵌 %s 资料，保留群交集入口且不创建浮层',
  (kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const close = vi.fn();
    try {
      act(() =>
        root.render(
          h(
            ChatNavigationContext.Provider,
            { value: vi.fn() },
            h(
              QzoneNavigationContext.Provider,
              { value: vi.fn() },
              kind === 'friend'
                ? h(ContactProfileDialog, {
                    contact: contactFixture,
                    embedded: true,
                    onClose: close,
                  })
                : h(GroupProfileDialog, {
                    conversation: groupFixture,
                    embedded: true,
                    onClose: close,
                    details: h(GroupInfoPanel, {
                      conversation: groupFixture,
                      onOpenAnnouncements: vi.fn(),
                      onOpenAlbums: vi.fn(),
                      onOpenFiles: vi.fn(),
                      onOpenEssence: vi.fn(),
                    }),
                  }),
            ),
          ),
        ),
      );
      expect(host.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe(
        kind === 'friend' ? '好友资料' : '群资料',
      );
      expect(document.querySelector('.weq-overlay-layer')).toBeNull();
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      expect(host.querySelector('.weq-profile-close')).toBeNull();
      expect(host.querySelector('.weq-contact-identity .weq-profile-hero')).not.toBeNull();
      if (kind === 'friend') {
        expect(host.querySelector('.weq-contact-primary')?.textContent).toContain('个人资料');
        expect(host.querySelector('.weq-contact-secondary')?.textContent).toContain('好友关系');
        expect(host.querySelector('.weq-contact-primary')?.textContent).not.toContain('亲密度');
        expect(host.querySelector('.weq-contact-secondary')?.textContent).toContain('亲密度');
        expect(host.querySelector('.weq-contact-primary .weq-profile-album img')).not.toBeNull();
        expect(host.querySelector('.weq-contact-secondary')?.textContent).toContain('已开通特权');
      } else {
        expect(host.querySelectorAll('.group-info-member-row')).toHaveLength(14);
        expect(host.querySelector('[aria-label="搜索群成员"]')).not.toBeNull();
        expect(host.querySelector('[aria-label="群内容"]')?.textContent).toContain('文件');
      }
      const entry = host.querySelector<HTMLButtonElement>('.weq-contact-profile-toolbar button')!;
      expect(entry.textContent).toContain('群交集');
      act(() => entry.click());
      expect(close).toHaveBeenCalledOnce();

      const output = process.env.WEQ_CONTACT_LAYOUT_DIR;
      if (output) {
        mkdirSync(output, { recursive: true });
        const templateStyles = [
          'base.css',
          'sidebar.css',
          'chat.css',
          'modals.css',
          'screens.css',
          'responsive.css',
        ]
          .map((file) => readFileSync(resolve('src/renderer/src/im-template/styles', file), 'utf8'))
          .join('\n');
        const styles =
          templateStyles +
          [
            'index.css',
            'appearance.css',
            'conversation-actions.css',
            'group-sidebar-sections.css',
            'group-message-badge.css',
            'segmented-control.css',
            'intent-sense.css',
            'contact-profile.css',
          ]
            .map((file) => readFileSync(resolve('src/renderer/src/styles', file), 'utf8'))
            .join('\n');
        writeFileSync(
          resolve(output, `${kind}.html`),
          `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${styles}</style><style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;height:100%;font-family:system-ui}#fixture{height:100%;width:100%;background:var(--weq-chat-bg);}</style><body><main id="fixture">${host.innerHTML}</main></body></html>`,
        );
        if (kind === 'friend') {
          for (const [tab, label] of [
            ['personality', '个性主页'],
            ['marks', '互动标识'],
            ['portrait', '互动画像'],
          ]) {
            const entry = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
              (button) => button.textContent?.includes(label!),
            )!;
            act(() => entry.click());
            expect(document.querySelector('.weq-overlay-layer')).toBeNull();
            writeFileSync(
              resolve(output, `friend-${tab}.html`),
              `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${styles}</style><style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;height:100%;font-family:system-ui}#fixture{height:100%;width:100%;background:var(--weq-chat-bg);}</style><body><main id="fixture">${host.innerHTML}</main></body></html>`,
            );
          }
        }
      }
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it.each([false, true])('好友资料的私聊操作使用当前对象，内嵌=%s', (embedded) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const open = vi.fn();
  const close = vi.fn();
  try {
    act(() =>
      root.render(
        h(
          ChatNavigationContext.Provider,
          { value: open },
          h(ContactProfileDialog, { contact: contactFixture, embedded, onClose: close }),
        ),
      ),
    );
    const entry = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('查看私聊'),
    )!;
    expect(entry).toBeDefined();
    act(() => entry.click());
    expect(open).toHaveBeenCalledWith({ kind: 'direct', user: contactFixture });
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector('.weq-contact-columns') !== null).toBe(embedded);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it.each(['friend', 'group'] as const)('小名片 %s 移除互动入口并可展开对应对象', (kind) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const open = vi.fn();
  const close = vi.fn();
  try {
    act(() =>
      root.render(
        h(
          ContactWorkspaceNavigationContext.Provider,
          { value: open },
          kind === 'friend'
            ? h(ContactProfileDialog, { contact: contactFixture, onClose: close })
            : h(GroupProfileDialog, { conversation: groupFixture, onClose: close }),
        ),
      ),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).not.toMatch(/个性主页|互动标识|互动画像/);
    act(() => dialog.querySelector<HTMLButtonElement>('.weq-profile-expand')!.click());
    expect(close).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      kind === 'friend'
        ? { kind: 'person', contact: contactFixture }
        : { kind: 'group', conversation: groupFixture },
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('其他页面的群名片默认仍为浮层', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(h(GroupProfileDialog, { conversation: groupFixture, onClose: vi.fn() })));
    expect(host.querySelector('.weq-contact-profile')).toBeNull();
    expect(
      document.querySelector('[role="dialog"][aria-label="群资料"]')?.closest('.weq-overlay-layer'),
    ).not.toBeNull();
    expect(document.querySelector('.weq-profile-close')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('个性主页、互动标识与互动画像均在联系人正文内切换，不生成资料浮层', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(ContactProfileDialog, { contact: contactFixture, embedded: true, onClose: vi.fn() }),
      ),
    );
    for (const [label, selector] of [
      ['个性主页', '.weq-contact-personality'],
      ['互动标识', '.weq-contact-marks'],
      ['互动画像', '.weq-contact-portrait'],
    ] as const) {
      const entry = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) =>
        button.textContent?.includes(label),
      )!;
      act(() => entry.click());
      expect(host.querySelector(selector)).not.toBeNull();
      expect(document.querySelector('.weq-overlay-layer')).toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
    expect(host.textContent).toContain('仅供娱乐参考');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('UID 与 QQ 号分开判定，只有 UID 的对象仍可查看互动画像', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(ContactProfileDialog, {
          embedded: true,
          contact: { ...contactFixture, identityLabel: 'UID', identityValue: 'u_fixture' },
          onClose: vi.fn(),
        }),
      ),
    );
    const options = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(options.find((button) => button.textContent?.includes('个性主页'))?.disabled).toBe(true);
    expect(options.find((button) => button.textContent?.includes('互动标识'))?.disabled).toBe(true);
    const portrait = options.find((button) => button.textContent?.includes('互动画像'))!;
    expect(portrait.disabled).toBe(false);
    act(() => portrait.click());
    expect(host.querySelector('.weq-contact-portrait')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('资料稀疏时不渲染空的兴趣、照片与关系分栏', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(ContactProfileDialog, {
          embedded: true,
          onClose: vi.fn(),
          contact: {
            id: 'fixture-bot',
            kind: 'bot',
            identityLabel: 'UID',
            identityValue: 'fixture-bot',
            username: 'fixture-bot',
            displayName: '合成机器人',
            avatarUrl: null,
            createdAt: new Date(0).toISOString(),
          },
        }),
      ),
    );
    expect(host.querySelector('.weq-contact-columns.is-single')).not.toBeNull();
    expect(host.querySelector('.weq-contact-secondary')).toBeNull();
    expect(host.querySelector('.weq-profile-album')).toBeNull();
    expect(host.querySelector('.weq-profile-interests')).toBeNull();
    expect(host.querySelector('[aria-label="个性签名"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('联系人互动标识内可打开等级浮层，Escape 只关闭等级', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(120, 120, 240, 120),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  const contact: Contact = {
    id: 'fixture',
    identityLabel: 'QQ',
    identityValue: '10001',
    username: 'fixture',
    displayName: '合成好友',
    createdAt: new Date(0).toISOString(),
  };
  try {
    act(() => root.render(h(ContactProfileDialog, { contact, embedded: true, onClose: close })));
    const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('互动标识'),
    )!;
    act(() => open.click());
    act(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="查看 测试标识 的全部等级"]')!.click(),
    );
    expect(host.querySelector('[aria-label="合成好友 的互动标识"]')).not.toBeNull();
    const layer = document
      .querySelector('[aria-label="测试标识 的等级"]')!
      .closest('.weq-overlay-layer')!;
    expect(layer.classList.contains('is-anchored-popover')).toBe(true);
    expect(document.querySelectorAll('.weq-overlay-layer')).toHaveLength(1);
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(document.querySelector('[aria-label="测试标识 的等级"]')).toBeNull();
    expect(document.querySelector('[aria-label="合成好友 的互动标识"]')).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
