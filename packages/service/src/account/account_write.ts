import type { Buddy, Category } from '@weq/db';
import {
  ClearFriendRemark,
  SetFriendRemark,
  SetGroupRemark,
  SetPeerPin,
  SetFriendDisturb,
  GetFriendSnsPage,
  GetGroupIdentity,
  SetGroupIdentity,
  SetGroupMessagePolicy,
  SetFriendCategory,
  SetSelfProfile,
  SetOnlineStatus,
  setSelfAvatar,
  setGroupAvatar,
  type PacketNative,
  type PeerPreferenceTarget,
  type GroupMessagePolicy,
  type SelfProfilePatch,
  type SetOnlineStatusParams,
} from '@weq/protocol';

export interface AccountWriteIdentity {
  uin: string;
  selfUid: string;
  getBuddy: (uid: string) => Promise<Buddy | null>;
  listCategories: () => Promise<Category[]>;
}

export interface AccountWriteOutcome {
  /** confirmed 仅表示服务端确认了目标和值，不代表 QQ 本地缓存已经刷新。 */
  state: 'confirmed' | 'accepted' | 'unconfirmed' | 'unchanged';
}

/** 编排账号操作及配套读回；不写 QQ 原库、不自动重发写请求。 */
export class AccountWriteService {
  constructor(
    private readonly nt: PacketNative,
    private readonly identity: AccountWriteIdentity,
    private readonly resolvePid: () => number,
  ) {}

  selfIdentity(): { uin: string; uid: string } {
    return { uin: this.identity.uin, uid: this.identity.selfUid };
  }

  private async friend(uid: string): Promise<Buddy> {
    const buddy = await this.identity.getBuddy(uid);
    if (!buddy) throw new Error('目标不是当前账号的好友');
    return buddy;
  }

  async friendRemark(uid: string, remark: string): Promise<AccountWriteOutcome> {
    await this.friend(uid);
    const pid = this.resolvePid();
    if (remark === '') {
      await ClearFriendRemark.invoke(this.nt, pid, { uid });
      return { state: 'accepted' };
    }
    await SetFriendRemark.invoke(this.nt, pid, { uid, remark });
    return { state: 'confirmed' };
  }

  async groupRemark(groupId: number, remark: string): Promise<AccountWriteOutcome> {
    await SetGroupRemark.invoke(this.nt, this.resolvePid(), { groupId, remark });
    return { state: 'accepted' };
  }

  async pin(target: PeerPreferenceTarget, enabled: boolean): Promise<AccountWriteOutcome> {
    if (target.kind === 'c2c') await this.friend(target.uid);
    await SetPeerPin.invoke(this.nt, this.resolvePid(), { target, enabled });
    return { state: 'accepted' };
  }

  async friendDisturb(uid: string, enabled: boolean): Promise<AccountWriteOutcome> {
    await this.friend(uid);
    const state = await SetFriendDisturb.invoke(this.nt, this.resolvePid(), { uid, enabled });
    return { state };
  }

  async getFriendDisturb(uid: string): Promise<{ uid: string; enabled: boolean | null }> {
    const buddy = await this.friend(uid);
    if (buddy.uid !== uid) throw new Error('好友资料与读取目标不一致');
    const pid = this.resolvePid();
    const seen = new Set<string>();
    const cookies = new Set<string>();
    let cookie: Uint8Array | undefined;
    let found: { enabled: boolean | null } | undefined;
    for (let page = 0; page < 100; page++) {
      this.assertCurrentPid(pid);
      const result = await GetFriendSnsPage.invoke(this.nt, pid, { cookie });
      this.assertCurrentPid(pid);
      if (result.selfUin !== undefined && result.selfUin !== this.identity.uin)
        throw new Error('好友名册与当前账号不一致');
      for (const row of result.friends) {
        if (seen.has(row.uid)) throw new Error('好友名册分页返回重复目标，请重新读取');
        seen.add(row.uid);
        if (row.uid !== uid) continue;
        if (row.uin !== String(buddy.uin)) throw new Error('好友名册与读取目标不一致');
        found = { enabled: row.disturbPresent ? row.disturb : false };
      }
      cookie = result.cookie;
      // 只有完整请求全部走完，缺省 SNS 才能按已验证的关闭响应处理。
      if (!cookie?.length) {
        if (!found) throw new Error('云端好友名册中没有读取目标');
        return { uid, enabled: found.enabled };
      }
      const key = Buffer.from(cookie).toString('base64');
      if (cookies.has(key)) throw new Error('好友名册分页游标循环');
      cookies.add(key);
    }
    throw new Error('好友名册分页超过读取上限');
  }

  async getGroupIdentity(groupId: number) {
    const pid = this.resolvePid();
    const result = await GetGroupIdentity.invoke(this.nt, pid, {
      groupId,
      memberUin: this.identity.uin,
    });
    this.assertCurrentPid(pid);
    return result;
  }

  async groupIdentity(groupId: number, titleId: number): Promise<AccountWriteOutcome> {
    SetGroupIdentity.serialize({ groupId, titleId });
    const pid = this.resolvePid();
    const catalog = await this.getGroupIdentity(groupId);
    this.assertCurrentPid(pid);
    if (!catalog.titles.some((title) => title.settableId === titleId))
      throw new Error('该头衔不在当前账号的可选目录中，请重新读取');
    await SetGroupIdentity.invoke(this.nt, pid, { groupId, titleId });
    return { state: 'accepted' };
  }

  async groupMessagePolicy(
    groupId: number,
    policy: GroupMessagePolicy,
  ): Promise<AccountWriteOutcome> {
    await SetGroupMessagePolicy.invoke(this.nt, this.resolvePid(), {
      groupId,
      selfUid: this.identity.selfUid,
      policy,
    });
    return { state: 'accepted' };
  }

  async friendCategory(uid: string, categoryId: number): Promise<AccountWriteOutcome> {
    const buddy = await this.friend(uid);
    const categories = await this.identity.listCategories();
    if (categoryId !== 0 && !categories.some((category) => category.id === categoryId))
      throw new Error('目标好友分组不存在');
    if (buddy.categoryId === categoryId) return { state: 'unchanged' };
    await SetFriendCategory.invoke(this.nt, this.resolvePid(), { uid, categoryId });
    return { state: 'accepted' };
  }

  async selfProfile(patch: SelfProfilePatch): Promise<AccountWriteOutcome> {
    await SetSelfProfile.invoke(this.nt, this.resolvePid(), { ...patch, uin: this.identity.uin });
    return { state: 'accepted' };
  }

  async onlineStatus(params: SetOnlineStatusParams): Promise<AccountWriteOutcome> {
    await SetOnlineStatus.invoke(this.nt, this.resolvePid(), params);
    return { state: 'accepted' };
  }

  async selfAvatar(source: string): Promise<AccountWriteOutcome> {
    const pid = this.resolvePid();
    await setSelfAvatar(this.nt, pid, {
      uin: this.identity.uin,
      source,
      beforeSend: () => this.assertCurrentPid(pid),
    });
    return { state: 'accepted' };
  }

  async groupAvatar(groupId: number, source: string): Promise<AccountWriteOutcome> {
    const pid = this.resolvePid();
    await setGroupAvatar(this.nt, pid, {
      groupId,
      uin: this.identity.uin,
      source,
      beforeSend: () => this.assertCurrentPid(pid),
    });
    return { state: 'accepted' };
  }
  private assertCurrentPid(pid: number): void {
    if (this.resolvePid() !== pid) throw new Error('QQ 运行时已切换，请重新操作');
  }
}
