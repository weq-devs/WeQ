import { act, createElement as h, createRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { GroupJoinAction } from '../src/renderer/src/components/qq-actions/GroupJoinAction';
import { GroupActions } from '../src/renderer/src/components/qq-actions/GroupActions';
import { TypingStatus } from '../src/renderer/src/components/qq-actions/ChatActions';
import { QqInlineKeyboard } from '../src/renderer/src/components/QqInlineKeyboard';
import { useViewState } from '../src/renderer/src/state/view';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';

const state = vi.hoisted(() => ({
  configId: 'source-a',
  available: true,
  mutate: vi.fn(async (_name: string, _input: unknown) => ({ state: 'accepted' as const })),
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
  data: {} as Record<string, unknown>,
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => h('div', { role: 'dialog' }, children),
  useDialog: (selector: (s: { confirm: typeof state.confirm }) => unknown) =>
    selector({ confirm: state.confirm }),
}));
vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ open, children }: { open: boolean; children: ReactNode }) =>
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
    ) => {
      await action({ expectedAccountUin: '10001', expectedAccountConfigId: state.configId });
      await refresh?.();
      return true;
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
  ];
  const reads = [
    'fileSummary',
    'folders',
    'notices',
    'favorites',
    'requests',
    'tags',
    'todoList',
    'groupReadTools',
  ];
  return {
    client: {
      account: {
        pickSendFile: { mutate: state.picker },
        qqActions: {
          ...Object.fromEntries(
            names.map((name) => [name, { mutate: (input: unknown) => state.mutate(name, input) }]),
          ),
          prepareJoin: { mutate: state.prepare },
        },
      },
    },
    trpc: {
      useUtils: () => ({
        account: {
          listBuddyRequests: { invalidate: async () => {} },
          listGroupNotifies: { invalidate: async () => {} },
          qqActions: { requests: { invalidate: async () => {} } },
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
                refetch: async () => ({ error: null, data: state.data[name] }),
              }),
            },
          ]),
        ),
      },
    },
  };
});
const cleanups: Array<() => void> = [];
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
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.configId = 'source-a';
  state.available = true;
  state.mutate.mockClear();
  state.confirm.mockReset().mockResolvedValue(true);
  state.picker.mockClear();
  state.prepare.mockClear();
  state.data = {
    fileSummary: { fileCount: 1, maxCount: 100, usedSpace: 10, totalSpace: 1000 },
    folders: { folders: [{ folderId: 'folder-b', folderName: '目录 B' }] },
    notices: [],
    favorites: [{ emojiId: 'favorite-a', position: 1, desc: '原备注', local: null }],
    requests: [{ token: 'request-a', name: '申请人', groupName: '群 A', message: '留言' }],
    tags: [],
    todoList: [],
  };
  useViewState.setState({ openedUin: '10001' });
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});

describe('QQ 主动操作的实际界面', () => {
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
    expect(f.button('点赞媒体').disabled).toBe(true);
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
  it('删除取消不发请求，确认后保留账号、群和原文件标识', async () => {
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
    value(f.host, '文件操作', 'delete');
    value(f.host, '操作目标', 'file-a');
    state.confirm.mockResolvedValueOnce(false);
    await act(async () => f.button('执行文件操作').click());
    expect(state.mutate).not.toHaveBeenCalled();
    await act(async () => f.button('执行文件操作').click());
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
    value(f.host, '文件操作', 'upload');
    await act(async () => f.button('选择上传文件').click());
    await act(async () => f.button('执行文件操作').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'fileUpload',
      expect.objectContaining({ groupId: 123, directory: 'folder-a', path: '/selected/image.png' }),
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
    value(f.host, '新名称', '旧数据源草稿');
    state.configId = 'source-b';
    f.update();
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="新名称"]')!.value).toBe('');
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('公告界面传递弹窗提醒和群名片引导选项', async () => {
    const f = fixture(() => h(GroupNoticeActions, { groupId: 123 }));
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
  it('收藏备注可明确清空，排序边界不可点击', async () => {
    const f = fixture(() => h(FavoriteActions));
    value(f.host, '表情备注', '');
    expect(f.button('上移表情').disabled).toBe(true);
    expect(f.button('下移表情').disabled).toBe(true);
    await act(async () => f.button('保存表情备注').click());
    expect(state.mutate).toHaveBeenCalledWith(
      'favorite',
      expect.objectContaining({ emojiId: 'favorite-a', action: 'rename', desc: '' }),
    );
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
});
