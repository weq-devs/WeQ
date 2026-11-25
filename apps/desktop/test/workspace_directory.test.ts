import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useWorkspaceDirectory } from '../src/renderer/src/views/workspace/useWorkspaceDirectory';
import * as projection from '../src/renderer/src/views/workspace/identity';
import type { RecentContactWire, GroupDetailWire } from '../src/renderer/src/views/workspace/types';

type Input = Parameters<typeof useWorkspaceDirectory>[0];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function recent(targetUid: string): RecentContactWire {
  return {
    targetUid,
    chatType: 2,
    msgSeq: '1',
    senderUid: 'u_peer',
    targetUin: '0',
    sendTime: '1700000000',
    topTime: '0',
    pinned: false,
    preview: null,
    senderDisplayName: '',
    senderNick: '',
    targetDisplayName: targetUid,
    senderRemark: '',
    targetAvatar: '',
    targetRemark: '',
    targetGroupNick: '',
    notifyLevel: 1,
    tempSourceGroupCode: '0',
  };
}
function group(groupCode: string): GroupDetailWire {
  return {
    groupCode,
    groupName: `群${groupCode}`,
    pinnedAnnounce: '',
    description: '',
    remark: '',
    ownerUid: '',
    createTime: 0,
    maxMemberCount: 100,
    memberCount: 2,
    labels: '',
    entranceQ: '',
    customLabels: [],
    directory: { role: 'member', pinned: false, notifyLevel: 1, unnamed: false, memberCount: 2 },
  };
}
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let input: Input = {
    user: projection.currentUser('90001'),
    profileByUid: new Map(),
    previewDisplayNames: new Map(),
    previewGroupNames: new Map(),
    recentContactsData: [recent('10001'), recent('10002')],
    categories: { data: [] },
    botUidList: { data: [] },
    buddies: { data: [] },
    allGroups: { data: [group('10001'), group('10002')] },
    topContacts: { data: [] },
    hiddenSessions: { data: [] },
    deletedSessions: { data: [] },
    officialAccounts: { data: [] },
    serviceAccounts: { data: [] },
    guildDirectSessions: { data: [] },
    buddyRequests: { data: [] },
    groupNotifies: { data: [] },
    onlineStatusByUid: {},
    specialCare: { isError: false, refetch: vi.fn() },
    specialCareUnavailable: null,
    groupAssistantEntry: undefined,
    groupAssistantIds: new Set(),
    groupNotifyLevels: new Map(),
    temporaryConversations: {},
    outgoingConversationPreviews: new Map(),
    unreadByConv: {},
    highlightsByConv: {},
    draftTimesByConv: {},
  };
  let current!: ReturnType<typeof useWorkspaceDirectory>;
  function Probe() {
    current = useWorkspaceDirectory(input);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  cleanups.push(async () => act(async () => root.unmount()));
  const render = async (next: Partial<Input> = {}) => {
    input = { ...input, ...next };
    await act(async () => root.render(createElement(Probe)));
  };
  await render();
  return {
    render,
    get input() {
      return input;
    },
    get current() {
      return current;
    },
  };
}

it('无关页面重绘及等值查询包装不重做目录投影，输出保持引用', async () => {
  const c = await fixture();
  const contacts = vi.spyOn(projection, 'contactToConversation');
  const groups = vi.spyOn(projection, 'groupDetailToConversation');
  const before = c.current;
  await c.render({
    allGroups: { data: c.input.allGroups.data },
    buddies: { data: c.input.buddies.data },
  });
  expect(c.current.conversations).toBe(before.conversations);
  expect(c.current.profileContacts).toBe(before.profileContacts);
  expect(c.current.hiddenConversationsById).toBe(before.hiddenConversationsById);
  expect(contacts).not.toHaveBeenCalled();
  expect(groups).not.toHaveBeenCalled();
});

it('未读变动只更新对应目录行，不重新转换预览或未变群资料', async () => {
  const c = await fixture();
  const contacts = vi.spyOn(projection, 'contactToConversation');
  const groups = vi.spyOn(projection, 'groupDetailToConversation');
  const other = c.current.conversations.find((row) => row.id === '10002');
  await c.render({ unreadByConv: { '10001': 3 } });
  expect(c.current.conversations.find((row) => row.id === '10001')?.unreadCount).toBe(3);
  expect(c.current.conversations.find((row) => row.id === '10002')).toBe(other);
  expect(contacts).not.toHaveBeenCalled();
  expect(groups).toHaveBeenCalledOnce();
  expect(groups.mock.calls[0][0].groupCode).toBe('10001');
});

it('通知目录变化不重算聊天目录，真实群资料变化仍更新', async () => {
  const c = await fixture();
  const before = c.current.conversations;
  await c.render({
    buddyRequests: {
      data: [
        {
          timestamp: 1700000000,
          peerUid: 'u_new',
          nick: '新朋友',
          verifyMsg: '',
          source: '',
          status: 0,
          sourceGroupCode: '',
          initiator: 0,
          isAccepted: 0,
        },
      ],
    },
  });
  expect(c.current.conversations).toBe(before);
  expect(c.current.contactRequests).toHaveLength(1);
  await c.render({
    allGroups: { data: [{ ...group('10001'), groupName: '新群名' }, group('10002')] },
  });
  const changed = c.current.conversations.find((row) => row.id === '10001');
  expect(changed?.type === 'group' && changed.group.name).toBe('新群名');
});

it('隐藏和已删除会话保留独立可解析目录，主列表只保留聚合入口', async () => {
  const c = await fixture();
  await c.render({
    hiddenSessions: { data: [{ ...recent('10001'), storageKey: 'hidden', resolvable: true }] },
    deletedSessions: {
      data: [
        {
          sessionKey: 'deleted',
          targetUid: 'u_deleted',
          chatType: 1,
          resolvable: true,
          sendTime: '1700000000',
          senderUid: 'u_deleted',
          preview: null,
          deleteTime: '1700000001',
        },
      ],
    },
  });
  expect(c.current.conversations.some((row) => row.id === '10001')).toBe(false);
  expect(c.current.conversations.map((row) => row.id)).toEqual(
    expect.arrayContaining(['merged:hidden', 'merged:deleted']),
  );
  expect(c.current.hiddenConversationsById.get('10001')?.hidden).toBe(true);
  expect(c.current.deletedConversationsById.get('u_deleted')?.deleted).toBe(true);
});
