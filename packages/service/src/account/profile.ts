/**
 * ProfileService — fetch user-related metadata (buddy list, categories, etc.).
 */

import type { AccountSession } from '@weq/account';
import type { Buddy, Category, BuddyRequest, UserProfile } from '@weq/db';

export class ProfileService {
  constructor(private readonly session: AccountSession) {}

  /**
   * List all buddies with pagination.
   */
  async listBuddies(limit = 200, offset = 0): Promise<Buddy[]> {
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
}
