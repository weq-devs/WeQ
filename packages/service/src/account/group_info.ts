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

/** One user that shares ≥2 groups with me, for the relation graph. */
export interface RelationGraphNode {
  uid: string;
  uin: string;
  nick: string;
  card: string;
  /** Number of my groups this user is also in. */
  groupCount: number;
  /** The shared group codes (used to derive edges client-side). */
  groupCodes: string[];
  /** 0 when unknown (non-friend / not cached). */
  intimacy: number;
  isFriend: boolean;
}

/** One of my groups, with how many returned nodes it contains. */
export interface RelationGraphGroup {
  code: string;
  name: string;
  memberCount: number;
  /** How many of the returned nodes belong to this group. */
  sharedCount: number;
  /** My own member level in this group (0 when unknown). */
  myLevel: number;
}

export interface RelationGraphData {
  selfUin: string;
  nodes: RelationGraphNode[];
  groups: RelationGraphGroup[];
  scannedGroups: number;
  builtAt: number;
}

/** QQ 群管家 — a bot present in many groups; never a meaningful graph node. */
const EXCLUDED_UINS = new Set<string>(['2854196310']);
/** Members scanned per group (active members; large groups are capped). */
const MEMBER_SCAN_LIMIT = 5000;
/** Only users sharing at least this many of my groups become nodes. */
const MIN_SHARED_GROUPS = 2;
/** Hard cap on returned nodes (frontend slider tops out at 500). */
const MAX_NODES = 600;

export class GroupInfoService {
  private readonly groupNotifyService: GroupNotifyService;
  /** Per-session relation-graph cache (group membership is near-static). */
  private relationGraphCache: RelationGraphData | null = null;
  /** In-flight build, so concurrent callers share one heavy scan. */
  private relationGraphBuilding: Promise<RelationGraphData> | null = null;

  constructor(private readonly session: AccountSession) {
    this.groupNotifyService = new GroupNotifyService(session);
  }

  /**
   * Build (or return cached) the relation graph: everyone who shares ≥2 of my
   * groups, enriched with profile intimacy / friend status. Heavy on first call
   * (scans every group's membership once); cached for the session afterwards.
   * Concurrent calls dedupe onto a single in-flight build.
   */
  async getRelationGraph(opts?: { force?: boolean }): Promise<RelationGraphData> {
    if (!opts?.force && this.relationGraphCache) return this.relationGraphCache;
    if (this.relationGraphBuilding) return this.relationGraphBuilding;
    this.relationGraphBuilding = this.buildRelationGraph()
      .then((data) => {
        this.relationGraphCache = data;
        return data;
      })
      .finally(() => {
        this.relationGraphBuilding = null;
      });
    return this.relationGraphBuilding;
  }

  private async buildRelationGraph(): Promise<RelationGraphData> {
    const selfUin = String(this.session.context.uin ?? '');
    const excluded = new Set(EXCLUDED_UINS);
    if (selfUin) excluded.add(selfUin);

    // 1) My groups (code → name / memberCount).
    const groupDetails = await this.session.groupDetail.listAll(2000, 0);
    const groupMeta = new Map<string, { name: string; memberCount: number }>();
    for (const g of groupDetails) {
      groupMeta.set(g.groupCode.toString(), {
        name: g.groupName,
        memberCount: g.memberCount,
      });
    }
    const groupCodes = [...groupMeta.keys()];

    // 2) Aggregate membership by uid across every group. While scanning, also
    //    grab my own member level in each group (my record is excluded from the
    //    aggregation below, so capture it first).
    const agg = new Map<
      string,
      { uin: string; nick: string; card: string; groups: Set<string> }
    >();
    const myLevelByGroup = new Map<string, number>();
    for (const code of groupCodes) {
      let members: Array<{ uid: string; uin: string; nick: string; card: string; memberLevel: number }>;
      try {
        members = await this.session.groupMembers.listMemberBriefsInGroup(
          BigInt(code),
          MEMBER_SCAN_LIMIT,
        );
      } catch {
        continue;
      }
      for (const m of members) {
        if (!m.uid) continue;
        if (m.uin && m.uin === selfUin) myLevelByGroup.set(code, m.memberLevel);
        if (m.uin && excluded.has(m.uin)) continue;
        let info = agg.get(m.uid);
        if (!info) {
          info = { uin: m.uin, nick: m.nick, card: m.card, groups: new Set() };
          agg.set(m.uid, info);
        }
        info.groups.add(code);
        if (m.uin && !info.uin) info.uin = m.uin;
        if (m.nick && !info.nick) info.nick = m.nick;
        if (m.card && !info.card) info.card = m.card;
      }
    }

    // 3) Keep users sharing ≥ MIN_SHARED_GROUPS, sort by shared count, cap.
    let nodes: RelationGraphNode[] = [];
    for (const [uid, info] of agg) {
      if (info.groups.size < MIN_SHARED_GROUPS) continue;
      nodes.push({
        uid,
        uin: info.uin,
        nick: info.nick || info.card || '未知',
        card: info.card,
        groupCount: info.groups.size,
        groupCodes: [...info.groups],
        intimacy: 0,
        isFriend: false,
      });
    }
    nodes.sort((a, b) => b.groupCount - a.groupCount);
    nodes = nodes.slice(0, MAX_NODES);

    // 4) Enrich with profile intimacy / friend flag (one batched query).
    const profiles = await this.session.profileInfo.profilesByUids(
      nodes.map((n) => n.uid),
    );
    const profileByUid = new Map(profiles.map((p) => [p.uid, p]));
    for (const node of nodes) {
      const profile = profileByUid.get(node.uid);
      if (!profile) continue;
      node.intimacy = profile.intimacy || 0;
      node.isFriend = profile.isFriend;
      if (profile.nick) node.nick = profile.nick;
      if (!node.uin && profile.uin) node.uin = profile.uin.toString();
    }

    // 5) Group list with how many returned nodes each contains.
    const sharedByGroup = new Map<string, number>();
    for (const node of nodes) {
      for (const code of node.groupCodes) {
        sharedByGroup.set(code, (sharedByGroup.get(code) ?? 0) + 1);
      }
    }
    const groups: RelationGraphGroup[] = [...sharedByGroup.entries()]
      .map(([code, sharedCount]) => ({
        code,
        name: groupMeta.get(code)?.name || code,
        memberCount: groupMeta.get(code)?.memberCount ?? 0,
        sharedCount,
        myLevel: myLevelByGroup.get(code) ?? 0,
      }))
      .sort((a, b) => b.sharedCount - a.sharedCount);

    return {
      selfUin,
      nodes,
      groups,
      scannedGroups: groupCodes.length,
      builtAt: Date.now(),
    };
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
   * List a group's members ordered by member level (高→低). Single paginated
   * query — used by the "群成员等级排行" lightbox, which infinite-scrolls.
   */
  async listMembersByLevel(groupCode: bigint, limit = 100, offset = 0): Promise<GroupMember[]> {
    return this.session.groupMembers.listMembersByLevel(groupCode, limit, offset);
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
