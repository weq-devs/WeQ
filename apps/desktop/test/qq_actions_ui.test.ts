import { act, createElement as h, createRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeSolidPng } from '@weq/protocol';
import { GroupFileActions } from '../src/renderer/src/components/qq-actions/GroupFileActions';
import { GroupNoticeActions } from '../src/renderer/src/components/qq-actions/GroupNoticeActions';
import {
  GroupAlbumMediaActions,
  QzoneWriteActions,
} from '../src/renderer/src/components/qq-actions/MediaActions';
import { RequestActions } from '../src/renderer/src/components/qq-actions/RequestActions';
import {
  ContactNoticeDialog,
  GroupNoticeDialog,
} from '../src/renderer/src/components/ContactNoticeDialogs';
import type {
  ContactRequest,
  GroupJoinRequest,
} from '../src/renderer/src/im-template/template/types';
import { SidebarHeader } from '../src/renderer/src/im-template/template/sidebarHeader';
import { AppRail } from '../src/renderer/src/im-template/template/rail';
import { FavoriteActions } from '../src/renderer/src/components/qq-actions/FavoriteActions';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { GroupJoinAction } from '../src/renderer/src/components/qq-actions/GroupJoinAction';
import { GroupActions, GroupTodos } from '../src/renderer/src/components/qq-actions/GroupActions';
import { ProfileLikeAction } from '../src/renderer/src/components/qq-actions/ProfileLikeAction';
import { PROFILE_LIKE_MAX_PER_REQUEST } from '@weq/protocol';
import { GroupAnnouncementsDialog } from '../src/renderer/src/components/GroupAnnouncementsDialog';
import { GroupInfoPanel } from '../src/renderer/src/im-template/template/groupInfoPanel';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { GroupSignDialog } from '../src/renderer/src/components/GroupSignDialog';
import {
  MessageTodoAction,
  TypingStatus,
} from '../src/renderer/src/components/qq-actions/ChatActions';
import { QqInlineKeyboard } from '../src/renderer/src/components/QqInlineKeyboard';
import { useViewState } from '../src/renderer/src/state/view';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';

