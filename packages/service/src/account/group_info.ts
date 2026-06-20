/**
 * GroupInfoService — fetch metadata related to groups (essence messages, members, etc.).
 */

import type { AccountSession } from '@weq/account';
import type {
  GroupEssence,
  GroupMemberLevelInfo,
  GroupDetail,
  GroupBulletin,
  GroupMember,
  GroupNotify,
} from '@weq/db';
import { GroupNotifyService } from './group_notify';

export class GroupInfoService {
  private readonly groupNotifyService: GroupNotifyService;

  constructor(private readonly session: AccountSession) {
    this.groupNotifyService = new GroupNotifyService(session);
  }

  /**
   * List essence (pinned) messages for a group, newest first.
   */
  async getEssenceMessages(groupCode: bigint, limit = 50, offset = 0): Promise<GroupEssence[]> {
    return this.session.groupEssence.listEssence(groupCode, limit, offset);
  }

  /**
   * Get member level definitions for a group.
   */
  async getMemberLevelInfo(groupCode: bigint): Promise<GroupMemberLevelInfo | null> {
    return this.session.memberLevelInfo.getLevelInfo(groupCode);
  }

  /**
   * Get detailed metadata for a single group.
   */
  async getGroupDetail(groupCode: bigint): Promise<GroupDetail | null> {
    return this.session.groupDetail.getDetail(groupCode);
  }

  /**
   * List all groups with detailed metadata.
   */
  async listAllGroups(limit = 100, offset = 0): Promise<GroupDetail[]> {
    return this.session.groupDetail.listAll(limit, offset);
  }

  /**
   * List announcements for a group.
   */
  async getGroupBulletins(groupCode: bigint, limit = 50, offset = 0): Promise<GroupBulletin[]> {
    return this.session.groupBulletins.listBulletins(groupCode, limit, offset);
  }

  /**
   * List all members of a group (active only).
   */
  async listMembersInGroup(groupCode: bigint, limit = 100, offset = 0): Promise<GroupMember[]> {
    return this.session.groupMembers.listMembersInGroup(groupCode, limit, offset);
  }

  /**
   * Get info for a specific member in a group.
   */
  async getMemberInfo(groupCode: bigint, uid: string): Promise<GroupMember | null> {
    return this.session.groupMembers.getMember(groupCode, uid);
  }

  /**
   * Batch-fetch members by uid (single query). Used to resolve message senders
   * that are not in the loaded member page.
   */
  async getMembersByUids(groupCode: bigint, uids: string[]): Promise<GroupMember[]> {
    return this.session.groupMembers.getMembersByUids(groupCode, uids);
  }

  /**
   * List all groups a user belongs to.
   */
  async listUserGroups(uid: string, limit = 100, offset = 0): Promise<GroupMember[]> {
    return this.session.groupMembers.listUserGroups(uid, limit, offset);
  }

  /**
   * List all group notifications (both normal and doubt).
   */
  async listGroupNotifies(limit = 100, offset = 0): Promise<GroupNotify[]> {
    return this.groupNotifyService.listAllNotifications(limit, offset);
  }
}
