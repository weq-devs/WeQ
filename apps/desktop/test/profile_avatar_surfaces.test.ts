import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ProfileNavigationContext,
  profileTargetUser,
} from '../src/renderer/src/lib/profileNavigation';
import { ProfileAvatar } from '../src/renderer/src/components/ProfileAvatar';
import { GroupLeftMembersDialog } from '../src/renderer/src/components/GroupLeftMembersDialog';
import { GroupAnnouncementsDialog } from '../src/renderer/src/components/GroupAnnouncementsDialog';
import { PersonWeekCard } from '../src/renderer/src/components/conversationTimeline';
import {
  GroupJoinBatches,
  type JoinBatchReport,
} from '../src/renderer/src/components/GroupJoinBatches';
import { CollectionDialog } from '../src/renderer/src/components/CollectionDialog';

const rpc = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({}),
    account: {
      dressup: { peerStats: { useQuery: () => ({ data: undefined, isLoading: false }) } },
      getAccountConfig: { useQuery: () => ({ data: undefined }) },
      getGroupAlbumAccessState: { useQuery: () => ({ data: undefined }) },
      qqActions: {
        groupPermissions: { useQuery: () => ({ data: undefined, isFetching: false }) },
        notices: { useQuery: () => ({ data: undefined, isFetching: false }) },
      },
    },
  },
  client: {
    account: {
      listCollections: { query: rpc.list },
      collectionDetail: { query: rpc.detail },
    },
  },
}));
vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children, className }: { children: ReactNode; className?: string }) =>
    h('div', { className: `weq-overlay-layer ${className ?? ''}`, tabIndex: -1 }, children),
}));

const cleanups: Array<() => void> = [];
const group = { code: '123', name: '所属群' };
const target = { identity: 'u_peer', uin: '10002', name: '合成人物', group };
const member = {
  uid: 'u_peer',
  uin: '10002',
  displayName: '合成人物',
  joinTime: 1,
  lastSpeakTime: 2,
  memberLevel: 1,
  messageCount: 5,
};
const batches: JoinBatchReport = {
  memberTotal: 1,
  datedMemberCount: 0,
  unknownJoinCount: 0,
  threshold: 1,
  windowSeconds: 3600,
  batches: [
    {
      index: 1,
      startTime: 1,
      endTime: 2,
      spanSeconds: 1,
      members: [member],
      messageCount: 5,
      topSpeaker: member,
    },
  ],
  batchMemberCount: 1,
  groupMessageTotal: 5,
  firstJoinTime: 1,
  lastJoinTime: 2,
};
const collection = {
  cid: 'c1',
  kind: 'text',
  type: 1,
  createTime: 1,
  collectTime: 1,
  authorName: '合成人物',
  authorUin: '10002',
  groupName: '',
  text: '合成收藏',
  contentStatus: 'cached',
  fullContent: '收藏全文',
  fullContentFormat: 'text',
  link: null,
  gallery: null,
  audio: null,
  video: null,
  file: null,
  location: null,
  richMedia: null,
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  rpc.list.mockResolvedValue({ items: [collection], hasMore: false });
  rpc.detail.mockResolvedValue(null);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(element: ReactNode) {
  const open = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(h(ProfileNavigationContext.Provider, { value: open }, element)));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, open };
}
function click(host: HTMLElement) {
  const button = host.querySelector<HTMLButtonElement>('.weq-profile-avatar-button')!;
  expect(button).not.toBeNull();
  act(() =>
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1, clientX: 40, clientY: 60 }),
    ),
  );
}

function captureLayout(host: HTMLElement, name: string) {
  const output = process.env.WEQ_PROFILE_LAYOUT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  const templateStyles = [
    'base.css',
    'sidebar.css',
    'chat.css',
    'modals.css',
    'screens.css',
    'responsive.css',
  ].map((file) => readFileSync(resolve('src/renderer/src/im-template/styles', file), 'utf8'));
  const styles = [
    ...templateStyles,
    ...[
      'index.css',
      'group-left-members.css',
      'conversation-analytics.css',
      'collection-search.css',
      'profile-avatar.css',
    ].map((file) => readFileSync(resolve('src/renderer/src/styles', file), 'utf8')),
  ].join('\n');
  writeFileSync(
    resolve(output, `${name}.html`),
    `<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><style>${styles}</style><style>html,body{margin:0;font-family:system-ui}*,*::before,*::after{box-sizing:border-box}body{background:var(--weq-bg-surface);color:var(--weq-fg-primary)}.app-shell{display:block;height:auto;min-height:0;padding:24px}.group-info-detail-dialog,.group-announcements-dialog,.weq-collection-dialog{max-width:100%}</style><body><main class="app-shell">${host.innerHTML}</main></body></html>`,
  );
}

