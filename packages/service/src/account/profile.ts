/**
 * ProfileService — fetch user-related metadata (buddy list, categories, etc.).
 */

import type { AccountSession } from '@weq/account';
import type { Buddy, Category, BuddyRequest, UserProfile, BotProfile } from '@weq/db';

export class ProfileService {
  constructor(private readonly session: AccountSession) {}

  /**
   * List all buddies with pagination.
   */
  async listBuddies(limit?: number, offset = 0): Promise<Buddy[]> {
    return this.session.buddies.listBuddies(limit, offset);
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
   * until the next launch.
   */
  async botUids(): Promise<Set<string>> {
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
}
