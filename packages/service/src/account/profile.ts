/**
 * ProfileService — fetch user-related metadata (buddy list, categories, etc.).
 */

import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import type { Buddy, Category, BuddyRequest, UserProfile, BotProfile } from '@weq/db';
import {
  ApproveDoubtFriendRequest,
  FetchDoubtFriendRequests,
  HandleFriendRequest,
  RejectDoubtFriendRequest,
  SetProfile,
  SetSelfLongNick,
  setSelfAvatar,
  type SetSelfAvatarParams,
} from '@weq/protocol';

/** 在线写操作需要的最小原生面（离线账号只读 DB 时可以不传）。 */
export interface ProfileOnlineDeps {
  nt: Pick<NtHelperBinding, 'sendOidbPacket' | 'sendPacket'>;
  resolvePid: () => number;
}

export class ProfileService {
  constructor(
    private readonly session: AccountSession,
    private readonly online?: ProfileOnlineDeps,
  ) {}

  private requireOnline(): ProfileOnlineDeps {
    if (!this.online) throw new Error('该账号当前不在线，无法执行资料写操作。');
    return this.online;
  }

  /**
   * List all buddies with pagination.
   */
  async listBuddies(limit?: number, offset = 0): Promise<Buddy[]> {
    return this.session.buddies.listBuddies(limit, offset);
  }

  getBuddy(uid: string): Promise<Buddy | null> {
    return this.session.buddies.getBuddy(uid);
  }

  /** 导出选择器读取完整好友目录，不截断为亲密度榜前若干名。 */
  async listExportFriends() {
    const buddies = await this.listBuddies();
    const names = new Map<string, string>();
    for (let offset = 0; ; offset += 1000) {
      const page = await this.listFriendsByIntimacy(1000, offset);
      for (const profile of page)
        names.set(profile.uid, profile.remark?.trim() || profile.nick?.trim() || '');
      if (page.length < 1000) break;
    }
    return buddies.map((buddy) => ({
      uid: buddy.uid,
      uin: buddy.uin.toString(),
      name: names.get(buddy.uid) || (buddy.uin > 0n ? buddy.uin.toString() : buddy.uid),
      categoryId: buddy.categoryId,
    }));
  }

  /**
   * List all buddy categories (groups).
   */
  async listCategories(): Promise<Category[]> {
    return this.session.categories.listCategories();
  }

  /**
   * List buddy requests (notifications), newest first.
   */
  async listBuddyRequests(limit = 100, offset = 0): Promise<BuddyRequest[]> {
    return this.session.buddyReqs.listRequests(limit, offset);
  }

  /**
   * Get detailed profile for a user by UID.
   */
  async getProfile(uid: string): Promise<UserProfile | null> {
    return this.session.profileInfo.getProfile(uid);
  }

  /**
   * Get detailed profile for a user by UIN.
   */
  async getProfileByUin(uin: bigint): Promise<UserProfile | null> {
    return this.session.profileInfo.getProfileByUin(uin);
  }

  /**
   * Batch-resolve nicknames by uid (uid→nick map for the ones we have cached).
   */
  async nicksByUids(uids: string[]): Promise<Record<string, string>> {
    return this.session.profileInfo.nicksByUids(uids);
  }

  /**
   * Batch-resolve full profiles by uid (cached profiles only).
   */
  async profilesByUids(uids: string[]): Promise<UserProfile[]> {
    return this.session.profileInfo.profilesByUids(uids);
  }

  /**
   * Get detailed profile for the currently logged-in user.
   */
  async getSelfProfile(): Promise<UserProfile | null> {
    const uin = BigInt(this.session.context.uin);
    return this.getProfileByUin(uin);
  }

  /**
   * List all cached profiles with pagination.
   */
  async listProfiles(limit = 100, offset = 0): Promise<UserProfile[]> {
    return this.session.profileInfo.listProfiles(limit, offset);
  }

  /**
   * List all friends ordered by intimacy (高→低), paginated. Single query —
   * backs the "好友亲密度排行" lightbox, which infinite-scrolls.
   */
  async listFriendsByIntimacy(
    limit = 100,
    offset = 0,
  ): Promise<Array<{ uid: string; uin: string; nick: string; remark: string; intimacy: number }>> {
    return this.session.profileInfo.listFriendsByIntimacy(limit, offset);
  }

