import { describe, expect, it, vi } from 'vitest';
import type { GroupMember, GroupDetail, UserProfile } from '@weq/db';
import {
  createQQWriteRouter,
  type QQWriteServices,
  type QQWriteBinding,
} from '../src/main/ipc/routers/qq_write';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
const self: UserProfile = {
  uid: 'u_self',
  uin: 10001n,
  qid: '',
  nick: '测试账号',
  avatarUrl: '',
  birthYear: 0,
  birthMonth: 0,
  birthDay: 0,
  remark: '',
  signature: '原签名',
  intimacy: 0,
  age: 0,
  sigUpdateTime: 0,
  isFriend: false,
  gender: 0,
  isBot: false,
};
const accepted = async () => ({ state: 'accepted' as const });
const groupDetail: GroupDetail = {
  groupCode: 123n,
  groupName: '合成群',
  ownerUid: 'u_owner',
  pinnedAnnounce: '',
  description: '',
  remark: '',
  createTime: 0,
  maxMemberCount: 100,
  memberCount: 3,
  labels: '',
  entranceQ: '',
  leaveFlag: 0,
  customLabels: [],
};
const groupMember: GroupMember = {
  groupCode: 123n,
  uid: 'u_peer',
  uin: 10002n,
  card: '合成名片',
  nick: '合成昵称',
  joinTime: 0,
  lastSpeakTime: 0,
  muteUntil: 0,
  adminFlag: 0,
  memberFlag: 0,
  customTitle: '合成头衔',
  memberLevel: 0,
};

function fixture() {
  let current = true;
  const services: QQWriteServices = {
    accountWrite: {
      friendRemark: vi.fn(accepted),
      groupRemark: vi.fn(accepted),
      pin: vi.fn(accepted),
      friendDisturb: vi.fn(accepted),
      groupMessagePolicy: vi.fn(accepted),
      friendCategory: vi.fn(accepted),
      selfProfile: vi.fn(accepted),
      onlineStatus: vi.fn(accepted),
      selfAvatar: vi.fn(accepted),
      groupAvatar: vi.fn(accepted),
      selfIdentity: () => ({ uin: '10001', uid: 'u_self' }),
    },
    groupModeration: {
      setName: vi.fn(async () => {}),
      setMemberCard: vi.fn(async () => {}),
      setSpecialTitle: vi.fn(async () => {}),
      setEssence: vi.fn(async () => {}),
    },
    profile: {
      getProfile: vi.fn(async () => null),
      getBuddy: vi.fn(async () => null),
      getSelfProfile: vi.fn(async () => self),
      profilesByUids: vi.fn(async (uids: string[]) => (uids.includes(self.uid) ? [self] : [])),
    },
    groupInfo: {
      getGroupDetail: vi.fn(async () => null),
      listGroupDirectory: vi.fn(async () => []),
      getMemberInfo: vi.fn(async () => null),
      getMessagePolicy: vi.fn(async (groupId: number) => ({
        groupId,
        policy: 1 as const,
        rawPolicy: 1,
      })),
    },
    recentContacts: {
      getTopContacts: vi.fn(async () => []),
      getByTargetUids: vi.fn(async () => []),
    },
    onlineStatus: {
      getOnlineStatus: vi.fn(async () => null),
      editableStatuses: () => [{ value: 10, label: '在线' }],
    },
  };
  function read(input: QQWriteBinding) {
    if (
      !current ||
      input.expectedAccountUin !== binding.expectedAccountUin ||
      input.expectedAccountConfigId !== binding.expectedAccountConfigId
    )
      throw new Error('账号或数据源已切换');
    return services;
  }
  const write = vi.fn((input: QQWriteBinding) => read(input));
  const caller = createQQWriteRouter(write, read).createCaller({});
  return {
    caller,
    services,
    write,
    switchAccount: () => {
      current = false;
    },
  };
}

