import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  useGroupMemberUnmute,
  canModerateMember,
} from '../src/renderer/src/hooks/useGroupMemberUnmute';
import { useGroupMemberTimeNavigation } from '../src/renderer/src/hooks/useGroupMemberTimeNavigation';
import { RelationshipDirectoryContext } from '../src/renderer/src/lib/contactRelationship';
import type { ProfilePerson } from '../src/renderer/src/hooks/useContactCard';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source' };
const rpc = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  mute: vi.fn(async () => ({ state: 'accepted' })),
  refetch: vi.fn(async () => ({ data: { uid: 'u_peer', muteUntil: 0 }, error: null })),
  boundary: vi.fn(),
  browse: vi.fn(),
  toast: vi.fn(),
  until: 2000000000,
  available: true,
  run: vi.fn(),
  details: vi.fn(),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source' },
    available: rpc.available,
    busy: false,
    run: rpc.run,
  }),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: { getState: () => ({ confirm: rpc.confirm }) },
}));
vi.mock('../src/renderer/src/components/Toast', () => ({
  useToast: { getState: () => ({ push: rpc.toast }) },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      conversationBoundary: { query: rpc.boundary },
      browseConversation: { query: rpc.browse },
    },
  },
  trpc: {
    account: {
      qqWrite: {
        memberDetails: {
          useQuery: (input: unknown, options: unknown) => {
            rpc.details(input, options);
            return { data: { uid: 'u_peer', muteUntil: rpc.until }, refetch: rpc.refetch };
          },
        },
        groupMemberMute: { useMutation: () => ({ mutateAsync: rpc.mute }) },
      },
    },
  },
}));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  rpc.until = 2000000000;
  rpc.available = true;
  rpc.confirm.mockResolvedValue(true);
  rpc.run.mockImplementation(async (write, _refresh, options) => {
    await write(binding);
    await options.readback();
    return true;
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderUnmute(role: 'owner' | 'member' = 'owner', targetRole: 'member' | null = 'member') {
  let action: ReturnType<typeof useGroupMemberUnmute>;
  function Harness() {
    action = useGroupMemberUnmute({
      groupCode: '123',
      uid: 'u_peer',
      name: '合成成员',
      role: targetRole ?? undefined,
    });
    return null;
  }
  act(() =>
    root.render(
      h(
        RelationshipDirectoryContext.Provider,
        {
          value: {
            selfUid: 'u_self',
            groups: new Map([['123', { listed: true, role }]]),
            friends: new Map(),
            friendsComplete: true,
          },
        },
        h(Harness),
      ),
    ),
  );
  return action!;
}

it('普通成员和离线账号也自动读本地禁言资料，但不能解除禁言', () => {
  rpc.available = false;
  const action = renderUnmute('member');
  expect(rpc.details).toHaveBeenLastCalledWith(
    { ...binding, groupId: 123, uid: 'u_peer' },
    expect.objectContaining({ enabled: true }),
  );
  expect(action.muted).toBe(true);
  expect(action.available).toBe(false);
});

it('未加载的成员补全角色后，群主也能直接解除其禁言', () => {
  expect(renderUnmute('owner', null).available).toBe(true);
});

it('解除前确认，发送零时长，读回同一成员', async () => {
  const action = renderUnmute();
  expect(action.available).toBe(true);
  await action.unmute(document);
  expect(rpc.confirm).toHaveBeenCalledWith(
    '解除禁言',
    expect.stringContaining('合成成员'),
    expect.objectContaining({ ownerDocument: document }),
  );
  expect(rpc.mute).toHaveBeenCalledWith({
    ...binding,
    groupId: 123,
    targetUid: 'u_peer',
    duration: 0,
  });
  expect(rpc.refetch).toHaveBeenCalledOnce();
});
it('取消确认不提交，过期或离线不提供操作', async () => {
  rpc.confirm.mockResolvedValue(false);
  await renderUnmute().unmute();
  expect(rpc.mute).not.toHaveBeenCalled();
  rpc.until = 1;
  expect(renderUnmute().available).toBe(false);
  rpc.until = 2000000000;
  rpc.available = false;
  expect(renderUnmute().available).toBe(false);
});
it.each([
  ['owner', 'admin', false, true],
  ['admin', 'member', false, true],
  ['admin', 'admin', false, false],
  ['member', 'member', false, false],
  ['owner', 'member', true, false],
  ['owner', undefined, false, false],
] as const)('管理权限 %s / %s / self=%s', (role, target, self, result) => {
  expect(canModerateMember(role, target, self)).toBe(result);
});

const person = {
  id: 'u_peer',
  uid: 'u_peer',
  displayName: '成员',
  profileContext: {
    groupCode: '123',
    groupName: '合成群',
    member: { joinedAt: '2024-09-01T00:00:00+08:00', lastSpeakAt: '2024-09-02T03:04:05+08:00' },
  },
} as ProfilePerson;
function renderLocate(value = person) {
  const navigate = vi.fn();
  const close = vi.fn();
  let locate: ReturnType<typeof useGroupMemberTimeNavigation>;
  function Harness() {
    locate = useGroupMemberTimeNavigation(value, navigate, close);
    return null;
  }
  act(() => root.render(h(Harness)));
  return { locate: locate!, navigate, close };
}
it('入群时间读取该时间之后的边界，定位并关闭名片', async () => {
  rpc.boundary.mockResolvedValue({ msgId: '9', msgSeq: '8', sendTime: 1725120000 });
  const f = renderLocate();
  await f.locate('joinedAt');
  expect(rpc.boundary).toHaveBeenCalledWith({
    ...binding,
    kind: 'group',
    conv: '123',
    start: 1725120000,
  });
  expect(f.navigate).toHaveBeenCalledWith(expect.objectContaining({ conv: '123' }), {
    id: '9',
    seq: '8',
    time: 1725120000,
  });
  expect(f.close).toHaveBeenCalledOnce();
});
it('最后发言只定位同一成员同一秒的消息；缺记录不误跳', async () => {
  rpc.browse.mockResolvedValue({ items: [] });
  const f = renderLocate();
  await f.locate('lastSpeakAt');
  const time = Date.parse(person.profileContext!.member.lastSpeakAt!) / 1000;
  expect(rpc.browse).toHaveBeenCalledWith({
    ...binding,
    kind: 'group',
    conv: '123',
    filter: { start: time, end: time, sender: 'u_peer' },
    limit: 1,
  });
  expect(f.navigate).not.toHaveBeenCalled();
  expect(f.close).not.toHaveBeenCalled();
  expect(rpc.toast).toHaveBeenCalled();
  rpc.browse.mockResolvedValue({ items: [{ msgId: '10', msgSeq: '11', sendTime: String(time) }] });
  await f.locate('lastSpeakAt');
  expect(f.navigate).toHaveBeenCalledWith(expect.objectContaining({ conv: '123' }), {
    id: '10',
    seq: '11',
    time,
  });
});
it('切换成员后忽略迟到的定位结果', async () => {
  let resolve!: (value: unknown) => void;
  rpc.boundary.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const f = renderLocate();
  const pending = f.locate('joinedAt');
  renderLocate({ ...person, uid: 'u_other' });
  resolve({ msgId: '9', msgSeq: '8', sendTime: 1725120000 });
  await pending;
  expect(f.navigate).not.toHaveBeenCalled();
});
