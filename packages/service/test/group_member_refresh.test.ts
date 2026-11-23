import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import { FetchGroupMemberListPage } from '@weqbot/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupInfoService } from '../src/account/group_info';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const member = {
  uin: 7,
  uid: 'u_old',
  nickname: '原成员',
  card: '',
  permission: 0,
  level: 1,
  specialTitle: '',
  joinTime: 1,
  lastSentTime: 1,
  shutUpTime: 0,
};
const replacement = { ...member, uin: 8, uid: 'u_new', nickname: '新成员' };
function local(row: typeof member) {
  return {
    uid: row.uid,
    uin: String(row.uin),
    nick: row.nickname,
    card: row.card,
    memberLevel: row.level,
  };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'weq-member-roster-'));
  roots.push(root);
  const profilesByUids = vi.fn(async (_uids: string[]) => []);
  const session = {
    context: { uin: '42' },
    groupDetail: {
      listAll: async () => [
        { groupCode: 1n, groupName: '群一', memberCount: 1 },
        { groupCode: 2n, groupName: '群二', memberCount: 2 },
      ],
    },
    groupMembers: {
      listMemberBriefsInGroup: async (code: bigint) =>
        code === 1n ? [local(member)] : [local(member), local(replacement)],
    },
    profileInfo: { profilesByUids },
  } as unknown as AccountSession;
  const service = new GroupInfoService(session, {
    nt: { sendOidbPacket: vi.fn() },
    resolvePid: () => 1,
  });
  service.setMemberRosterCache(root);
  return { root, service, session, profilesByUids };
}

it('人数相同但换人时强制更新，图谱使用完整新名单，重开后仍可使用且不更新其他联系人指标', async () => {
  const { root, service, session } = await setup();
  const invoke = vi
    .spyOn(FetchGroupMemberListPage, 'invoke')
    .mockResolvedValueOnce({ members: [member], token: '' })
    .mockResolvedValue({ members: [replacement], token: '' });
  const observed = vi.fn();
  service.contactMembersObserved = observed;
  await service.fetchOnlineMembers(1);
  expect((await service.getRelationGraph()).nodes.map((node) => node.uid)).toEqual(['u_old']);
  observed.mockClear();
  expect(await service.refreshGroupMembers('1')).toBe(1);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(observed).not.toHaveBeenCalled();
  expect((await service.getRelationGraph()).nodes.map((node) => node.uid)).toEqual(['u_new']);
  const reopened = new GroupInfoService(session);
  reopened.setMemberRosterCache(root);
  expect((await reopened.getRelationGraph()).nodes.map((node) => node.uid)).toEqual(['u_new']);
});

it('翻页中断或身份不完整时保留上次完整名单，不发布半份结果', async () => {
  const { service } = await setup();
  const invoke = vi
    .spyOn(FetchGroupMemberListPage, 'invoke')
    .mockResolvedValue({ members: [replacement], token: '' });
  await service.refreshGroupMembers('1');
  invoke.mockResolvedValue({ members: [member], token: 'loop' });
  await expect(service.refreshGroupMembers('1')).rejects.toThrow('截断');
  invoke.mockResolvedValue({ members: [{ ...member, uid: '' }], token: '' });
  await expect(service.refreshGroupMembers('1')).rejects.toThrow('保留旧名单');
  expect((await service.getRelationGraph({ force: true })).nodes.map((node) => node.uid)).toEqual([
    'u_new',
  ]);
});

it('成功获取空名单后不回退旧本地成员', async () => {
  const { root, service, session } = await setup();
  vi.spyOn(FetchGroupMemberListPage, 'invoke').mockResolvedValue({ members: [], token: '' });
  await service.refreshGroupMembers('1');
  const reopened = new GroupInfoService(session);
  reopened.setMemberRosterCache(root);
  expect((await reopened.getRelationGraph()).nodes).toEqual([]);
});