describe('QQ 写 IPC 边界', () => {
  it.each([
    ['u_owner', 0, 'owner'],
    ['u_peer', 1, 'admin'],
    ['u_peer', 0, 'member'],
  ] as const)(
    '成员快照区分当前账号角色与目标角色：%s／%s',
    async (targetUid, adminFlag, targetRole) => {
      const f = fixture();
      f.services.groupInfo.getGroupDetail = vi.fn(async () => groupDetail);
      f.services.groupInfo.listGroupDirectory = vi.fn(async () => [
        {
          groupCode: '123',
          role: 'admin',
          pinned: false,
          notifyLevel: 1,
          unnamed: false,
          memberCount: 3,
        },
      ]);
      f.services.groupInfo.getMemberInfo = vi.fn(async () => ({
        ...groupMember,
        uid: targetUid,
        adminFlag,
      }));
      expect(
        await f.caller.memberState({ ...binding, groupId: 123, uid: targetUid }),
      ).toMatchObject({ uid: targetUid, role: 'admin', targetRole });
      expect(f.services.groupInfo.getGroupDetail).toHaveBeenCalledTimes(1);
      expect(f.write).not.toHaveBeenCalled();
    },
  );
  it('群主身份未读到时不把目标普通标记猜成非群主，错目标回包直接拒绝', async () => {
    const f = fixture();
    f.services.groupInfo.getMemberInfo = vi.fn(async () => groupMember);
    expect(await f.caller.memberState({ ...binding, groupId: 123, uid: 'u_peer' })).toMatchObject({
      targetRole: null,
    });
    await expect(
      f.caller.memberState({ ...binding, groupId: 123, uid: 'u_other' }),
    ).rejects.toThrow('目标不一致');
  });
  it('成员角色读取期间切源或读到其他群的记录时不返回权限', async () => {
    const f = fixture();
    f.services.groupInfo.getMemberInfo = vi.fn(async () => ({ ...groupMember, groupCode: 456n }));
    await expect(f.caller.memberState({ ...binding, groupId: 123, uid: 'u_peer' })).rejects.toThrow(
      '目标不一致',
    );
    f.services.groupInfo.getMemberInfo = vi.fn(async () => groupMember);
    f.services.groupInfo.getGroupDetail = vi.fn(async () => ({ ...groupDetail, groupCode: 456n }));
    await expect(f.caller.memberState({ ...binding, groupId: 123, uid: 'u_peer' })).rejects.toThrow(
      '目标不一致',
    );
    f.services.groupInfo.getGroupDetail = vi.fn(async () => {
      f.switchAccount();
      return groupDetail;
    });
    await expect(f.caller.memberState({ ...binding, groupId: 123, uid: 'u_peer' })).rejects.toThrow(
      '切换',
    );
  });
  it('资料详情保持读取来源与目标，不返回未请求 UID，切号后丢弃', async () => {
    const f = fixture();
    const profiles = await f.caller.profileDetails({ ...binding, uids: [self.uid] });
    expect(profiles[0].uin).toBe(self.uin.toString());
    f.services.profile.profilesByUids = async () => [self];
    await expect(f.caller.profileDetails({ ...binding, uids: ['u_other'] })).rejects.toThrow(
      '目标不一致',
    );
    f.services.profile.profilesByUids = async () => {
      f.switchAccount();
      return [self];
    };
    await expect(f.caller.profileDetails({ ...binding, uids: [self.uid] })).rejects.toThrow('切换');
  });
  it('成员详情读取期间切号，不能回填到新来源', async () => {
    const f = fixture();
    await expect(
      f.caller.memberDetails({ ...binding, groupId: 123, uid: 'u_peer' }),
    ).resolves.toBeNull();
    f.services.groupInfo.getMemberInfo = async () => {
      f.switchAccount();
      return null;
    };
    await expect(
      f.caller.memberDetails({ ...binding, groupId: 123, uid: 'u_peer' }),
    ).rejects.toThrow('切换');
  });
  it('群消息策略单独读取服务端，保留来源并拒绝切号后的回包', async () => {
    const f = fixture();
    await expect(f.caller.groupPolicyState({ ...binding, groupId: 123 })).resolves.toEqual({
      groupId: 123,
      policy: 1,
      rawPolicy: 1,
      source: 'qq-server',
    });
    f.services.groupInfo.getMessagePolicy = async (groupId) => {
      f.switchAccount();
      return { groupId, policy: 3, rawPolicy: 3 };
    };
    await expect(f.caller.groupPolicyState({ ...binding, groupId: 123 })).rejects.toThrow('切换');
  });
  it.each(['admin', 'member', null] as const)('非群主 %s 不能写专属头衔', async (role) => {
    const f = fixture();
    f.services.groupInfo.listGroupDirectory = vi.fn(async () => [
      { groupCode: '123', role, pinned: false, notifyLevel: 1, unnamed: false, memberCount: 2 },
    ]);
    await expect(
      f.caller.groupSpecialTitle({ ...binding, groupId: 123, targetUid: 'u_peer', title: '测试' }),
    ).rejects.toThrow(/群主/);
    expect(f.services.groupModeration.setSpecialTitle).not.toHaveBeenCalled();
  });
  it('群主可以写入头衔，权限读取期间切号时不再写入', async () => {
    const f = fixture();
    f.services.groupInfo.listGroupDirectory = vi.fn(async () => [
      {
        groupCode: '123',
        role: 'owner',
        pinned: false,
        notifyLevel: 1,
        unnamed: false,
        memberCount: 2,
      },
    ]);
    const input = { ...binding, groupId: 123, targetUid: 'u_peer', title: '测试' };
    await expect(f.caller.groupSpecialTitle(input)).resolves.toEqual({ state: 'accepted' });
    expect(f.services.groupModeration.setSpecialTitle).toHaveBeenCalledWith(input);
    f.services.groupInfo.listGroupDirectory = async () => {
      f.switchAccount();
      return [
        {
          groupCode: '123',
          role: 'owner',
          pinned: false,
          notifyLevel: 1,
          unnamed: false,
          memberCount: 2,
        },
      ];
    };
    await expect(f.caller.groupSpecialTitle(input)).rejects.toThrow(/切换/);
    expect(f.services.groupModeration.setSpecialTitle).toHaveBeenCalledTimes(1);
  });
  it('只读快照不要求在线写入口，也不返回数据库密钥', async () => {
    const f = fixture();
    const own = await f.caller.selfState(binding);
    expect(own.profile).toEqual({
      uid: self.uid,
      uin: self.uin.toString(),
      nick: self.nick,
      signature: self.signature,
      gender: self.gender,
    });
    expect(own).not.toHaveProperty('dbKey');
    const peer = await f.caller.peerState({ ...binding, target: { kind: 'group', groupId: 123 } });
    expect(peer.source).toBe('qq-local-cache');
    expect(peer.notifyLevel).toBeNull();
    expect(peer.role).toBeNull();
    expect(f.write).not.toHaveBeenCalled();
  });

  it('写操作必须包含并通过账号及数据源绑定', async () => {
    const f = fixture();
    await expect(
      f.caller.friendRemark({
        ...binding,
        expectedAccountUin: '10002',
        uid: 'u_friend',
        remark: 'A',
      }),
    ).rejects.toThrow(/切换/);
    await expect(
      f.caller.pin({
        ...binding,
        expectedAccountConfigId: 'source-b',
        target: { kind: 'group', groupId: 123 },
        enabled: true,
      }),
    ).rejects.toThrow(/切换/);
    expect(f.services.accountWrite.friendRemark).not.toHaveBeenCalled();
    expect(f.services.accountWrite.pin).not.toHaveBeenCalled();
  });

  it('只允许声明的资料 patch，不能借接口写其他账号和未编辑字段', async () => {
    const f = fixture();
    await f.caller.selfProfile({ ...binding, patch: { signature: '' } });
    expect(f.services.accountWrite.selfProfile).toHaveBeenCalledWith({ signature: '' });
    await expect(
      f.caller.selfProfile({ ...binding, patch: JSON.parse('{"uin":"10002","nickname":"A"}') }),
    ).rejects.toThrow();
    expect(f.services.accountWrite.selfProfile).toHaveBeenCalledTimes(1);
  });

  it('错误群号、策略和缺失的精华定位在调用服务前拒绝', async () => {
    const f = fixture();
    await expect(
      f.caller.groupMessagePolicy(
        JSON.parse(JSON.stringify({ ...binding, groupId: 123, policy: 8 })),
      ),
    ).rejects.toThrow();
    await expect(
      f.caller.groupEssence(
        JSON.parse(JSON.stringify({ ...binding, groupId: 123, sequence: 1, enable: true })),
      ),
    ).rejects.toThrow();
    await expect(f.caller.groupName({ ...binding, groupId: 2 ** 32, name: 'A' })).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
  });

  it('读取期间切号时拒绝旧资料回包', async () => {
    const f = fixture();
    f.services.profile.getSelfProfile = async () => {
      f.switchAccount();
      return self;
    };
    await expect(f.caller.selfState(binding)).rejects.toThrow(/切换/);
  });
  it('状态缓存解析失败不阻断资料读取，明确返回独立错误', async () => {
    const f = fixture();
    f.services.onlineStatus.getOnlineStatus = async () => {
      throw new Error('premature EOF');
    };
    const state = await f.caller.selfState(binding);
    expect(state.profile?.signature).toBe(self.signature);
    expect(state.status).toBeNull();
    expect(state.statusError).toBe('premature EOF');
  });

  it('群昵称目标使用账号会话 UID，不依赖个人资料缓存已填充', async () => {
    const f = fixture();
    f.services.profile.getSelfProfile = async () => null;
    const state = await f.caller.peerState({ ...binding, target: { kind: 'group', groupId: 123 } });
    expect(state.selfUid).toBe('u_self');
    expect(f.services.groupInfo.getMemberInfo).toHaveBeenCalledWith(123n, 'u_self');
  });
});