describe('跨页面头像名片', () => {
  it('区分 UID 与 QQ 号，未知身份不提供错误入口', () => {
    expect(profileTargetUser(target)).toMatchObject({ id: 'u_peer', identityValue: '10002' });
    expect(profileTargetUser({ identity: '10002', name: '作者' })).toMatchObject({
      id: '',
      identityValue: '10002',
    });
    expect(profileTargetUser({ identity: '未知', name: '作者' })).toBeNull();
    expect(profileTargetUser({ identity: '0', name: '作者' })).toBeNull();
    const f = fixture(
      h(ProfileAvatar, { target: { identity: '', name: '未知' } }, h('span', null, '头像')),
    );
    expect(f.host.querySelector('button')).toBeNull();
  });
  it('键盘按头像边缘定位，点击不触发父级操作', () => {
    const parent = vi.fn();
    const f = fixture(
      h('div', { onClick: parent }, h(ProfileAvatar, { target }, h('span', null, '头像'))),
    );
    const button = f.host.querySelector('button')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 32, 32));
    act(() => button.click());
    expect(f.open).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u_peer' }),
      { x: 42, y: 52 },
      group,
    );
    expect(parent).not.toHaveBeenCalled();
  });
  it('已退群成员带正确群上下文', () => {
    const f = fixture(
      h(GroupLeftMembersDialog, {
        groupCode: group.code,
        groupName: group.name,
        members: [{ id: 'u_peer', identity: '10002', displayName: '合成人物' }],
        loading: false,
        onClose: vi.fn(),
      }),
    );
    click(f.host);
    captureLayout(f.host, 'left-members');
    expect(f.open).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u_peer' }),
      { x: 40, y: 60 },
      group,
    );
  });
  it.each(['u_peer', '10002'])('公告发布者可使用 UID 或 QQ 号：%s', (identity) => {
    const f = fixture(
      h(GroupAnnouncementsDialog, {
        groupCode: group.code,
        groupName: group.name,
        bulletins: [
          {
            fid: 'f1',
            publisherUid: identity,
            publisherName: '合成人物',
            textContent: '公告',
            ctime: '',
            msgTime: '',
          },
        ],
        onClose: vi.fn(),
      }),
    );
    click(f.host);
    captureLayout(f.host, 'announcements');
    expect(f.open).toHaveBeenCalledWith(
      expect.objectContaining({
        id: identity.startsWith('u_') ? identity : '',
        identityValue: identity,
      }),
      { x: 40, y: 60 },
      group,
    );
  });
  it('群排行头像可打开名片，导出用的静态卡片无按钮', () => {
    const f = fixture(
      h(PersonWeekCard, { name: target.name, weekly: [5], count: 5, profile: target }),
    );
    click(f.host);
    captureLayout(f.host, 'ranking');
    expect(f.open).toHaveBeenCalledOnce();
    const exported = fixture(h(PersonWeekCard, { name: target.name, weekly: [5], count: 5 }));
    expect(exported.host.querySelector('button')).toBeNull();
  });
  it('拿不到头像时用默认头像，而不是昵称首字', () => {
    const f = fixture(h(PersonWeekCard, { name: '合成人物', weekly: [5], count: 5 }));
    const avatar = f.host.querySelector('.ca-person-avatar .avatar')!;
    expect(avatar.classList.contains('has-default')).toBe(true);
    // 默认头像是 SVG 占位，不再把昵称第一个字直接铺在圆底上。
    expect(avatar.querySelector('svg')).not.toBeNull();
    expect(avatar.textContent).toBe('');
  });
  it('入群批次成员与最活跃成员均可查看，导出不含按钮', () => {
    const f = fixture(h(GroupJoinBatches, { report: batches, group }));
    const buttons = [...f.host.querySelectorAll<HTMLButtonElement>('.weq-profile-avatar-button')];
    expect(buttons).toHaveLength(2);
    captureLayout(f.host, 'join-batches');
    for (const button of buttons) act(() => button.click());
    expect(f.open).toHaveBeenCalledTimes(2);
    const exported = fixture(h(GroupJoinBatches, { report: batches }));
    expect(exported.host.querySelector('button')).toBeNull();
  });
  it('收藏列表与详情均可打开作者名片，多选时仍选择收藏而不打开名片', async () => {
    const f = fixture(h(CollectionDialog, { open: true, embedded: true, onClose: vi.fn() }));
    await act(async () => {});
    captureLayout(f.host, 'collections');
    click(f.host);
    expect(f.open).toHaveBeenCalledWith(
      expect.objectContaining({ id: '', identityValue: '10002' }),
      { x: 40, y: 60 },
      undefined,
    );
    expect(f.host.textContent).not.toContain('收藏详情');
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="多选收藏"]')!.click());
    expect(f.host.querySelector('.weq-profile-avatar-button')).toBeNull();
    act(() => f.host.querySelector<HTMLElement>('.weq-col-avatar')!.click());
    expect(f.host.textContent).toContain('已选 1 条收藏');
    expect(f.open).toHaveBeenCalledOnce();
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="退出多选"]')!.click());
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.weq-col-card-foot button')!.click(),
    );
    expect(f.host.textContent).toContain('收藏详情');
    captureLayout(f.host, 'collection-detail');
    click(f.host);
    expect(f.open).toHaveBeenCalledTimes(2);
  });
});