it('管理员变更后用新名单同步列表、搜索和名片，保留本地群昵称与退群记录', async () => {
  const cached = {
    groupCode: 1n,
    uid: member.uid,
    uin: BigInt(member.uin),
    card: '本地群昵称',
    adminFlag: 0,
    memberFlag: 0,
  };
  const departed = {
    ...cached,
    uid: replacement.uid,
    uin: BigInt(replacement.uin),
    memberFlag: 1,
  };
  const session = {
    selfUid: member.uid,
    context: { uin: String(member.uin) },
    groupDetail: { listDirectory: async () => [{ groupCode: '1', role: 'member' }] },
    groupMembers: {
      listMembersInGroup: async () => [cached],
      getMember: async () => cached,
      getMembersByUids: async () => [cached, departed],
      searchMembersInGroup: async () => ({ items: [cached], total: 1 }),
    },
  } as unknown as AccountSession;
  const service = new GroupInfoService(session, {
    nt: { sendOidbPacket: vi.fn() },
    resolvePid: () => 1,
  });
  const changed = vi.fn();
  service.onMemberRolesChanged = changed;
  const page = vi
    .spyOn(FetchGroupMemberListPage, 'invoke')
    .mockResolvedValue({ members: [member], token: '' });
  await service.syncMemberRoles(1);
  expect((await service.getMemberInfo(1n, member.uid))?.adminFlag).toBe(0);
  await service.syncMemberRoles(1);
  expect(page).toHaveBeenCalledTimes(1);

  page.mockResolvedValue({
    members: [
      { ...member, permission: 2 },
      { ...replacement, permission: 2 },
    ],
    token: '',
  });
  await service.syncMemberRoles(1, true);
  const admin = { ...cached, adminFlag: 1 };
  expect(await service.listMembersInGroup(1n)).toEqual([admin]);
  expect(await service.getMemberInfo(1n, member.uid)).toEqual(admin);
  expect(await service.getMembersByUids(1n, [member.uid, replacement.uid])).toEqual([
    admin,
    departed,
  ]);
  expect(await service.searchMembersInGroup(1n, '本地群昵称')).toEqual({
    items: [admin],
    total: 1,
  });
  expect(await service.listGroupDirectory()).toEqual([{ groupCode: '1', role: 'admin' }]);

  // 撤销时本地 QQ 可能还保留已同步到库里的管理员标记。
  cached.adminFlag = 1;
  page.mockResolvedValue({ members: [member], token: '' });
  await service.syncMemberRoles(1, true);
  expect((await service.getMemberInfo(1n, member.uid))?.adminFlag).toBe(0);
  expect(changed.mock.calls).toEqual([[1], [1], [1]]);
});

it('设撤管理员后的回读不复用操作前在途的名单', async () => {
  const { service } = await setup();
  let release!: () => void;
  const page = vi
    .spyOn(FetchGroupMemberListPage, 'invoke')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ members: [member], token: '' });
        }),
    )
    .mockResolvedValue({ members: [{ ...member, permission: 2 }], token: '' });
  const initial = service.syncMemberRoles(1);
  const readback = service.syncMemberRoles(1, true);
  expect(page).toHaveBeenCalledTimes(1);
  release();
  await initial;
  expect(await readback).toEqual([{ ...member, permission: 2 }]);
  expect(page).toHaveBeenCalledTimes(2);
});

it('已更新名单但尚无群资料的群仍参与重算，重开后也不丢失', async () => {
  const { root, service, session } = await setup();
  vi.spyOn(FetchGroupMemberListPage, 'invoke').mockResolvedValue({
    members: [replacement],
    token: '',
  });
  await service.refreshGroupMembers('3');
  const reopened = new GroupInfoService(session);
  reopened.setMemberRosterCache(root);
  const graph = await reopened.getRelationGraph();
  expect(graph.groups.find((group) => group.code === '3')).toMatchObject({ memberCount: 1 });
  expect(graph.nodes.find((node) => node.uid === 'u_new')?.groupCodes).toEqual(['2', '3']);
});

it('名单更新与图谱构建重叠时，不把旧构建结果重新写回缓存', async () => {
  const { service, profilesByUids } = await setup();
  let release!: () => void;
  profilesByUids.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
  );
  const building = service.getRelationGraph();
  await vi.waitFor(() => expect(release).toBeDefined());
  vi.spyOn(FetchGroupMemberListPage, 'invoke').mockResolvedValue({
    members: [replacement],
    token: '',
  });
  await service.refreshGroupMembers('1');
  release();
  expect((await building).nodes.map((node) => node.uid)).toEqual(['u_new']);
  expect((await service.getRelationGraph()).nodes.map((node) => node.uid)).toEqual(['u_new']);
});