  /**
   * The uids of every bot this account has cached a profile for.
   *
   * Cached for the session's lifetime: the underlying scan touches all 50k+
   * profile rows, and the renderer wants this set on every member / contact /
   * conversation render to draw the bot badge. New bots only appear once QQ
   * itself writes a new profile row, so a stale set at worst misses a badge
   * until the next launch or an explicit contact-list refresh.
   */
  async botUids(refresh = false): Promise<Set<string>> {
    if (refresh) this.botUidsCache = null;
    this.botUidsCache ??= this.session.profileInfo.botUids();
    return this.botUidsCache;
  }

  /**
   * A bot's own profile (简介 / 欢迎语 / 指令列表 / 唤醒指令).
   *
   * `profile_info_adelie` is lazily filled by QQ — it only has a row once the
   * client has opened that bot's profile card. Returns null for bots we've
   * never looked at, which is normal; callers fall back to the regular
   * `profile_info_v6` profile.
   */
  async getBotProfile(uid: string): Promise<BotProfile | null> {
    return this.session.botProfiles.getBotProfile(uid);
  }

  private botUidsCache: Promise<Set<string>> | null = null;

  // ───────────────────────── 在线写操作 ─────────────────────────

  /** 改昵称 / 个性签名 / 性别（OIDB 0x112A_2）。 */
  async setProfile(params: {
    nickname?: string;
    personalNote?: string;
    sex?: number;
  }): Promise<void> {
    const { nt, resolvePid } = this.requireOnline();
    await SetProfile.invoke(nt, resolvePid(), {
      selfUin: this.session.context.uin,
      ...(params.nickname !== undefined ? { nickname: params.nickname } : {}),
      ...(params.personalNote !== undefined ? { personalNote: params.personalNote } : {}),
      ...(params.sex !== undefined ? { sex: params.sex } : {}),
    });
  }

  /** 改长昵称 / 个性签名（OIDB 0x112A_2，单独的 profile{tag,value} 形状）。 */
  async setLongNick(longNick: string): Promise<void> {
    const { nt, resolvePid } = this.requireOnline();
    await SetSelfLongNick.invoke(nt, resolvePid(), {
      selfUin: this.session.context.uin,
      longNick,
    });
  }

  /** 设置个人头像（highway cmdId 90）。`source` 是本地路径或图片字节。 */
  async setAvatar(source: SetSelfAvatarParams['source']): Promise<void> {
    const { nt, resolvePid } = this.requireOnline();
    await setSelfAvatar(nt, resolvePid(), { uin: this.session.context.uin, source });
  }

  /** 同意 / 拒绝一条好友申请（OIDB 0xB5D_44）。 */
  async handleFriendRequest(targetUid: string, approve: boolean): Promise<void> {
    const { nt, resolvePid } = this.requireOnline();
    await HandleFriendRequest.invoke(nt, resolvePid(), { targetUid, approve });
  }

  /** 同意一条可疑好友申请（OIDB 0xD72_0）。 */
  async approveDoubtFriendRequest(targetUid: string): Promise<void> {
    const { nt, resolvePid } = this.requireOnline();
    await ApproveDoubtFriendRequest.invoke(nt, resolvePid(), {
      selfUid: this.session.selfUid,
      targetUid,
    });
  }

  /** 拒绝一条可疑好友申请（OIDB 0xD69_0，op=3）。 */
  async rejectDoubtFriendRequest(targetUid: string): Promise<void> {
    const { nt, resolvePid } = this.requireOnline();
    await RejectDoubtFriendRequest.invoke(nt, resolvePid(), { uid: targetUid });
  }

  /** 拉取可疑好友申请列表（OIDB 0xD69_0，op=1）。 */
  async listDoubtFriendRequests(options: { count?: number; cookie?: string } = {}) {
    const { nt, resolvePid } = this.requireOnline();
    return FetchDoubtFriendRequests.invoke(nt, resolvePid(), options);
  }
}
