import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ContactProfileDialog,
  GroupProfileDialog,
} from '../src/renderer/src/im-template/template/profilePanes';
import type { Contact, GroupConversation } from '../src/renderer/src/im-template/template/types';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ invalidate: async () => undefined }),
    account: {
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
      dressup: { peerStats: { useQuery: () => ({ data: undefined, isLoading: false }) } },
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
vi.mock('../src/renderer/src/components/PersonalityHomeDialog', () => ({
  PersonalityHomeDialog: () => null,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const contactFixture: Contact = {
  id: 'fixture',
  identityLabel: 'QQ',
  identityValue: '10001',
  username: 'fixture',
  displayName: '合成好友',
  createdAt: new Date(0).toISOString(),
  signature: '合成的好友签名',
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
    memberCount: 12,
    role: 'member',
  },
  members: [],
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
          kind === 'friend'
            ? h(ContactProfileDialog, { contact: contactFixture, embedded: true, onClose: close })
            : h(GroupProfileDialog, { conversation: groupFixture, embedded: true, onClose: close }),
        ),
      );
      expect(host.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe(
        kind === 'friend' ? '好友资料' : '群资料',
      );
      expect(document.querySelector('.weq-overlay-layer')).toBeNull();
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      expect(host.querySelector('.weq-profile-close')).toBeNull();
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
          ['index.css', 'contact-profile.css']
            .map((file) => readFileSync(resolve('src/renderer/src/styles', file), 'utf8'))
            .join('\n');
        writeFileSync(
          resolve(output, `${kind}.html`),
          `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${styles}</style><style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;height:100%;font-family:system-ui}#fixture{height:100%;width:100%;background:var(--weq-chat-bg);}</style><body><main id="fixture">${host.innerHTML}</main></body></html>`,
        );
      }
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

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

it('好友资料、互动标识和等级三层依次在入口旁展开，Escape 只关闭等级', () => {
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
    act(() => root.render(h(ContactProfileDialog, { contact, onClose: close })));
    const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('查看互动标识'),
    )!;
    act(() => open.click());
    act(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="查看 测试标识 的全部等级"]')!.click(),
    );
    const layers = ['好友资料', '合成好友 的互动标识', '测试标识 的等级'].map(
      (name) =>
        document
          .querySelector(`[aria-label="${name}"]`)!
          .closest<HTMLElement>('.weq-overlay-layer')!,
    );
    expect(Number(layers[1]!.style.zIndex)).toBeGreaterThan(Number(layers[0]!.style.zIndex));
    expect(Number(layers[2]!.style.zIndex)).toBeGreaterThan(Number(layers[1]!.style.zIndex));
    expect(layers[1]!.classList.contains('is-anchored-popover')).toBe(true);
    expect(layers[2]!.classList.contains('is-anchored-popover')).toBe(true);
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
