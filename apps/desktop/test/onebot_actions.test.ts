// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createActions, type ActionServices, type ActionSession } from '../src/main/onebot/actions';

function setup() {
  let active = true;
  const requireActive = () => {
    if (!active) throw new Error('账号已切换');
  };
  const services = {
    profile: {
      listBuddies: vi.fn().mockResolvedValue([{ uid: 'u_peer', uin: 7n }]),
      profilesByUids: vi.fn().mockResolvedValue([{ uid: 'u_peer', nick: '好友', remark: '备注' }]),
    },
    groupInfo: {
      listGroupDirectory: vi.fn().mockResolvedValue([{ groupCode: '42' }]),
      getGroupDetail: vi
        .fn()
        .mockResolvedValue({ groupName: '群', memberCount: 6, maxMemberCount: 200 }),
      fetchOnlineMembers: vi.fn().mockResolvedValue([{ uin: 8, uid: 'u_other' }]),
      getJoinInfo: vi
        .fn()
        .mockResolvedValue({ name: '在线群名', memberCount: 12, maxMemberCount: 500 }),
    },
    groupModeration: {
      setName: vi.fn(),
      setMemberCard: vi.fn(),
      muteMember: vi.fn(),
      muteAll: vi.fn(),
      setAdmin: vi.fn(),
      kickMember: vi.fn(),
      getAtAllRemain: vi
        .fn()
        .mockResolvedValue({ canAtAll: true, remainCountForGroup: 3, remainCountForUin: 1 }),
    },
    accountConfig: { getRecord: () => ({ qqOnline: true, qqPid: 123 }) },
    accountWrite: {
      friendRemark: vi.fn().mockResolvedValue({ state: 'confirmed' }),
      groupRemark: vi.fn().mockResolvedValue({ state: 'accepted' }),
    },
    interaction: { sendPoke: vi.fn() },
    unreadInfo: {
      markReadAndReport: vi
        .fn()
        .mockResolvedValue({ changed: true, report: { state: 'reported' } }),
    },
    groupFile: {
      list: vi.fn().mockResolvedValue({
        files: [
          {
            fileId: 'f',
            fileName: 'a.txt',
            fileSize: 1,
            busId: 102,
            uploadedTime: 1,
            expireTime: 2,
            modifiedTime: 3,
            downloadedTimes: 4,
            uploaderUin: 7,
            uploaderName: '好友',
          },
        ],
        folders: [],
      }),
      count: vi.fn().mockResolvedValue({ fileCount: 5, maxCount: 100 }),
      space: vi.fn().mockResolvedValue({ usedSpace: 7, totalSpace: 1000 }),
      deleteFile: vi.fn(),
      renameFile: vi.fn(),
      moveFile: vi.fn(),
      createFolder: vi.fn().mockResolvedValue({ folderId: 'new-folder', folderName: '资料' }),
      deleteFolder: vi.fn(),
    },
    mediaUrl: { getGroupFileUrl: vi.fn().mockResolvedValue('https://example.test/file') },
  };
  const session = {
    context: { uin: '99' },
    uidMap: { uidByUin: (uin: bigint) => (uin === 7n ? 'u_peer' : '') },
  };
  const run = createActions(
    services as unknown as ActionServices,
    session as unknown as ActionSession,
    requireActive,
    async () => true,
  );
  return {
    services,
    run,
    deactivate: () => {
      active = false;
    },
  };
}

it('好友名单来自好友表，群名单只包含当前目录', async () => {
  const f = setup();
  expect(await f.run('get_friend_list', {})).toEqual([
    { user_id: 7, nickname: '好友', remark: '备注' },
  ]);
  expect(await f.run('get_group_list', {})).toEqual([
    { group_id: 42, group_name: '群', member_count: 6, max_member_count: 200 },
  ]);
});

it('群资料 no_cache 真正查询在线字段，缺失人数不回退旧缓存', async () => {
  const f = setup();
  expect(await f.run('get_group_info', { group_id: 42, no_cache: 'true' })).toEqual({
    group_id: 42,
    group_name: '在线群名',
    member_count: 12,
    max_member_count: 500,
  });
  expect(f.services.groupInfo.getJoinInfo).toHaveBeenCalledWith(42);
  f.services.groupInfo.getJoinInfo.mockResolvedValueOnce({
    name: '缺字段',
    memberCount: null,
    maxMemberCount: null,
  });
  await expect(f.run('get_group_info', { group_id: 42, no_cache: true })).rejects.toThrow(
    '完整群人数',
  );
});

it('成员名单完整投影，no_cache 强制刷新，不把未建模字段编成默认值', async () => {
  const f = setup();
  const members = Array.from({ length: 501 }, (_, i) => ({
    uin: i + 100,
    uid: `u_${i}`,
    nickname: `成员${i}`,
    card: '',
    permission: i === 0 ? 1 : 0,
    level: 2,
    specialTitle: '',
    joinTime: 10,
    lastSentTime: 20,
    shutUpTime: 0,
  }));
  f.services.groupInfo.fetchOnlineMembers.mockResolvedValue(members);
  expect(await f.run('get_group_member_list', { group_id: 42 })).toHaveLength(501);
  expect(f.services.profile.profilesByUids).toHaveBeenCalledTimes(2);
  expect(
    await f.run('get_group_member_info', { group_id: 42, user_id: 100, no_cache: 'true' }),
  ).toMatchObject({
    role: 'owner',
    join_time: 10,
    title_expire_time: null,
    card_changeable: null,
    unavailable_fields: ['title_expire_time', 'unfriendly', 'card_changeable'],
  });
  expect(f.services.groupInfo.fetchOnlineMembers).toHaveBeenLastCalledWith(42, { force: true });
});

