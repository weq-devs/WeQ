import type { Buddy, Category } from '@weq/db';
import {
  ClearFriendRemark,
  SetFriendRemark,
  SetGroupRemark,
  SetPeerPin,
  SetFriendDisturb,
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

/** 仅编排服务端写操作；不写 QQ 原库、不自动重试。 */
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