const state = vi.hoisted(() => ({
  configId: 'source-a',
  available: true,
  mutate: vi.fn(
    async (_name: string, _input: unknown): Promise<QQWriteOutcome> => ({ state: 'accepted' }),
  ),
  confirm: vi.fn(async () => true),
  picker: vi.fn(async () => ({ path: '/selected/image.png', fileName: 'image.png' })),
  prepare: vi.fn(async () => ({
    groupId: 888,
    name: '目标群',
    option: 5,
    question: '为什么加入',
    questionState: 'available' as const,
    token: '00000000-0000-4000-8000-000000000001',
    alreadyMember: false,
  })),
  refreshSigns: vi.fn(async () => {}),
  refreshTodos: vi.fn(async (_input?: unknown) => {}),
  refreshJoin: vi.fn(async () => {}),
  refreshPeerStats: vi.fn(async () => {}),
  data: {} as Record<string, unknown>,
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => h('div', { role: 'dialog' }, children),
  useDialog: Object.assign(
    (selector: (s: { confirm: typeof state.confirm }) => unknown) =>
      selector({ confirm: state.confirm }),
    { getState: () => ({ confirm: state.confirm }) },
  ),
}));
vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ open = true, children }: { open?: boolean; children: ReactNode }) =>
    open ? children : null,
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: state.configId },
    available: state.available,
    busy: false,
    result: null,
    run: async (
      action: (b: QQWriteBinding) => Promise<QQWriteOutcome>,
      refresh?: () => Promise<unknown>,
      options?: { readback?: () => Promise<boolean> },
    ) => {
      try {
        await action({ expectedAccountUin: '10001', expectedAccountConfigId: state.configId });
        await options?.readback?.();
        await refresh?.();
        return true;
      } catch {
        return false;
      }
    },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const names = [
    'file',
    'fileUpload',
    'notice',
    'albumUpload',
    'albumMedia',
    'favorite',
    'request',
    'todo',
    'groupSettings',
    'qzone',
    'join',
    'inputStatus',
    'inlineButton',
    'profileLike',
  ];
  const reads = [
    'fileSummary',
    'folders',
    'notices',
    'favorites',
    'favoriteImportState',
    'requests',
    'tags',
    'todoList',
    'todoLocalList',
    'groupReadTools',
    'groupPermissions',
    'groupJoinSettings',
  ];
  return {
    client: {
      account: {
        dressup: { peerStats: { query: async () => ({ likeCount: 100 }) } },
        listAllGroups: { query: async () => [] },
        listGroupAlbumMedia: { query: async () => [] },
        pickSendFile: { mutate: state.picker },
        sendFile: {
          mutate: async (input: unknown) => {
            const result = await state.mutate('sendFile', input);
            return { ok: result.state === 'accepted' || result.state === 'confirmed' };
          },
        },
        qqActions: {
          ...Object.fromEntries(
            reads.map((name) => [name, { query: async () => state.data[name] ?? [] }]),
          ),
          folders: {
            query: async (input: { directory: string }) => ({
              targetDirectory: input.directory,
              files: [],
              folders: [],
              ...((state.data[`listing:${input.directory}`] as object) ?? {}),
            }),
          },
          ...Object.fromEntries(
            names.map((name) => [name, { mutate: (input: unknown) => state.mutate(name, input) }]),
          ),
          prepareJoin: { mutate: state.prepare },
        },
      },
    },
    trpc: {
      bootstrap: {
        getSettings: { useQuery: () => ({ data: { exportSaveMode: 'before' }, isLoading: false }) },
      },
      useUtils: () => ({
        account: {
          dressup: { peerStats: { invalidate: state.refreshPeerStats } },
          listBuddyRequests: { invalidate: async () => {} },
          listGroupNotifies: { invalidate: async () => {} },
          qqActions: {
            requests: { invalidate: async () => {} },
            groupReadTools: { invalidate: state.refreshSigns },
            todoList: { invalidate: state.refreshTodos },
          },
        },
      }),
      account: {
        getAccountConfig: {
          useQuery: () => ({ data: { uin: '10001', configId: state.configId } }),
        },
        qqActions: Object.fromEntries(
          reads.map((name) => [
            name,
            {
              useQuery: (input?: { kind?: string }) => ({
                data: state.data[`${name}:${input?.kind}`] ?? state.data[name],
                isLoading: false,
                isFetching: false,
                error: state.data[`error:${name}`],
                refetch: async () => {
                  if (name === 'groupJoinSettings') await state.refreshJoin();
                  return { error: null, data: state.data[name] };
                },
              }),
            },
          ]),
        ),
      },
    },
  };
});
const cleanups: Array<() => void> = [];
function captureManagement(host: HTMLElement, name: string) {
  const directory = process.env.WEQ_NOTICE_LAYOUT;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const clone = host.firstElementChild!.cloneNode(true) as HTMLElement;
  for (const image of clone.querySelectorAll('img')) {
    image.src = `data:image/png;base64,${Buffer.from(makeSolidPng(320, 180, [35, 119, 99])).toString('base64')}`;
  }
  const styles = [
    'index',
    'workspace-surfaces',
    'page-chrome',
    'qq-actions',
    'qq-management',
    'profile-like',
    'group-content-management',
    'conversation-actions',
    'profile-avatar',
  ]
    .map(
      (name) =>
        `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', `${name}.css`)}">`,
    )
    .join('');
  writeFileSync(
    resolve(directory, `notice-${name}.html`),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>html,body{margin:0;height:100%;font-family:system-ui;background:var(--background);color:var(--foreground)}*,*::before,*::after{box-sizing:border-box}</style><body><main class="weq-workspace-page weq-workspace-sidecar-page weq-workspace-page-fallback">${clone.outerHTML}</main></body></html>`,
  );
}
function fixture(render: () => ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const update = () => act(() => root.render(render()));
  update();
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const button = (label: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  return { host, update, button };
}
function value(host: HTMLElement, label: string, next: string) {
  const node = host.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )!;
  act(() => {
    const proto =
      node.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : node.tagName === 'SELECT'
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, next);
    node.dispatchEvent(
      new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    );
  });
}
const menuButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent === label,
  )!;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  state.configId = 'source-a';
  state.available = true;
  state.mutate.mockClear();
  state.confirm.mockReset().mockResolvedValue(true);
  state.picker.mockClear();
  state.prepare.mockClear();
  state.refreshSigns.mockClear();
  state.refreshTodos.mockClear();
  state.refreshJoin.mockClear();
  state.refreshPeerStats.mockClear();
  state.data = {
    groupPermissions: { canManage: true, role: 'admin', selfUin: '10001' },
    fileSummary: { fileCount: 1, maxCount: 100, usedSpace: 10, totalSpace: 1000 },
    folders: { folders: [{ folderId: 'folder-b', folderName: '目录 B' }] },
    notices: [],
    favorites: [{ emojiId: 'favorite-a', position: 1, desc: '原备注', local: null }],
    requests: [{ token: 'request-a', name: '申请人', groupName: '群 A', message: '留言' }],
    tags: [],
    todoList: [],
    todoLocalList: [],
    groupReadTools: {
      signed: [],
      atAll: { canAtAll: true, remainCountForUin: 1, remainCountForGroup: 1 },
    },
    groupJoinSettings: { groupId: 123, option: 2, question: null, questionState: 'not-required' },
  };
  useViewState.setState({ openedUin: '10001' });
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});

describe('QQ 主动操作的实际界面', () => {
  it('在线列表为空时保留本地待办，点击摘要正文也能打开详情', async () => {
    state.data.todoLocalList = [
      { sequence: '321', sourceId: '321_9', text: '本地已有待办', completed: false },
    ];
    const f = fixture(() => h(GroupTodos, { groupId: 123, groupName: '合成群', embedded: true }));
    expect(f.host.querySelector('[aria-label="待办内容"]')?.textContent).toContain('本地已有待办');
    await act(async () => f.host.querySelector<HTMLElement>('[aria-label="待办内容"]')!.click());
    expect(f.host.querySelector('[aria-label="群待办列表"]')).not.toBeNull();
    expect(f.button('完成待办')).not.toBeNull();
  });
  it('离线仍能查看本地待办，读取异常不冒充没有待办', async () => {
    state.available = false;
    state.data.todoLocalList = [{ sequence: '432', text: '离线缓存待办', completed: false }];
    const f = fixture(() => h(GroupTodos, { groupId: 123, embedded: true }));
    expect(f.host.textContent).toContain('离线缓存待办');
    await act(async () => f.button('查看群待办').click());
    expect(f.button('完成待办').disabled).toBe(true);
    state.data.todoLocalList = undefined;
    state.data['error:todoLocalList'] = new Error('缓存读取失败');
    f.update();
    expect(f.host.textContent).not.toContain('暂无群待办');
    expect(f.host.querySelector('[aria-label="待办内容"]')?.textContent).toContain('读取失败');
  });
  it('群待办先摘要后详情，完成项刷新、重新打开后仍保留且不串数据源', async () => {
    state.data.todoList = [
      { sequence: '123', sourceId: '123_1', text: '完成后要保留的待办', completed: false },
    ];
    let visible = true;
    const f = fixture(() => (visible ? h(GroupTodos, { groupId: 123, embedded: true }) : null));
    expect(f.button('完成待办')).toBeNull();
    expect(f.host.textContent).toContain('完成后要保留的待办');
    await act(async () => f.button('查看群待办').click());
    expect(f.button('完成待办').disabled).toBe(false);
    await act(async () => f.button('完成待办').click());
    state.data.todoList = [];
    f.update();
    expect(f.host.textContent).toContain('完成后要保留的待办');
    expect(f.button('完成待办').disabled).toBe(true);
    visible = false;
    f.update();
    visible = true;
    f.update();
    expect(f.host.textContent).toContain('已完成');
    expect(f.button('完成待办')).toBeNull();
    await act(async () => f.button('查看群待办').click());
    expect(f.button('完成待办').disabled).toBe(true);
    state.configId = 'source-b';
    f.update();
    expect(f.host.textContent).not.toContain('完成后要保留的待办');
    state.configId = 'source-a';
    f.update();
    expect(f.host.textContent).toContain('完成后要保留的待办');
  });

  it('完成待办的未知回执不伪造完成状态', async () => {
    state.data.todoList = [{ sequence: '123', text: '尚未确认的待办', completed: false }];
    const f = fixture(() => h(GroupTodos, { groupId: 123, embedded: true }));
    await act(async () => f.button('查看群待办').click());
    state.mutate.mockResolvedValueOnce({ state: 'unconfirmed' });
    await act(async () => f.button('完成待办').click());
    expect(f.button('完成待办').disabled).toBe(false);
    expect(f.host.textContent).toContain('待完成');
  });

  it('资料卡点赞先选次数再提交，取消不写，提交后只刷新目标统计', async () => {
    const f = fixture(() =>
      h(ProfileLikeAction, { uid: 'u_friend', uin: '10002', name: '合成好友' }),
    );
    await act(async () => f.button('赞资料卡').click());
    expect(f.button('点赞 +10')).not.toBeNull();
    expect(f.button('点赞 +20')).not.toBeNull();
    expect(f.host.querySelector('.weq-profile-like-stage.is-active input')).toBeNull();
    const count = f.host.querySelector<HTMLInputElement>('[aria-label="资料卡点赞次数"]')!;
    expect(count.value).toBe('1');
    expect(count.max).toBe(String(PROFILE_LIKE_MAX_PER_REQUEST));
    expect(state.mutate).not.toHaveBeenCalled();
    await act(async () => f.button('自定义点赞次数').click());
    value(f.host, '资料卡点赞次数', '3');
    captureManagement(f.host.querySelector<HTMLElement>('[role="dialog"]')!, 'profile-like');
    await act(async () => f.button('关闭资料卡点赞').click());
    expect(state.mutate).not.toHaveBeenCalled();
    await act(async () => f.button('赞资料卡').click());
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="资料卡点赞次数"]')!.value).toBe(
      '1',
    );
    await act(async () => f.button('自定义点赞次数').click());
    value(f.host, '资料卡点赞次数', '3');
    await act(async () =>
      f.host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(state.mutate).toHaveBeenCalledWith('profileLike', {
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      uid: 'u_friend',
      count: 3,
    });
    expect(state.refreshPeerStats).toHaveBeenCalledWith({ uin: '10002', uid: 'u_friend' });
  });
  it('资料卡点赞拒绝非法次数，离线不可写，同号换来源或换目标不沿用草稿', async () => {
    let target = { uid: 'u_friend', uin: '10002', name: '合成好友' };
    const f = fixture(() => h(ProfileLikeAction, target));
    await act(async () => f.button('赞资料卡').click());
    await act(async () => f.button('自定义点赞次数').click());
    for (const count of ['', '0', '1.5', String(PROFILE_LIKE_MAX_PER_REQUEST + 1)]) {
      value(f.host, '资料卡点赞次数', count);
      expect(f.button('确认点赞').disabled).toBe(true);
    }
    value(f.host, '资料卡点赞次数', '4');
    state.available = false;
    f.update();
    expect(f.button('确认点赞').disabled).toBe(true);
    state.available = true;
    state.configId = 'source-b';
    f.update();
    expect(f.host.querySelector('.weq-profile-like-stage.is-active input')).toBeNull();
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="资料卡点赞次数"]')!.value).toBe(
      '1',
    );
    target = { uid: 'u_other', uin: '10003', name: '其他人' };
    f.update();
    expect(f.host.querySelector('form')).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('本人和没有真实 UID 的资料卡不显示点赞入口', () => {
    const f = fixture(() => h(ProfileLikeAction, { uid: 'u_self', uin: '10001', name: '自己' }));
    expect(f.button('赞资料卡')).toBeNull();
    const missing = fixture(() =>
      h(ProfileLikeAction, { uid: '10002', uin: '10002', name: '缺 UID' }),
    );
    expect(missing.button('赞资料卡')).toBeNull();
  });
  it('创建群待办后刷新同账号同群列表，再关闭菜单', async () => {
    const demo = createTemplateDemoData();
    const group = demo.conversations.find((row) => row.type === 'group')!;
    const close = vi.fn(() => expect(state.refreshTodos).toHaveBeenCalledOnce());
    const f = fixture(() =>
      h(MessageTodoAction, {
        conversation: { ...group, id: '123' },
        message: { ...demo.messages[0], msgSeq: '9007199254740993' },
        onClose: close,
      }),
    );
    await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
    expect(state.refreshTodos).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      groupId: 123,
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it('已完成的待办不再提供重复完成操作，取消仍由群管理权限控制', async () => {
    state.data.todoList = [{ sequence: '123', text: '已完成事项', completed: true }];
    const f = fixture(() => h(GroupTodos, { groupId: 123, embedded: true }));
    expect(f.button('刷新')).toBeNull();
    expect(f.host.textContent).toContain('已完成');
    expect(f.button('完成待办')).toBeNull();
    await act(async () => f.button('查看群待办').click());
    expect(f.button('完成待办').disabled).toBe(true);
    expect(f.button('取消群待办')).toBeNull();
    act(() => f.button('待办操作 123').click());
    const cancel = document.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(cancel?.textContent).toContain('取消群待办');
    await act(async () => cancel!.click());
    expect(state.mutate).toHaveBeenCalledWith(
      'todo',
      expect.objectContaining({ groupId: 123, sequence: '123', action: 'cancel' }),
    );
    state.data.groupPermissions = { canManage: false };
    f.update();
    expect(f.button('待办操作 123')).toBeNull();
    expect(f.button('完成待办').disabled).toBe(true);
  });
  it('打卡页使用可见今日动作，防重复点击，成功后刷新记录，离线不可写', async () => {
    const management = fixture(() => h(GroupActions, { groupId: 123 }));
    expect(management.button('群打卡')).toBeNull();
    const f = fixture(() =>
      h(GroupSignDialog, { groupCode: '123', groupName: '测试群', onClose: vi.fn() }),
    );
    let finish!: (outcome: QQWriteOutcome) => void;
    state.mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => f.button('今日打卡').click());
    expect(f.button('今日打卡').disabled).toBe(true);
    act(() => f.button('今日打卡').click());
    expect(state.mutate).toHaveBeenCalledOnce();
    expect(state.mutate).toHaveBeenCalledWith('groupSettings', {
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      groupId: 123,
      action: 'sign',
    });
    await act(async () => finish({ state: 'accepted' }));
    expect(state.refreshSigns).toHaveBeenCalledOnce();
    expect(f.host.querySelector('summary')).toBeNull();
    state.available = false;
    f.update();
    expect(f.button('今日打卡').disabled).toBe(true);
  });
  it('资料、公告、待办同一侧栏独立竖排，原待办操作与权限不变', async () => {
    state.data.todoList = [{ sequence: '123', text: '统一入口的待办' }];
    const management = fixture(() => h(GroupActions, { groupId: 123 }));
    expect(management.host.textContent).not.toContain('群待办');
    const announcement = fixture(() =>
      h(GroupAnnouncementsDialog, {
        groupCode: '123',
        groupName: '测试群',
        currentAnnouncement: '公告正文',
        onClose: vi.fn(),
      }),
    );
    expect(announcement.host.querySelector('[role="tab"]')).toBeNull();
    expect(announcement.host.textContent).toContain('公告正文');
    expect(announcement.host.textContent).not.toContain('群待办');
    const original = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
    const f = fixture(() =>
      h(GroupInfoPanel, {
        conversation: { ...original, group: { ...original.group, announcement: '公告摘要' } },
        onOpenAnnouncements: vi.fn(),
        groupTodos: h(GroupTodos, { groupId: 123, embedded: true }),
      }),
    );
    const sections = [...f.host.querySelectorAll('aside > section[aria-label]')];
    expect(sections.map((section) => section.getAttribute('aria-label'))).toEqual([
      '群资料',
      '群公告',
      '群待办',
    ]);
    expect(sections[1].textContent).toContain('公告摘要');
    const panel = sections[2];
    expect(panel.textContent).toContain('统一入口的待办');
    expect(panel.querySelector('summary')).toBeNull();
    expect(panel.textContent).not.toContain('公告正文');
    expect(f.button('完成待办')).toBeNull();
    await act(async () => f.button('查看群待办').click());
    await act(async () => f.button('完成待办').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'todo',
      expect.objectContaining({
        expectedAccountUin: '10001',
        expectedAccountConfigId: 'source-a',
        groupId: 123,
        sequence: '123',
        action: 'complete',
      }),
    );
  });
  it('空间点赞即时翻转，未确认回退，执行期间禁用', async () => {
    const f = fixture(() =>
      h(QzoneWriteActions, {
        hostUin: '10002',
        tid: 'post-a',
        time: 1,
        initialLiked: false,
        onChanged: vi.fn(),
      }),
    );
    state.mutate.mockResolvedValueOnce({ state: 'unconfirmed' });
    await act(async () => f.button('点赞说说').click());
    expect(f.button('点赞说说').getAttribute('aria-pressed')).toBe('false');
    let finish!: (outcome: QQWriteOutcome) => void;
    state.mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => f.button('点赞说说').click());
    expect(f.button('取消说说点赞').getAttribute('aria-pressed')).toBe('true');
    expect(f.button('取消说说点赞').disabled).toBe(true);
    expect(f.button('取消说说点赞').getAttribute('aria-busy')).toBe('true');
    await act(async () => finish({ state: 'accepted' }));
    expect(f.button('取消说说点赞').getAttribute('aria-pressed')).toBe('true');
    expect(f.button('点赞说说')).toBeNull();
    await act(async () => f.button('取消说说点赞').click());
    expect(state.mutate).toHaveBeenLastCalledWith(
      'qzone',
      expect.objectContaining({ action: 'unlike' }),
    );
    expect(f.button('点赞说说').getAttribute('aria-pressed')).toBe('false');
  });
  it('远端已经点赞时直接提供取消，取消失败保留原状态', async () => {
    const f = fixture(() =>
      h(QzoneWriteActions, {
        hostUin: '10002',
        tid: 'post-a',
        time: 1,
        initialLiked: true,
        onChanged: vi.fn(),
      }),
    );
    state.mutate.mockRejectedValueOnce(new Error('网络失败'));
    await act(async () => f.button('取消说说点赞').click());
    expect(f.button('取消说说点赞').getAttribute('aria-pressed')).toBe('true');
  });
  it('相册视频互动使用视频 ID，删除使用封面 lloc，缺少封面不能猜测删除标识', async () => {
    const props = {
      groupId: 123,
      albumId: 'album-a',
      mediaId: 'video-a',
      deleteMediaId: 'cover-a',
      batchId: '42',
      uploaderUin: '10001',
      uploadTime: 1,
      onChanged: vi.fn(),
    };
    const f = fixture(() => h(GroupAlbumMediaActions, props));
    await act(async () => f.button('点赞媒体').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'albumMedia',
      expect.objectContaining({ action: 'like', mediaId: 'video-a' }),
    );
    await act(async () => f.button('删除相册媒体').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'albumMedia',
      expect.objectContaining({ action: 'delete', mediaId: 'cover-a' }),
    );
    props.deleteMediaId = '';
    f.update();
    expect(f.button('删除相册媒体').disabled).toBe(true);
    props.deleteMediaId = 'cover-a';
    props.uploaderUin = '';
    props.uploadTime = Number.NaN;
    f.update();
    expect(f.button('取消媒体点赞').disabled).toBe(true);
    expect(f.button('删除相册媒体').disabled).toBe(false);
  });
  it('通知入口按未查看数显示独立红点，查看清除后不残留', () => {
    let friendNoticeCount = 1;
    const f = fixture(() =>
      h(SidebarHeader, {
        user: {
          id: 'u_self',
          username: 'u_self',
          identityLabel: 'QQ',
          identityValue: '10001',
          displayName: '自己',
          avatarUrl: null,
        },
        view: 'contacts',
        query: '',
        onQueryChange: vi.fn(),
        onQuickInvite: vi.fn(),
        onCreateGroup: vi.fn(),
        onOpenProfile: vi.fn(),
        onOpenFriendNotices: vi.fn(),
        onOpenGroupNotices: vi.fn(),
        contactTab: 'friends',
        onContactTabChange: vi.fn(),
        activeNotice: null,
        friendNoticeCount,
        groupNoticeCount: 0,
      }),
    );
    expect(f.host.querySelector('[aria-label="有新的好友通知"]')).not.toBeNull();
    expect(f.host.querySelector('[aria-label="有新的群通知"]')).toBeNull();
    friendNoticeCount = 0;
    f.update();
    expect(f.host.querySelector('.notice-entry-dot')).toBeNull();
  });
  it('最外层联系人入口使用红点而不是通知数字', () => {
    const noop = vi.fn();
    const f = fixture(() =>
      h(AppRail, {
        user: {
          id: 'u_self',
          username: 'u_self',
          identityLabel: 'QQ',
          identityValue: '10001',
          displayName: '自己',
          avatarUrl: null,
        },
        view: 'messages',
        onViewChange: noop,
        onOpenSettings: noop,
        onOpenCollection: noop,
        onOpenDressUp: noop,
        onOpenProfile: noop,
        onOpenAbout: noop,
        onOpenInvite: noop,
        onOpenWonderfulTools: noop,
        onOpenAntiRecall: noop,
        onOpenDbRepair: noop,
        onOpenQzoneAlbum: noop,
        contactBadgeCount: 2,
      }),
    );
    const dot = f.host.querySelector('[aria-label="有新的好友或群通知"]');
    expect(dot?.classList.contains('rail-badge-dot')).toBe(true);
    expect(dot?.textContent).toBe('');
  });
  it('机器人回调只有元数据齐全且确认后才提交，缺少原会话定位时只读', async () => {
    const rows = [
      [{ buttonId: 'callback-a', label: '测试回调', action: 'payload', actionType: 1 }],
    ];
    const preview = fixture(() =>
      h(QqInlineKeyboard, { rows, sequence: '500', botAppid: '10001' }),
    );
    expect(preview.host.querySelector('button')).toBeNull();
    const local = fixture(() =>
      h(QqInlineKeyboard, { rows, groupId: '123', sequence: '0', botAppid: '10001' }),
    );
    expect(local.host.querySelector('button')).toBeNull();
    const f = fixture(() =>
      h(QqInlineKeyboard, { rows, groupId: '123', sequence: '500', botAppid: '10001' }),
    );
    state.confirm.mockResolvedValueOnce(false);
    await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
    expect(state.mutate).not.toHaveBeenCalled();
    await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
    expect(state.mutate).toHaveBeenCalledWith(
      'inlineButton',
      expect.objectContaining({
        groupId: 123,
        sequence: '500',
        botAppid: '10001',
        buttonId: 'callback-a',
        callbackData: 'payload',
        expectedAccountConfigId: 'source-a',
      }),
    );
  });
  it('输入状态默认不广播，显式开启后限流，切换数据源恢复关闭', async () => {
    const editor = createRef<HTMLDivElement>();
    const f = fixture(() =>
      h(
        'div',
        null,
        h('div', { ref: editor, contentEditable: true }),
        h(TypingStatus, { uid: 'u_friend', editors: [editor] }),
      ),
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      act(() => editor.current!.dispatchEvent(new Event('input', { bubbles: true })));
      expect(state.mutate).not.toHaveBeenCalled();
      act(() => f.button('发送正在输入状态').click());
      await act(async () => editor.current!.dispatchEvent(new Event('input', { bubbles: true })));
      await act(async () => editor.current!.dispatchEvent(new Event('input', { bubbles: true })));
      expect(state.mutate).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(10_000);
      await act(async () => editor.current!.dispatchEvent(new Event('input', { bubbles: true })));
      expect(state.mutate).toHaveBeenCalledTimes(2);
      state.configId = 'source-b';
      f.update();
      expect(f.button('发送正在输入状态').getAttribute('aria-pressed')).toBe('false');
    } finally {
      clock.mockRestore();
    }
  });
  const file = {
    fileId: 'file-a',
    fileName: '文件 A',
    fileSize: 1,
    busId: 102,
    uploadedTime: 0,
    expireTime: 0,
    modifiedTime: 0,
    downloadedTimes: 0,
    uploaderUin: 10001,
    uploaderName: '自己',
    parentDirectory: 'folder-a',
  };
  it('普通成员可查看全部文件，但只能管理自己上传的文件', () => {
    state.data.groupPermissions = { canManage: false, role: 'member', selfUin: '10001' };
    state.data.todoList = [{ sequence: '123', text: '待办内容' }];
    const notices = fixture(() => h(GroupNoticeActions, { groupId: 123 }));
    expect(notices.host.querySelector('details')).toBeNull();
    const todos = fixture(() => h(GroupTodos, { groupId: 123 }));
    expect(todos.button('取消群待办')).toBeNull();
    expect(todos.button('完成待办')).not.toBeNull();
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: 'folder-a',
        files: [file, { ...file, fileId: 'other', fileName: '文件 B', uploaderUin: 10002 }],
        folders: [],
        onChanged: vi.fn(),
      }),
    );
    expect(f.button('新建文件夹')).toBeNull();
    expect(f.host.querySelector('[data-file-id="other"]')).not.toBeNull();
    act(() =>
      f.host
        .querySelector<HTMLButtonElement>('[data-file-id="other"] .weq-file-manager-name button')!
        .click(),
    );
    expect(f.button('删除所选项目').disabled).toBe(true);
    act(() =>
      f.host
        .querySelector<HTMLButtonElement>('[data-file-id="file-a"] .weq-file-manager-name button')!
        .click(),
    );
    expect(f.button('删除所选项目').disabled).toBe(false);
  });
  it('删除取消不发请求，确认后保留账号、群和原文件标识', async () => {
    state.data['listing:folder-a'] = { files: [file], folders: [] };
    const changed = vi.fn();
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: 'folder-a',
        files: [file],
        folders: [],
        onChanged: changed,
      }),
    );
    act(() =>
      f.host
        .querySelector<HTMLButtonElement>('[data-file-id="file-a"] .weq-file-manager-name button')!
        .click(),
    );
    state.confirm.mockResolvedValueOnce(false);
    await act(async () => f.button('删除所选项目').click());
    expect(state.mutate).not.toHaveBeenCalled();
    await act(async () => f.button('删除所选项目').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'file',
      expect.objectContaining({
        expectedAccountUin: '10001',
        expectedAccountConfigId: 'source-a',
        groupId: 123,
        id: 'file-a',
        directory: 'folder-a',
        action: 'delete',
      }),
    );
    expect(changed).toHaveBeenCalledOnce();
  });
  it('文件上传使用当前目录，而非固定根目录', async () => {
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: 'folder-a',
        files: [],
        folders: [],
        onChanged: vi.fn(),
      }),
    );
    await act(async () => f.button('选择上传文件').click());
    await act(async () => f.button('上传待处理文件').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'sendFile',
      expect.objectContaining({
        peerType: 'group',
        targetId: '123',
        folderId: 'folder-a',
        path: '/selected/image.png',
      }),
    );
  });
  it('同号切换数据源销毁未保存的文件管理草稿', () => {
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: '/',
        files: [],
        folders: [],
        onChanged: vi.fn(),
      }),
    );
    act(() => f.button('新建文件夹').click());
    value(f.host, '新名称', '旧数据源草稿');
    state.configId = 'source-b';
    f.update();
    expect(f.host.querySelector('[aria-label="新名称"]')).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('新建文件夹编辑期间失去管理权限，保留草稿但禁止提交', async () => {
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: '/',
        files: [],
        folders: [],
        onChanged: vi.fn(),
      }),
    );
    await act(async () => f.button('新建文件夹').click());
    value(f.host, '新名称', '新目录');
    state.data.groupPermissions = { canManage: false, role: 'member', selfUin: '10001' };
    f.update();
    expect(f.button('执行文件操作').disabled).toBe(true);
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('目录空白处菜单就近提供上传和新建，不对空选择执行保存', async () => {
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: '/',
        files: [],
        folders: [],
        onChanged: vi.fn(),
        onSaveSelected: vi.fn(),
      }),
    );
    act(() =>
      f.host
        .querySelector('[aria-label="群文件管理器"]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 })),
    );
    expect(menuButton('选择上传文件')).toBeDefined();
    expect(menuButton('保存所选项目').disabled).toBe(true);
    await act(async () => menuButton('新建文件夹').click());
    expect(f.host.querySelector('[aria-label="新名称"]')).not.toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('空或损坏的拖入对象不崩溃，不改已有文件或发请求', () => {
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: '/',
        files: [file],
        folders: [],
        onChanged: vi.fn(),
      }),
    );
    for (const dataTransfer of [
      null,
      {
        getData: () => {
          throw new Error('拖入资源损坏');
        },
      },
    ]) {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      act(() => f.host.querySelector('[aria-label="群文件管理器"]')!.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    }
    expect(f.host.querySelector('[data-file-id="file-a"]')).not.toBeNull();
    expect(f.host.textContent).toContain('拖入资源损坏');
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('批量删除不强求确认回执，操作结果不附加在列表中，也不自动重发', async () => {
    const files = [file, { ...file, fileId: 'file-b', fileName: '文件 B' }];
    state.data['listing:folder-a'] = { files, folders: [] };
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: 'folder-a',
        files,
        folders: [],
        onChanged: vi.fn(),
      }),
    );
    act(() => f.host.querySelector<HTMLInputElement>('[aria-label="选择当前可见项目"]')!.click());
    state.mutate.mockResolvedValueOnce({ state: 'unconfirmed' });
    await act(async () => f.button('删除所选项目').click());
    expect(state.mutate).toHaveBeenCalledTimes(2);
    expect(f.host.querySelector('.weq-file-receipts')).toBeNull();
    expect(f.button('删除所选项目').disabled).toBe(true);
    expect(f.host.textContent).not.toContain('结果待核对');
  });
  it('普通点击建立锚点，Shift 点击按当前排序选择连续区间', () => {
    const files = [
      file,
      { ...file, fileId: 'file-b', fileName: '文件 B' },
      { ...file, fileId: 'file-c', fileName: '文件 C' },
    ];
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: 'folder-a',
        files,
        folders: [],
        onChanged: vi.fn(),
      }),
    );
    act(() =>
      f.host
        .querySelector<HTMLButtonElement>('[data-file-id="file-a"] .weq-file-manager-name button')!
        .click(),
    );
    act(() =>
      f.host
        .querySelector('[data-file-id="file-c"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })),
    );
    expect(f.host.querySelectorAll('tbody tr[aria-selected="true"]')).toHaveLength(3);
  });
  it('写入一项后切源停止余下批次，不向新账号发请求', async () => {
    const files = [file, { ...file, fileId: 'file-b', fileName: '文件 B' }];
    state.data['listing:folder-a'] = { files, folders: [] };
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: 'folder-a',
        files,
        folders: [],
        onChanged: vi.fn(),
      }),
    );
    act(() => f.host.querySelector<HTMLInputElement>('[aria-label="选择当前可见项目"]')!.click());
    state.mutate.mockImplementationOnce(async () => {
      state.configId = 'source-b';
      f.update();
      return { state: 'accepted' };
    });
    await act(async () => f.button('删除所选项目').click());
    expect(state.mutate).toHaveBeenCalledTimes(1);
  });
  it('重命名预检同名冲突，不发送写请求并保留输入', async () => {
    const files = [file, { ...file, fileId: 'file-b', fileName: '已有名称' }];
    state.data['listing:folder-a'] = { files, folders: [] };
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: 'folder-a',
        files,
        folders: [],
        onChanged: vi.fn(),
      }),
    );
    act(() =>
      f.host
        .querySelector<HTMLButtonElement>('[data-file-id="file-a"] .weq-file-manager-name button')!
        .click(),
    );
    await act(async () => f.button('重命名所选项目').click());
    expect(document.activeElement).toBe(f.host.querySelector('[aria-label="新名称"]'));
    value(f.host, '新名称', '已有名称');
    await act(async () => f.button('执行文件操作').click());
    expect(state.mutate).not.toHaveBeenCalled();
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="新名称"]')!.value).toBe('已有名称');
  });
  it('内部拖到目录先准备移动，确认后沿用真实群、文件与目标目录', async () => {
    const folder = {
      folderId: 'folder-b',
      parentDirectoryId: 'folder-a',
      folderName: '目录 B',
      totalFileCount: 0,
      creatorUin: 10001,
      creatorName: '自己',
      createTime: 0,
      modifiedTime: 0,
    };
    state.data['listing:folder-a'] = { files: [file], folders: [folder] };
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: 'folder-a',
        files: [file],
        folders: [folder],
        onChanged: vi.fn(),
      }),
    );
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        getData: () =>
          JSON.stringify({
            version: 1,
            groupId: 123,
            uin: '10001',
            configId: 'source-a',
            directory: 'folder-a',
            ids: ['file-a'],
          }),
        types: ['application/x-weq-group-files'],
      },
    });
    await act(async () =>
      f.host.querySelector('[data-weq-select-id="folder:folder-b"]')!.dispatchEvent(event),
    );
    expect(state.mutate).not.toHaveBeenCalled();
    expect(f.host.querySelector('[aria-label="目标目录"]')?.textContent).toContain('目录 B');
    await act(async () => f.button('执行文件操作').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'file',
      expect.objectContaining({
        groupId: 123,
        id: 'file-a',
        directory: 'folder-a',
        destination: 'folder-b',
        action: 'move',
      }),
    );
  });
  it('重复拖入本机文件只排队一次，确认前不上传，取消离开保留待上传项', async () => {
    const open = vi.fn();
    Reflect.set(window, 'weq', { pathForFile: () => '/local/drop.txt' });
    const folder = {
      folderId: 'folder-b',
      parentDirectoryId: 'folder-a',
      folderName: '目录 B',
      totalFileCount: 0,
      creatorUin: 10001,
      creatorName: '自己',
      createTime: 0,
      modifiedTime: 0,
    };
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: 'folder-a',
        files: [],
        folders: [folder],
        onChanged: vi.fn(),
        onOpenFolder: open,
      }),
    );
    const dropped = new File(['data'], 'drop.txt');
    for (let i = 0; i < 2; i++) {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { getData: () => '', types: ['Files'], files: [dropped] },
      });
      act(() => f.host.querySelector('[aria-label="群文件管理器"]')!.dispatchEvent(event));
    }
    expect(f.host.querySelectorAll('.weq-file-upload-row')).toHaveLength(1);
    expect(state.mutate).not.toHaveBeenCalled();
    state.confirm.mockResolvedValueOnce(false);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.weq-file-manager-name button')!.click(),
    );
    expect(open).not.toHaveBeenCalled();
    expect(f.host.textContent).toContain('待上传');
    Reflect.deleteProperty(window, 'weq');
  });
  it('拖入本机文件到文件夹保留明确目标，确认后上传到该文件夹', async () => {
    Reflect.set(window, 'weq', { pathForFile: () => '/local/drop.txt' });
    const folder = {
      folderId: 'folder-b',
      parentDirectoryId: 'folder-a',
      folderName: '目录 B',
      totalFileCount: 0,
      creatorUin: 10001,
      creatorName: '自己',
      createTime: 0,
      modifiedTime: 0,
    };
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: 'folder-a',
        files: [],
        folders: [folder],
        onChanged: vi.fn(),
      }),
    );
    try {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { getData: () => '', types: ['Files'], files: [new File(['x'], 'drop.txt')] },
      });
      act(() =>
        f.host.querySelector('[data-weq-select-id="folder:folder-b"]')!.dispatchEvent(event),
      );
      expect(f.host.querySelector('.weq-file-upload-row')?.textContent).toContain('目录 B');
      expect(state.mutate).not.toHaveBeenCalled();
      await act(async () => f.button('上传待处理文件').click());
      expect(state.mutate).toHaveBeenCalledWith(
        'sendFile',
        expect.objectContaining({ folderId: 'folder-b', targetId: '123', path: '/local/drop.txt' }),
      );
    } finally {
      Reflect.deleteProperty(window, 'weq');
    }
  });
  it('上传未知回执停止后续项，手动继续只处理尚未执行的文件', async () => {
    Reflect.set(window, 'weq', { pathForFile: (file: File) => `/local/${file.name}` });
    const f = fixture(() =>
      h(GroupFileActions, {
        groupId: 123,
        directory: '/',
        files: [],
        folders: [],
        onChanged: vi.fn(),
      }),
    );
    try {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: {
          getData: () => '',
          types: ['Files'],
          files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')],
        },
      });
      act(() => f.host.querySelector('[aria-label="群文件管理器"]')!.dispatchEvent(event));
      state.mutate.mockResolvedValueOnce({ state: 'unconfirmed' });
      await act(async () => f.button('上传待处理文件').click());
      expect(state.mutate).toHaveBeenCalledTimes(1);
      expect(f.host.querySelectorAll('.weq-file-upload-row')[0]!.textContent).not.toContain(
        '结果待核对',
      );
      expect(f.host.querySelectorAll('.weq-file-upload-row')[1]!.textContent).not.toContain(
        '待上传',
      );
      await act(async () => f.button('上传待处理文件').click());
      expect(state.mutate.mock.calls.map((call) => (call[1] as { path: string }).path)).toEqual([
        '/local/a.txt',
        '/local/b.txt',
      ]);
    } finally {
      Reflect.deleteProperty(window, 'weq');
    }
  });
  it('未确认的公告发布保留原稿，不当作已经成功发布', async () => {
    const f = fixture(() => h(GroupNoticeActions, { groupId: 123 }));
    const create = f.button('新建公告');
    if (create) act(() => create.click());
    value(f.host, '新公告内容', '尚未确认的公告草稿');
    state.mutate.mockResolvedValueOnce({ state: 'unconfirmed' });
    await act(async () => f.button('发布公告').click());
    expect(f.host.querySelector<HTMLTextAreaElement>('[aria-label="新公告内容"]')!.value).toBe(
      '尚未确认的公告草稿',
    );
  });
  it('公告界面传递弹窗提醒和群名片引导选项', async () => {
    const f = fixture(() => h(GroupNoticeActions, { groupId: 123 }));
    act(() => f.button('新建公告').click());
    value(f.host, '新公告内容', '新的公告');
    const inputs = [...f.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    act(() => {
      inputs.find((input) => input.parentElement?.textContent?.includes('弹窗提醒'))!.click();
      inputs.find((input) => input.parentElement?.textContent?.includes('群名片引导'))!.click();
    });
    await act(async () => f.button('发布公告').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'notice',
      expect.objectContaining({ content: '新的公告', popup: true, editCardGuide: true }),
    );
  });
  it('公告按 ID 在正文旁提供菜单，不重复渲染管理清单，删除保持原目标', async () => {
    state.data.notices = [
      {
        noticeId: 'notice-a',
        senderId: 10001,
        publishTime: 1,
        text: '在线公告',
        images: [],
        readNum: 2,
      },
    ];
    const f = fixture(() =>
      h(GroupAnnouncementsDialog, {
        groupCode: '123',
        groupName: '合成群',
        bulletins: [
          {
            fid: 'notice-a',
            publisherUid: 'uid-a',
            textContent: '本地旧公告',
            ctime: '',
            msgTime: '',
          },
        ],
        onClose: vi.fn(),
      }),
    );
    expect(f.host.querySelector('details')).toBeNull();
    expect(f.host.querySelectorAll('[data-notice-key]')).toHaveLength(1);
    expect(f.host.textContent).toContain('在线公告');
    expect(f.host.querySelector('[aria-label="新公告内容"]')).toBeNull();
    act(() => f.button('公告操作 notice-a').click());
    state.confirm.mockResolvedValueOnce(false);
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(state.mutate).not.toHaveBeenCalled();
    act(() => f.button('公告操作 notice-a').click());
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(state.mutate).toHaveBeenCalledWith(
      'notice',
      expect.objectContaining({
        groupId: 123,
        noticeId: 'notice-a',
        action: 'delete',
        expectedAccountConfigId: 'source-a',
      }),
    );
  });
  it('公告编辑器按需打开，取消放弃仍保留草稿，确认后收起并恢复焦点', async () => {
    const f = fixture(() => h(GroupNoticeActions, { groupId: 123 }));
    act(() => f.button('新建公告').click());
    expect(document.activeElement?.getAttribute('aria-label')).toBe('新公告内容');
    value(f.host, '新公告内容', '需要保留的原稿');
    state.confirm.mockResolvedValueOnce(false);
    await act(async () => f.button('关闭公告编辑器').click());
    expect(f.host.querySelector<HTMLTextAreaElement>('[aria-label="新公告内容"]')!.value).toBe(
      '需要保留的原稿',
    );
    await act(async () => f.button('关闭公告编辑器').click());
    expect(f.host.querySelector('[aria-label="新公告内容"]')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('新建公告');
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('关闭公告页复用草稿保护，不丢未保存正文', async () => {
    const close = vi.fn();
    const f = fixture(() =>
      h(GroupAnnouncementsDialog, { groupCode: '123', groupName: '合成群', onClose: close }),
    );
    act(() => f.button('新建公告').click());
    value(f.host, '新公告内容', '尚未发布');
    state.confirm.mockResolvedValueOnce(false);
    await act(async () => f.button('关闭群公告').click());
    expect(close).not.toHaveBeenCalled();
    expect(f.host.querySelector<HTMLTextAreaElement>('[aria-label="新公告内容"]')!.value).toBe(
      '尚未发布',
    );
    await act(async () => f.button('关闭群公告').click());
    expect(close).toHaveBeenCalledOnce();
  });
  it('公告等待回执期间的新编辑不被成功回执清空，重复点击不多发', async () => {
    const f = fixture(() => h(GroupNoticeActions, { groupId: 123 }));
    act(() => f.button('新建公告').click());
    value(f.host, '新公告内容', '第一条');
    let finish!: (result: QQWriteOutcome) => void;
    state.mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => f.button('发布公告').click());
    expect(f.button('发布公告').disabled).toBe(true);
    value(f.host, '新公告内容', '第二条');
    act(() => f.button('发布公告').click());
    expect(state.mutate).toHaveBeenCalledOnce();
    await act(async () => finish({ state: 'accepted' }));
    expect(f.host.querySelector<HTMLTextAreaElement>('[aria-label="新公告内容"]')!.value).toBe(
      '第二条',
    );
  });
  it('公告受理后收起编辑器，失败保留正文和已选图片', async () => {
    const f = fixture(() => h(GroupNoticeActions, { groupId: 123 }));
    act(() => f.button('新建公告').click());
    value(f.host, '新公告内容', '带图片的公告');
    await act(async () => f.button('选择图片').click());
    state.mutate.mockRejectedValueOnce(new Error('合成发布失败'));
    await act(async () => f.button('发布公告').click());
    expect(f.host.querySelector('textarea')!.value).toBe('带图片的公告');
    expect(f.host.querySelector('.weq-qq-action-image img')?.getAttribute('alt')).toBe('image.png');
    await act(async () => f.button('发布公告').click());
    expect(f.host.querySelector('textarea')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('新建公告');
  });
  it('同号切源或切群会清除公告编辑器与菜单，不沿用旧目标', () => {
    let groupId = 123;
    state.data.notices = [
      {
        noticeId: 'notice-a',
        senderId: 10001,
        publishTime: 1,
        text: '公告',
        images: [],
        readNum: 0,
      },
    ];
    const f = fixture(() => h(GroupNoticeActions, { groupId }));
    act(() => f.button('新建公告').click());
    value(f.host, '新公告内容', '旧来源草稿');
    act(() => f.button('公告操作 notice-a').click());
    state.configId = 'source-b';
    f.update();
    expect(f.host.querySelector('textarea')).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    act(() => f.button('新建公告').click());
    value(f.host, '新公告内容', '旧群草稿');
    groupId = 456;
    f.update();
    expect(f.host.querySelector('textarea')).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('待办摘要不暴露写操作，详情中完成与取消仍按对应权限', async () => {
    state.data.todoList = [{ sequence: 'todo-a', text: '合成待办' }];
    const f = fixture(() => h(GroupTodos, { groupId: 123, embedded: true }));
    expect(f.host.querySelector('summary')).toBeNull();
    expect(f.button('取消群待办')).toBeNull();
    expect(f.button('完成待办')).toBeNull();
    await act(async () => f.button('查看群待办').click());
    expect(f.button('完成待办')).not.toBeNull();
    act(() => f.button('待办操作 todo-a').click());
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(state.mutate).toHaveBeenCalledWith(
      'todo',
      expect.objectContaining({ groupId: 123, sequence: 'todo-a', action: 'cancel' }),
    );
    state.data.groupPermissions = { canManage: false };
    f.update();
    expect(f.button('待办操作 todo-a')).toBeNull();
  });
  it('公告阅读、发布编辑器、普通成员与待办工具合成布局', async () => {
    state.data.notices = [
      {
        noticeId: 'notice-a',
        senderId: 10001,
        publishTime: 1,
        text: '这是一条用于检查正文附近工具按钮和长段落换行的合成公告。\n公告第二段。',
        images: [{ id: 'synthetic-image', width: 320, height: 180 }],
        readNum: 2,
      },
    ];
    const f = fixture(() =>
      h(GroupAnnouncementsDialog, {
        groupCode: '123',
        groupName: '合成群与长名称布局检查',
        currentAnnouncement: '当前公告摘要',
        bulletins: [
          {
            fid: 'local-b',
            publisherUid: 'uid-b',
            publisherName: '本地发布者',
            textContent: '本地历史公告，不因在线页未返回而消失。',
            ctime: '2026-10-20 08:00:00',
            msgTime: '',
          },
        ],
        onClose: vi.fn(),
      }),
    );
    captureManagement(f.host, 'reader');
    act(() => f.button('新建公告').click());
    value(f.host, '新公告内容', '准备发布的合成公告正文。\n第二行内容');
    await act(async () => f.button('选择图片').click());
    captureManagement(f.host, 'editor');
    state.data.groupPermissions = { canManage: false };
    f.update();
    expect(f.button('新建公告')).toBeNull();
    expect(f.button('发布公告').disabled).toBe(true);
    await act(async () => f.button('关闭公告编辑器').click());
    captureManagement(f.host, 'member');
    state.data.groupPermissions = { canManage: true };
    state.data.todoList = [
      { sequence: 'todo-a', text: '这是一项用于检查长内容不会挤压完成按钮和菜单的合成群待办。' },
      { sequence: 'todo-b', text: '第二项合成待办' },
    ];
    const todos = fixture(() => h(GroupTodos, { groupId: 123, embedded: true }));
    captureManagement(todos.host, 'todos');
    await act(async () => todos.button('查看群待办').click());
    captureManagement(todos.host, 'todos-open');
  });
  it('空间评论显示所选图片，并把路径交给主进程上传', async () => {
    const f = fixture(() =>
      h(QzoneWriteActions, { hostUin: '10002', tid: 'post-a', time: 100, onChanged: vi.fn() }),
    );
    value(f.host, '说说评论', '带图评论');
    await act(async () => f.button('选择图片').click());
    expect(f.host.querySelector('.weq-qq-action-image img')?.getAttribute('alt')).toBe('image.png');
    await act(async () => f.button('发送说说评论').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'qzone',
      expect.objectContaining({
        hostUin: '10002',
        tid: 'post-a',
        imagePath: '/selected/image.png',
        content: '带图评论',
      }),
    );
  });
  it('申请必须确认，确认后原 token 与所选操作保持一致', async () => {
    const f = fixture(() =>
      h(RequestActions, {
        operation: {
          kind: 'group',
          token: 'request-a',
          uid: 'u_peer',
          uin: '10002',
          groupId: '123',
          name: '申请人',
          groupName: '群 A',
          message: '留言',
        },
      }),
    );
    value(f.host, '拒绝理由', '验证未通过');
    expect(f.host.querySelector('details')).toBeNull();
    state.confirm.mockResolvedValueOnce(false);
    await act(async () => f.button('拒绝申请').click());
    expect(state.mutate).not.toHaveBeenCalled();
    await act(async () => f.button('拒绝申请').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({
        kind: 'group',
        token: 'request-a',
        approve: false,
        reason: '验证未通过',
      }),
    );
    expect(f.host.querySelector('[aria-label="同意申请"]')).toBeNull();
  });
  it('好友操作位于对应卡片内，自己发出的申请只读', () => {
    const user = {
      id: 'u_peer',
      username: 'u_peer',
      identityLabel: 'QQ',
      identityValue: '10002',
      displayName: '申请人',
      avatarUrl: null,
    };
    const incoming: ContactRequest = {
      id: 'in',
      user,
      direction: 'incoming',
      status: 'pending',
      message: '你好',
      createdAt: '2026-10-19T01:00:00Z',
      respondedAt: null,
    };
    state.data['requests:friend'] = [
      {
        token: 'u_peer',
        uid: 'u_peer',
        uin: '',
        groupId: '',
        name: '申请人',
        groupName: '',
        message: '你好',
      },
    ];
    state.data['requests:doubtFriend'] = [];
    const f = fixture(() =>
      h(ContactNoticeDialog, {
        open: true,
        requests: [incoming, { ...incoming, id: 'out', direction: 'outgoing' }],
        onClose: vi.fn(),
      }),
    );
    const cards = f.host.querySelectorAll('article');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelector('[aria-label="同意申请"]')).not.toBeNull();
    expect(cards[1]!.querySelector('button')).toBeNull();
    expect(f.host.querySelector('details')).toBeNull();
  });
  it('群申请操作嵌入卡片，退群与自己申请无操作，过滤申请仍按卡片展示', () => {
    const user = {
      id: 'u_peer',
      username: 'u_peer',
      identityLabel: 'QQ',
      identityValue: '10002',
      displayName: '申请人',
      avatarUrl: null,
    };
    const incoming: GroupJoinRequest = {
      id: 'in',
      user,
      handleState: 'pending',
      action: '申请加入',
      message: '你好',
      systemRemark: null,
      createdAt: '2026-10-19T01:00:00Z',
      respondedAt: null,
      operator: null,
      group: {
        id: '123',
        conversationId: '123',
        identityLabel: 'Group',
        identityValue: '123',
        name: '群 A',
        avatarUrl: null,
        announcement: null,
        memberCount: 1,
      },
    };
    state.data['requests:group'] = [
      {
        token: 'request-a',
        uid: 'u_peer',
        uin: '10002',
        groupId: '123',
        name: '申请人',
        groupName: '群 A',
        message: '你好',
      },
    ];
    state.data['requests:filteredGroup'] = [
      {
        token: 'filtered-a',
        uid: 'u_filtered',
        uin: '',
        groupId: '123',
        name: '过滤申请人',
        groupName: '群 A',
        message: '你好',
      },
    ];
    const f = fixture(() =>
      h(GroupNoticeDialog, {
        open: true,
        requests: [
          incoming,
          { ...incoming, id: 'quit', action: '退出了群聊' },
          { ...incoming, id: 'self', user: { ...user, id: 'u_self', identityValue: '10001' } },
        ],
        onClose: vi.fn(),
      }),
    );
    const cards = f.host.querySelectorAll('article');
    expect(cards).toHaveLength(4);
    expect(cards[0]!.querySelector('[aria-label="同意申请"]')).not.toBeNull();
    expect(cards[1]!.querySelector('button')).toBeNull();
    expect(cards[2]!.querySelector('button')).toBeNull();
    expect(cards[3]!.textContent).toContain('过滤申请人');
    expect(cards[3]!.querySelector('[aria-label="拒绝申请"]')).not.toBeNull();
  });
  it('收藏按行显示，备注按需编辑，自动更新不覆盖正在输入的草稿', async () => {
    const f = fixture(() => h(FavoriteActions));
    const input = () => f.host.querySelector<HTMLInputElement>('[aria-label="表情备注"]')!;
    expect(input()).toBeNull();
    expect(f.host.querySelector('details')).toBeNull();
    state.data.favorites = [{ emojiId: 'favorite-a', desc: '远端新备注', position: 1 }];
    f.update();
    expect(f.host.textContent).toContain('远端新备注');
    await act(async () => f.button('表情操作').click());
    await act(async () => menuButton('修改表情备注').click());
    expect(input().value).toBe('远端新备注');
    value(f.host, '表情备注', '未保存草稿');
    state.data.favorites = [{ emojiId: 'favorite-a', desc: '另一端备注', position: 1 }];
    f.update();
    expect(input().value).toBe('未保存草稿');
    expect(f.button('刷新')).toBeNull();
  });
  it('收藏备注可明确清空，排序边界不可点击', async () => {
    const f = fixture(() => h(FavoriteActions));
    await act(async () => f.button('表情操作').click());
    expect(menuButton('移到最前').disabled).toBe(true);
    expect(menuButton('上移表情')).toBeUndefined();
    expect(menuButton('下移表情')).toBeUndefined();
    await act(async () => menuButton('修改表情备注').click());
    value(f.host, '表情备注', '');
    await act(async () => f.button('保存表情备注').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'favorite',
      expect.objectContaining({ emojiId: 'favorite-a', action: 'rename', desc: '' }),
    );
  });
  it('收藏添加与退出操作按需展开，取消保留草稿且不写请求', async () => {
    const f = fixture(() => h(FavoriteActions));
    expect(f.button('选择图片')).toBeNull();
    await act(async () => f.button('新建收藏表情').click());
    await act(async () => f.button('选择图片').click());
    state.confirm.mockResolvedValue(false);
    await act(async () => f.button('取消添加表情').click());
    expect(f.host.textContent).toContain('image.png');
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('群分类不再多层折叠，退群只放在群管理菜单', async () => {
    const f = fixture(() => h(GroupActions, { groupId: 123 }));
    expect(f.host.querySelector('[aria-label="群分类标签"]')).not.toBeNull();
    expect(f.button('退出 QQ 群')).toBeNull();
    await act(async () => f.button('群管理菜单').click());
    expect(menuButton('退出 QQ 群')).toBeDefined();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('群分类从真实群资料选择，未返回分类不默认为 0 或允许写入', async () => {
    const f = fixture(() => h(GroupActions, { groupId: 123 }));
    expect(f.host.querySelector('input[aria-label="群分类编号"]')).toBeNull();
    expect(f.host.querySelector<HTMLSelectElement>('[aria-label="群分类"]')!.disabled).toBe(true);
    expect(f.button('添加分类标签').disabled).toBe(true);
    state.data.groupJoinSettings = {
      groupId: 123,
      categoryId: 0,
      categoryName: '服务端分类名称',
    };
    f.update();
    const category = f.host.querySelector<HTMLSelectElement>('[aria-label="群分类"]')!;
    expect(category.value).toBe('0');
    expect(category.options[0]!.textContent).toBe('服务端分类名称');
    captureManagement(f.host, 'group-category');
    value(f.host, '分类标签名称', '合成标签');
    await act(async () => f.button('添加分类标签').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'groupSettings',
      expect.objectContaining({ groupId: 123, category: 0, tag: '合成标签' }),
    );
    state.data.groupJoinSettings = { groupId: 999, categoryId: 2, categoryName: '其他群' };
    f.update();
    expect(f.button('添加分类标签').disabled).toBe(true);
  });
  it('收藏备注未知回执保留编辑草稿，取消也必须确认', async () => {
    const f = fixture(() => h(FavoriteActions));
    await act(async () => f.button('表情操作').click());
    await act(async () => menuButton('修改表情备注').click());
    value(f.host, '表情备注', '未确认的新备注');
    state.mutate.mockResolvedValueOnce({ state: 'unconfirmed' });
    await act(async () => f.button('保存表情备注').click());
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="表情备注"]')!.value).toBe(
      '未确认的新备注',
    );
    state.confirm.mockResolvedValueOnce(false);
    await act(async () => f.button('取消修改表情备注').click());
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="表情备注"]')!.value).toBe(
      '未确认的新备注',
    );
    expect(state.mutate).toHaveBeenCalledTimes(1);
  });
  it('收藏页隐藏时关闭行菜单但保留草稿，同号切源后销毁旧草稿', async () => {
    let active = true;
    const f = fixture(() => h(TabActivity, { active }, h(FavoriteActions)));
    await act(async () => f.button('表情操作').click());
    await act(async () => menuButton('修改表情备注').click());
    value(f.host, '表情备注', '旧来源草稿');
    await act(async () => f.button('表情操作').click());
    active = false;
    f.update();
    expect(f.host.querySelector('[role="menu"]')).toBeNull();
    active = true;
    f.update();
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="表情备注"]')!.value).toBe(
      '旧来源草稿',
    );
    state.configId = 'source-b';
    f.update();
    expect(f.host.querySelector('[aria-label="表情备注"]')).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('加群显示问题，未填回答不能提交，确认后只发一次目标 token', async () => {
    const f = fixture(() => h(GroupJoinAction, { onClose: vi.fn() }));
    value(f.host, 'QQ 群分享链接', 'https://qm.qq.com/q/synthetic');
    await act(async () => f.button('读取加群资料').click());
    expect(f.host.textContent).toContain('为什么加入');
    expect(f.button('提交入群申请').disabled).toBe(true);
    value(f.host, '入群回答', '我想加入讨论');
    await act(async () => f.button('提交入群申请').click());
    expect(state.mutate).toHaveBeenCalledOnce();
    expect(state.mutate).toHaveBeenCalledWith(
      'join',
      expect.objectContaining({
        groupId: 888,
        answer: '我想加入讨论',
        token: '00000000-0000-4000-8000-000000000001',
      }),
    );
  });
  it('加群方式 4 带标准答案，方式 5 不让用户填写被忽略的答案', () => {
    const f = fixture(() => h(GroupActions, { groupId: 123 }));
    value(f.host, '加群方式', '4');
    expect(f.host.querySelector('[aria-label="加群答案"]')).not.toBeNull();
    expect(f.button('保存加群方式').disabled).toBe(true);
    value(f.host, '加群方式', '5');
    expect(f.host.querySelector('[aria-label="加群答案"]')).toBeNull();
  });
  it('加群方式与问题来自读回，55 按审核问答显示，原值仍可保存且答案不伪造', async () => {
    state.data.groupJoinSettings = { groupId: 123, option: 55, question: '原问题' };
    const f = fixture(() => h(GroupActions, { groupId: 123 }));
    expect(f.host.querySelector<HTMLSelectElement>('[aria-label="加群方式"]')!.value).toBe('5');
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="加群问题"]')!.value).toBe('原问题');
    expect(f.host.querySelector('[aria-label="加群答案"]')).toBeNull();
    expect(f.button('保存加群方式').disabled).toBe(false);
    await act(async () => f.button('保存加群方式').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'groupSettings',
      expect.objectContaining({
        action: 'join',
        addType: 5,
        question: '原问题',
        answer: undefined,
      }),
    );
  });
  it('保存加群方式后自动回读并清除草稿，仍允许主动再次提交相同值', async () => {
    const f = fixture(() => h(GroupActions, { groupId: 123 }));
    value(f.host, '加群方式', '1');
    state.mutate.mockImplementationOnce(async () => {
      state.data.groupJoinSettings = { groupId: 123, option: 1, question: null };
      return { state: 'accepted' };
    });
    await act(async () => f.button('保存加群方式').click());
    expect(state.refreshJoin).toHaveBeenCalledOnce();
    expect(f.host.querySelector<HTMLSelectElement>('[aria-label="加群方式"]')!.value).toBe('1');
    expect(f.button('保存加群方式').disabled).toBe(false);
    await act(async () => f.button('保存加群方式').click());
    expect(state.mutate).toHaveBeenCalledTimes(2);
    expect(state.refreshJoin).toHaveBeenCalledTimes(2);
  });
  it('迟到的加群资料不覆盖编辑草稿，未知答案不当作空答案回填', () => {
    state.data.groupJoinSettings = { groupId: 123, option: 4, question: '原问题' };
    const f = fixture(() => h(GroupActions, { groupId: 123 }));
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="加群答案"]')!.value).toBe('');
    expect(f.button('保存加群方式').disabled).toBe(true);
    value(f.host, '加群问题', '正在编辑的问题');
    state.data.groupJoinSettings = { groupId: 123, option: 4, question: '迟到的服务端问题' };
    f.update();
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="加群问题"]')!.value).toBe(
      '正在编辑的问题',
    );
    expect(f.button('保存加群方式').disabled).toBe(true);
  });
});