it('好友分页超过默认长度仍完整返回', async () => {
  const f = setup();
  f.services.profile.listBuddies
    .mockResolvedValueOnce(
      Array.from({ length: 500 }, (_, i) => ({ uid: `u_${i}`, uin: BigInt(i + 100) })),
    )
    .mockResolvedValueOnce([{ uid: 'u_last', uin: 900n }]);
  expect(await f.run('get_friend_list', {})).toHaveLength(501);
  expect(f.services.profile.listBuddies).toHaveBeenLastCalledWith(500, 500);
});

it('管理操作保留 false、0 和清空名片的语义', async () => {
  const f = setup();
  await f.run('set_group_whole_ban', { group_id: 42, enable: 'false' });
  await f.run('set_group_admin', { group_id: 42, user_id: 7, enable: 'false' });
  await f.run('set_group_ban', { group_id: 42, user_id: 7, duration: '0' });
  await f.run('set_group_card', { group_id: 42, user_id: 7 });
  await f.run('set_group_kick', { group_id: 42, user_id: 7, reject_add_request: 'false' });
  expect(f.services.groupModeration.muteAll).toHaveBeenCalledWith({ groupId: 42, enable: false });
  expect(f.services.groupModeration.setAdmin).toHaveBeenCalledWith({
    groupId: '42',
    targetUid: 'u_peer',
    enable: false,
  });
  expect(f.services.groupModeration.muteMember).toHaveBeenCalledWith({
    groupId: '42',
    targetUid: 'u_peer',
    duration: 0,
  });
  expect(f.services.groupModeration.setMemberCard).toHaveBeenCalledWith({
    groupId: '42',
    targetUid: 'u_peer',
    card: '',
  });
  expect(f.services.groupModeration.kickMember).toHaveBeenCalledWith({
    groupId: '42',
    targetUid: 'u_peer',
    reject: false,
  });
});

it('在线补 UID 后切号不再发出管理请求', async () => {
  const f = setup();
  f.services.groupInfo.fetchOnlineMembers.mockImplementationOnce(async () => {
    f.deactivate();
    return [{ uin: 8, uid: 'u_other' }];
  });
  await expect(f.run('set_group_ban', { group_id: 42, user_id: 8 })).rejects.toThrow('切换');
  expect(f.services.groupModeration.muteMember).not.toHaveBeenCalled();
});

it('文件列表、空间和下载映射真实字段', async () => {
  const f = setup();
  expect(await f.run('get_group_root_files', { group_id: 42 })).toMatchObject({
    files: [{ file_id: 'f', busid: 102, upload_time: 1, download_times: 4 }],
    folders: [],
  });
  expect(await f.run('get_group_file_system_info', { group_id: 42 })).toEqual({
    file_count: 5,
    limit_count: 100,
    used_space: 7,
    total_space: 1000,
  });
  expect(await f.run('get_group_file_url', { group_id: 42, file_id: 'f' })).toEqual({
    url: 'https://example.test/file',
  });
});

it('文件夹创建返回真实 ID，删除别名共用一条服务路径', async () => {
  const f = setup();
  expect(await f.run('create_group_file_folder', { group_id: 42, name: '资料' })).toMatchObject({
    groupItem: { folderInfo: { folderId: 'new-folder' } },
  });
  for (const action of ['delete_group_folder', 'delete_group_file_folder'])
    await f.run(action, { group_id: 42, folder_id: 'new-folder' });
  expect(f.services.groupFile.deleteFolder).toHaveBeenCalledTimes(2);
  await f.run('rename_group_file', {
    group_id: 42,
    file_id: 'f',
    current_parent_directory: 'folder',
    new_name: 'b.txt',
  });
  expect(f.services.groupFile.renameFile).toHaveBeenCalledWith(42, 'f', 'folder', 'b.txt');
});

it('备注未确认不是成功；已读调用现有完整编排', async () => {
  const f = setup();
  f.services.accountWrite.friendRemark.mockResolvedValueOnce({ state: 'unconfirmed' });
  await expect(f.run('set_friend_remark', { user_id: 7, remark: '' })).rejects.toThrow('未确认');
  await f.run('mark_private_msg_as_read', { user_id: 7 });
  await f.run('mark_group_msg_as_read', { group_id: 42 });
  expect(f.services.unreadInfo.markReadAndReport.mock.calls).toEqual([
    [1, 'u_peer'],
    [2, '42'],
  ]);
});

it('戳一戳别名、额度和能力使用真实服务能力', async () => {
  const f = setup();
  for (const action of ['group_poke', 'send_poke'])
    await f.run(action, { group_id: 42, user_id: 7 });
  await f.run('friend_poke', { user_id: 7 });
  expect(f.services.interaction.sendPoke.mock.calls).toEqual([
    [{ peerType: 'group', targetId: '42', targetUin: '7' }],
    [{ peerType: 'group', targetId: '42', targetUin: '7' }],
    [{ peerType: 'c2c', targetId: '7' }],
  ]);
  expect(await f.run('get_group_at_all_remain', { group_id: 42 })).toMatchObject({
    remain_at_all_count_for_uin: 1,
  });
  expect(await f.run('can_send_record', {})).toEqual({ yes: false });
  await expect(f.run('unsupported', {})).rejects.toMatchObject({ retcode: 1404 });
});
