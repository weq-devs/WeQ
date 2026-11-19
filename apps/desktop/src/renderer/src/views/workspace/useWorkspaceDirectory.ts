import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { useContactOnlineStatuses } from '../../hooks/useContactOnlineStatuses';
import { intimateRelationOf } from '../../lib/profileRelations';
import { sidebarConversationsWithoutAssistant } from '../../lib/groupAssistant';
import { isDataline } from '../../lib/deviceAvatar';
import { applyOutgoingConversationPreview } from '../../lib/outgoingConversationPreview';
import { classifyChatType, toChatTypeNumber } from '@weq/codec';
import { contactTitle } from '../../lib/contactTitle';
import { conversationSortTime, conversationActivityTime } from '@weq/service/conversation-order';
import { reconcileConversationRows, sortConversationRows } from '../../lib/conversationListOrder';
import { createConversationProjection } from '../../lib/conversationProjection';
import { archivedConversationRow } from '../../lib/conversationDirectoryRows';
import type {
  Contact,
  Conversation,
  ConversationHighlight,
  User,
} from '../../im-template/template';
import type {
  RecentContactWire,
  RecentContactTopWire,
  HiddenSessionWire,
  DeletedSessionWire,
  OfficialAccountWire,
  ServiceAccountWire,
  UserProfileWire,
  BuddyWire,
  CategoryWire,
  BuddyRequestWire,
  GroupNotifyWire,
  GroupDetailWire,
} from './types';
import {
  fallbackPreference,
  groupAvatarSrc,
  senderAvatarSrc,
  toIsoTime,
  buddyToContact,
  groupDetailToConversation,
  buddyRequestToContactRequest,
  GROUP_NOTIFY_ACTION,
  groupNotifyToGroupRequest,
  contactToConversation,
} from './identity';

type QueryData<T> = { data?: T };
type DirectoryInput = {
  user: User;
  profileByUid: Map<string, UserProfileWire>;
  previewDisplayNames: Map<string, string>;
  previewGroupNames: Map<string, ReadonlyMap<string, string>>;
  recentContactsData: RecentContactWire[];
  categories: QueryData<CategoryWire[]>;
  botUidList: QueryData<string[]>;
  buddies: QueryData<BuddyWire[]>;
  allGroups: QueryData<GroupDetailWire[]>;
  topContacts: QueryData<RecentContactTopWire[]>;
  hiddenSessions: QueryData<HiddenSessionWire[]>;
  deletedSessions: QueryData<DeletedSessionWire[]>;
  officialAccounts: QueryData<OfficialAccountWire[]>;
  serviceAccounts: QueryData<ServiceAccountWire[]>;
  guildDirectSessions: QueryData<
    Array<{ nodeId: string; lastTime: string; peerNick: string; preview: unknown }>
  >;
  buddyRequests: QueryData<BuddyRequestWire[]>;
  groupNotifies: QueryData<Array<Omit<GroupNotifyWire, 'sourceTable'> & { sourceTable: string }>>;
  onlineStatusByUid: ReturnType<typeof useContactOnlineStatuses>;
  specialCare: {
    data?: { items: Array<{ uin: string; uid: string; name: string }>; fansCount: number | null };
    isError: boolean;
    refetch: () => unknown;
  };
  specialCareUnavailable: string | null;
  groupAssistantEntry: RecentContactWire | undefined;
  groupAssistantIds: Set<string>;
  temporaryConversations: Record<string, { conversation: Conversation; appearedAt: number }>;
  outgoingConversationPreviews: Parameters<typeof applyOutgoingConversationPreview>[1];
  unreadByConv: Record<string, number>;
  highlightsByConv: Record<string, ConversationHighlight[]>;
  draftTimesByConv: Record<string, number>;
};

/** 目录投影只依赖目录输入，不订阅消息窗口、草稿输入或工具浮层。 */
export function useWorkspaceDirectory({
  user,
  profileByUid,
  previewDisplayNames,
  previewGroupNames,
  recentContactsData,
  categories,
  botUidList,
  buddies,
  allGroups,
  topContacts,
  hiddenSessions,
  deletedSessions,
  officialAccounts,
  serviceAccounts,
  guildDirectSessions,
  buddyRequests,
  groupNotifies,
  onlineStatusByUid,
  specialCare,
  specialCareUnavailable,
  groupAssistantEntry,
  groupAssistantIds,
  temporaryConversations,
  outgoingConversationPreviews,
  unreadByConv,
  highlightsByConv,
  draftTimesByConv,
}: DirectoryInput) {
  const categoryById = useMemo(() => {
    return new Map(
      ((categories.data ?? []) as CategoryWire[]).map((category) => [category.id, category]),
    );
  }, [categories.data]);
  /** 机器人 uid 集合 —— 好友/群成员/会话/消息发送者都靠它打「机器人」标。 */
  const botUids = useMemo(() => new Set((botUidList.data ?? []) as string[]), [botUidList.data]);
  const buddyContacts = useMemo(
    () =>
      ((buddies.data ?? []) as BuddyWire[]).map((buddy) => {
        const contact = buddyToContact(buddy, profileByUid, categoryById, botUids);
        const statusObj = onlineStatusByUid[buddy.uid];
        return {
          ...contact,
          onlineStatus: statusObj?.displayStatus || contact.onlineStatus,
          onlineStatusObj: statusObj,
        };
      }),
    [buddies.data, categoryById, onlineStatusByUid, profileByUid, botUids],
  );
  const relationshipDirectory = useMemo(() => {
    const friends = new Map<string, Contact>();
    for (const contact of buddyContacts) {
      friends.set(contact.id, contact);
      if (contact.identityLabel === 'QQ') friends.set(contact.identityValue, contact);
    }
    const groups = new Map<string, { listed: boolean; role?: string | null }>();
    for (const group of (allGroups.data ?? []) as GroupDetailWire[]) {
      if (Object.hasOwn(group, 'directory'))
        groups.set(group.groupCode, {
          listed: Boolean(group.directory),
          role: group.directory?.role,
        });
    }
    return {
      selfUid: user.uid,
      selfUin: user.identityValue,
      friends,
      // 当前查询有 2000 条上限；满页不能用缺席证明非好友。
      friendsComplete: buddies.data !== undefined && buddies.data.length < 2000,
      groups,
    };
  }, [buddyContacts, buddies.data, allGroups.data, user.uid, user.identityValue]);
  // 置顶会话（recent_contact_top_table）：会话 id → 置顶时间（41103，秒）。
  const topTimeByConv = useMemo(() => {
    const map: Record<string, number> = {};
    for (const top of (topContacts.data ?? []) as RecentContactTopWire[]) {
      if (top.targetId)
        map[top.targetId] = Math.max(map[top.targetId] ?? 0, Number(top.topTime) || 0);
      if (top.chatType === 'KCHATTYPEGROUPHELPER' || Number(top.chatType) === 7) {
        map['merged:group-assistant'] = Number(top.topTime);
      }
    }
    // The virtual helper entry carries its own authoritative pin flag. Its
    // timestamp can survive unpinning, so the flag must override the registry.
    if (groupAssistantEntry && typeof groupAssistantEntry.pinned === 'boolean') {
      if (groupAssistantEntry.pinned) {
        map['merged:group-assistant'] = Number(groupAssistantEntry.topTime);
      } else {
        delete map['merged:group-assistant'];
      }
    }
    return map;
  }, [topContacts.data, groupAssistantEntry]);
  // 群号 → 群名。隐藏会话面板（MergedSessionPanel）解析群聊显示名也要用它，
  // 提到 conversations useMemo 外面，避免闭包内重复构建两份。
  const [visibleGroupNames, setVisibleGroupNames] = useState<Record<string, string>>({});
  const attemptedGroupNames = useRef(new Set<string>());
  const groupNameByCode = useMemo(() => {
    const groups = (allGroups.data ?? []) as GroupDetailWire[];
    const names = new Map(Object.entries(visibleGroupNames));
    for (const group of groups) if (group.groupName) names.set(group.groupCode, group.groupName);
    return names;
  }, [allGroups.data, visibleGroupNames]);
  // 隐藏会话 uid 集合：hidden_session_storage_table_v1 里有记录的 targetUid/群号。
  // 提到 conversations useMemo 外面，因为 hiddenConversationsById（供 shell 解析
  // 隐藏会话详情用）也要复用它。
  const hiddenUidSet = useMemo(() => {
    const list = (hiddenSessions.data ?? []) as HiddenSessionWire[];
    const set = new Set<string>();
    for (const hidden of list) {
      if (hidden.targetUid && hidden.resolvable) set.add(hidden.targetUid);
    }
    return set;
  }, [hiddenSessions.data]);

  // 删除会话 uid 集合：recent_contact_delete_storage 里有记录且不在 recent_contact 里的。
  const deletedUidSet = useMemo(() => {
    const list = (deletedSessions.data ?? []) as DeletedSessionWire[];
    const set = new Set<string>();
    for (const deleted of list) {
      if (deleted.targetUid && deleted.resolvable) set.add(deleted.targetUid);
    }
    return set;
  }, [deletedSessions.data]);

  // 隐藏会话不出现在主 conversations 列表里（见下方 useMemo），所以 shell 的
  // activeConversation 查找会失效——单独建一份供 selectedConversation 兜底解析，
  // 不然从隐藏会话选择器点进去后消息页面直接打不开。
  const hiddenConversationsById = useMemo(() => {
    const map = new Map<string, Conversation>();
    if (hiddenUidSet.size === 0) return map;
    for (const contact of recentContactsData) {
      if (!hiddenUidSet.has(contact.targetUid)) continue;
      const conv = contactToConversation(
        contact,
        user,
        groupNameByCode,
        botUids,
        previewDisplayNames,
        previewGroupNames,
        profileByUid,
      );
      if (conv) map.set(conv.id, conv);
    }
    for (const detail of (allGroups.data ?? []) as GroupDetailWire[]) {
      if (!hiddenUidSet.has(detail.groupCode)) continue;
      map.set(detail.groupCode, groupDetailToConversation(detail, map.get(detail.groupCode), user));
    }
    for (const [id, conversation] of map)
      map.set(id, {
        ...applyOutgoingConversationPreview(conversation, outgoingConversationPreviews, user),
        hidden: true,
      });
    for (const hidden of (hiddenSessions.data ?? []) as HiddenSessionWire[]) {
      if (!hidden.resolvable || !hidden.targetUid || map.has(hidden.targetUid)) continue;
      map.set(
        hidden.targetUid,
        archivedConversationRow(
          hidden,
          'hidden',
          profileByUid.get(hidden.targetUid),
          groupNameByCode.get(hidden.targetUid),
        ),
      );
    }
    return map;
  }, [
    hiddenUidSet,
    hiddenSessions.data,
    recentContactsData,
    allGroups.data,
    groupNameByCode,
    user,
    botUids,
    previewDisplayNames,
    previewGroupNames,
    profileByUid,
    outgoingConversationPreviews,
  ]);

  // 删除会话同样不在主列表（已从 recent_contact 消失），需要单独解析供点击后打开。
  // 和隐藏会话不同，删除会话已经不在 recent_contact 里，所以只能用 deletedSessions 数据。
  const deletedConversationsById = useMemo(() => {
    const map = new Map<string, Conversation>();
    if (deletedUidSet.size === 0) return map;

    for (const deleted of (deletedSessions.data ?? []) as DeletedSessionWire[]) {
      if (!deleted.resolvable || !deleted.targetUid) continue;

      const isGroup = deleted.chatType === 2;

      if (isGroup) {
        // 群聊：尝试从 allGroups 获取详细信息
        const groupDetail = (allGroups.data ?? []).find(
          (g: GroupDetailWire) => g.groupCode === deleted.targetUid,
        );
        if (groupDetail) {
          map.set(deleted.targetUid, groupDetailToConversation(groupDetail, undefined, user));
        } else {
          // 群详情不存在，构建最小会话对象
          const groupName = groupNameByCode.get(deleted.targetUid) || deleted.targetUid;
          map.set(deleted.targetUid, {
            id: deleted.targetUid,
            type: 'group',
            updatedAt: toIsoTime(deleted.sendTime),
            otherUser: null,
            group: {
              id: deleted.targetUid,
              name: groupName,
              identityLabel: 'Group',
              identityValue: deleted.targetUid,
              avatarUrl: groupAvatarSrc(deleted.targetUid),
              announcement: null,
              memberCount: 0,
              role: 'member',
            },
            members: [],
            preference: { pinned: false, muted: false, blocked: false },
            unreadCount: 0,
            lastMessage: null,
          });
        }
      } else {
        // 私聊：从 profiles 或 buddies 获取用户信息
        const profile = profileByUid.get(deleted.targetUid);
        const displayName = profile?.remark || profile?.nick || profile?.qid || deleted.targetUid;
        const avatarUrl = senderAvatarSrc(profile?.uin || '') || profile?.avatarUrl || null;

        map.set(deleted.targetUid, {
          id: deleted.targetUid,
          type: 'direct',
          updatedAt: toIsoTime(deleted.sendTime),
          otherUser: {
            id: deleted.targetUid,
            identityLabel: 'UID',
            identityValue: deleted.targetUid,
            username: deleted.targetUid,
            displayName,
            kind: 'human',
            avatarUrl,
          },
          group: null,
          members: [],
          preference: { pinned: false, muted: false, blocked: false },
          unreadCount: 0,
          lastMessage: null,
        });
      }
    }

    for (const [id, row] of map) map.set(id, { ...row, deleted: true });
    return map;
  }, [
    deletedUidSet,
    deletedSessions.data,
    allGroups.data,
    groupNameByCode,
    profileByUid,
    user,
    botUids,
  ]);
  const baseConversationRowsRef = useRef<Conversation[]>([]);
  const conversationRowsRef = useRef<Conversation[]>([]);
  const recentConversationCache = useMemo(
    () => ({
      rows: new WeakMap<RecentContactWire, Conversation | null>(),
      projection: createConversationProjection<GroupDetailWire>((detail, previous) =>
        groupDetailToConversation(detail, previous, user),
      ),
    }),
    [user, groupNameByCode, botUids, previewDisplayNames, previewGroupNames, profileByUid],
  );
  const baseConversations = useMemo(() => {
    const groups = (allGroups.data ?? []) as GroupDetailWire[];
    const hiddenList = (hiddenSessions.data ?? []) as HiddenSessionWire[];
    const deletedList = (deletedSessions.data ?? []) as DeletedSessionWire[];

    // 只保留非 official/service 的 recent contacts（103/118 走合并会话入口）
    // 同时排除隐藏会话：hidden_session_storage_table_v1 里有的不出现在主列表
    const directoryKnown = groups.some((detail) => Object.hasOwn(detail, 'directory'));
    const listedCodes = new Set(
      groups.filter((detail) => detail.directory).map((detail) => detail.groupCode),
    );
    const recentConversations = recentContactsData
      .filter((c) => {
        const kind = classifyChatType(c.chatType);
        if (kind === 'official' || kind === 'service') return false;
        // 隐藏会话：在 hidden_session_storage_table_v1 里有记录的，不出现在主列表
        return !hiddenUidSet.has(c.targetUid);
      })
      .map((contact) => {
        if (recentConversationCache.rows.has(contact))
          return recentConversationCache.rows.get(contact)!;
        const mapped = contactToConversation(
          contact,
          user,
          groupNameByCode,
          botUids,
          previewDisplayNames,
          previewGroupNames,
          profileByUid,
        );
        recentConversationCache.rows.set(contact, mapped);
        return mapped;
      })
      .filter((conversation): conversation is Conversation => conversation !== null)
      .map((conversation) =>
        conversation.type === 'group' && directoryKnown
          ? recentConversationCache.projection.membership(
              conversation,
              listedCodes.has(conversation.id),
            )
          : conversation,
      );
    const byId = new Map(
      recentConversations.map((conversation) => [conversation.id, conversation]),
    );

    for (const detail of groups) {
      // 群也要检查：如果在 hidden_session_storage_table_v1 里，不加入主列表
      if (hiddenUidSet.has(detail.groupCode)) continue;
      byId.set(
        detail.groupCode,
        recentConversationCache.projection.group(detail, byId.get(detail.groupCode)),
      );
    }
    for (const [id, conversation] of byId)
      byId.set(
        id,
        applyOutgoingConversationPreview(conversation, outgoingConversationPreviews, user),
      );

    // 公众号合并会话：找所有 103 公众号里最新的那条 sendTime，合成一个 merged 入口。
    const officialList = (officialAccounts.data ?? []) as OfficialAccountWire[];
    if (officialList.length > 0) {
      const latest = officialList.reduce((a, b) =>
        Number(b.sendTime) > Number(a.sendTime) ? b : a,
      );
      const updatedAt = toIsoTime(latest.sendTime);
      const merged: import('../../im-template/template').MergedConversation = {
        id: 'merged:official',
        type: 'merged',
        mergedKind: 'official',
        title: '公众号',
        avatarUrl: null,
        otherUser: null,
        group: null,
        members: [],
        updatedAt,
        preference: fallbackPreference,
        unreadCount: 0,
        lastMessage: {
          id: `merged:official:${latest.sendTime}`,
          senderId: null,
          body: latest.prompt,
          createdAt: updatedAt,
        },
      };
      byId.set('merged:official', merged);
    }

    // 服务号合并会话：同理取最新的那条。
    const serviceList = (serviceAccounts.data ?? []) as ServiceAccountWire[];
    if (serviceList.length > 0) {
      const latest = serviceList.reduce((a, b) =>
        Number(b.sendTime) > Number(a.sendTime) ? b : a,
      );
      const updatedAt = toIsoTime(latest.sendTime);
      const merged: import('../../im-template/template').MergedConversation = {
        id: 'merged:service',
        type: 'merged',
        mergedKind: 'service',
        title: '服务号',
        avatarUrl: null,
        otherUser: null,
        group: null,
        members: [],
        updatedAt,
        preference: fallbackPreference,
        unreadCount: 0,
        lastMessage: {
          id: `merged:service:${latest.sendTime}`,
          senderId: null,
          body: latest.prompt,
          createdAt: updatedAt,
        },
      };
      byId.set('merged:service', merged);
    }

    // 隐藏会话合并入口：至少有一个隐藏会话时，置顶显示（不展示内部预览）。
    // 「两表都有才算隐藏会话」这条规则已经在后端 HiddenSessionService 里用不
    // 受分页限制的精确查询判断过了（resolvable 已经蕴含这个条件），这里不用
    // 再拿前端这份被 listRecentContacts 截断到 200 条的列表二次校验——用它反
    // 而会把真正命中、只是排在 200 名开外的隐藏会话又误杀掉。
    const validHiddenList = hiddenList.filter((h) => h.resolvable);

    if (validHiddenList.length > 0) {
      const latest = validHiddenList.reduce((a, b) =>
        Number(b.sendTime) > Number(a.sendTime) ? b : a,
      );
      const updatedAt = toIsoTime(latest.sendTime);
      const merged: import('../../im-template/template').MergedConversation = {
        id: 'merged:hidden',
        type: 'merged',
        mergedKind: 'hidden',
        title: '隐藏会话',
        avatarUrl: null,
        otherUser: null,
        group: null,
        members: [],
        updatedAt,
        preference: { ...fallbackPreference, pinned: true },
        unreadCount: 0,
        lastMessage: {
          id: `merged:hidden:${latest.sendTime}`,
          senderId: null,
          body: null,
          createdAt: updatedAt,
        },
      };
      byId.set('merged:hidden', merged);
    }

    // 删除会话合并入口：至少有一个删除会话时，置顶显示（不展示内部预览）。
    // 删除会话已经从 recent_contact_v3_table 消失，后端已过滤掉"复活"的会话。
    const validDeletedList = deletedList.filter((d) => d.resolvable);

    if (validDeletedList.length > 0) {
      const latest = validDeletedList.reduce((a, b) =>
        Number(b.sendTime) > Number(a.sendTime) ? b : a,
      );
      const updatedAt = toIsoTime(latest.sendTime);
      const merged: import('../../im-template/template').MergedConversation = {
        id: 'merged:deleted',
        type: 'merged',
        mergedKind: 'deleted',
        title: '最近删除',
        avatarUrl: null,
        otherUser: null,
        group: null,
        members: [],
        updatedAt,
        preference: { ...fallbackPreference, pinned: true },
        unreadCount: 0,
        lastMessage: {
          id: `merged:deleted:${latest.sendTime}`,
          senderId: null,
          body: null,
          createdAt: updatedAt,
        },
      };
      byId.set('merged:deleted', merged);
    }

    const assistantGroups = Array.from(byId.values()).filter(
      (conversation) => conversation.type === 'group' && groupAssistantIds.has(conversation.id),
    );
    if (groupAssistantEntry || assistantGroups.length) {
      const latest = assistantGroups.reduce<Conversation | null>(
        (latest, current) =>
          !latest ||
          conversationSortTime(current.updatedAt, undefined) >
            conversationSortTime(latest.updatedAt, undefined)
            ? current
            : latest,
        null,
      );
      const updatedAt = latest?.updatedAt ?? toIsoTime(groupAssistantEntry?.sendTime ?? '0');
      const merged: import('../../im-template/template').MergedConversation = {
        id: 'merged:group-assistant',
        type: 'merged',
        mergedKind: 'groupAssistant',
        title: '群助手',
        avatarUrl: null,
        otherUser: null,
        group: null,
        members: [],
        updatedAt,
        preference: { ...fallbackPreference, muted: true },
        unreadCount: 0,
        lastMessage: latest?.lastMessage
          ? {
              ...latest.lastMessage,
              body: `${latest.type === 'group' ? latest.group.name : ''}：${latest.lastMessage.body ?? ''}`,
              previewNodes: null,
            }
          : {
              id: 'group-assistant-empty',
              senderId: null,
              body: '暂无群消息',
              createdAt: updatedAt,
            },
      };
      byId.set(merged.id, merged);
    }

    // 频道私聊合并入口：本机有频道私聊记录时才出现，点开展开各会话。
    const guildList = (guildDirectSessions.data ?? []) as Array<{
      nodeId: string;
      lastTime: string;
      peerNick: string;
      preview: unknown;
    }>;
    if (guildList.length > 0) {
      const latest = guildList.reduce((a, b) => (Number(b.lastTime) > Number(a.lastTime) ? b : a));
      const updatedAt = toIsoTime(latest.lastTime);
      const merged: import('../../im-template/template').MergedConversation = {
        id: 'merged:guild-direct',
        type: 'merged',
        mergedKind: 'guildDirect',
        title: '频道私聊',
        avatarUrl: null,
        otherUser: null,
        group: null,
        members: [],
        updatedAt,
        preference: fallbackPreference,
        unreadCount: 0,
        lastMessage: {
          id: `merged:guild-direct:${latest.lastTime}`,
          senderId: null,
          body: latest.peerNick ? `${latest.peerNick}：…` : null,
          createdAt: updatedAt,
        },
      };
      byId.set('merged:guild-direct', merged);
    }

    for (const [id, entry] of Object.entries(temporaryConversations)) {
      const current =
        byId.get(id) ??
        applyOutgoingConversationPreview(entry.conversation, outgoingConversationPreviews, user);
      if (current.type === 'group' && groupAssistantIds.has(id)) {
        byId.set(id, current);
        continue;
      }
      byId.set(id, {
        ...current,
        hidden: false,
        updatedAt: new Date(
          Math.max(Date.parse(current.updatedAt) || 0, entry.appearedAt),
        ).toISOString(),
      });
    }

    return reconcileConversationRows(baseConversationRowsRef.current, Array.from(byId.values()));
  }, [
    recentConversationCache,
    allGroups.data,
    recentContactsData,
    temporaryConversations,
    officialAccounts.data,
    serviceAccounts.data,
    guildDirectSessions.data,
    hiddenSessions.data,
    deletedSessions.data,
    hiddenUidSet,
    groupNameByCode,
    profileByUid,
    user,
    previewDisplayNames,
    previewGroupNames,
    groupAssistantIds,
    groupAssistantEntry,
    botUids,
    outgoingConversationPreviews,
  ]);
  const conversations = useMemo(() => {
    const assistantUnread = [...groupAssistantIds].reduce(
      (count, id) => count + (unreadByConv[id] ?? 0),
      0,
    );
    const assistantDraftTime = [...groupAssistantIds].reduce(
      (latest, id) => Math.max(latest, draftTimesByConv[id] ?? 0),
      0,
    );
    return reconcileConversationRows(
      conversationRowsRef.current,
      // 与 QQ 的 41136 一致：置顶分组，两组内部都按消息／草稿活动时间排。
      sortConversationRows(
        baseConversations.map((conversation) => {
          const unread =
            conversation.type === 'merged' && conversation.mergedKind === 'groupAssistant'
              ? assistantUnread
              : unreadByConv[conversation.id];
          const highlights = highlightsByConv[conversation.id] ?? null;
          const topTime = topTimeByConv[conversation.id];
          const pinStateKnown =
            Boolean(topContacts.data) &&
            (conversation.type === 'direct' || conversation.type === 'group');
          const activityTime = Math.max(
            draftTimesByConv[conversation.id] ?? 0,
            temporaryConversations[conversation.id]?.appearedAt ?? 0,
            conversation.type === 'merged' && conversation.mergedKind === 'groupAssistant'
              ? assistantDraftTime
              : 0,
          );
          return recentConversationCache.projection.directory(
            conversation,
            {
              unreadCount: unread,
              highlights,
              pinnedAt: topTime,
              pinStateKnown,
              activityTime,
            },
            fallbackPreference,
          );
        }),
        undefined,
        (row) =>
          Math.max(conversationActivityTime(row), temporaryConversations[row.id]?.appearedAt ?? 0),
      ),
    );
  }, [
    baseConversations,
    recentConversationCache,
    temporaryConversations,
    unreadByConv,
    highlightsByConv,
    topTimeByConv,
    topContacts.data,
    draftTimesByConv,
    groupAssistantIds,
  ]);
  useLayoutEffect(() => {
    baseConversationRowsRef.current = baseConversations;
    conversationRowsRef.current = conversations;
  }, [baseConversations, conversations]);
  const sidebarConversations = useMemo(
    () => sidebarConversationsWithoutAssistant(conversations, groupAssistantIds),
    [conversations, groupAssistantIds],
  );

  const specialContactSections = useMemo(() => {
    const robots = buddyContacts.filter((contact) => botUids.has(contact.id));
    const devices = conversations
      .filter(
        (conversation): conversation is Extract<Conversation, { type: 'direct' }> =>
          conversation.type === 'direct' &&
          conversation.chatType !== undefined &&
          isDataline(conversation.chatType),
      )
      .map((conversation) => ({
        ...conversation.otherUser,
        identityLabel: '设备',
        createdAt: new Date(0).toISOString(),
      }));
    const byUin = new Map(buddyContacts.map((contact) => [contact.identityValue, contact]));
    const specialItems: Contact[] = (specialCare.data?.items ?? []).map((item) => {
      const existing = byUin.get(item.uin);
      if (existing) return existing;
      const profile = [...profileByUid.values()].find((entry) => entry.uin === item.uin);
      if (profile)
        return buddyToContact(
          { uid: profile.uid, uin: item.uin, qid: profile.qid, categoryId: 0 },
          profileByUid,
          categoryById,
          botUids,
        );
      return {
        id: item.uid,
        identityLabel: 'QQ',
        identityValue: item.uin,
        username: item.uin,
        displayName: item.name || item.uin,
        nick: item.name,
        avatarUrl: senderAvatarSrc(item.uin),
        createdAt: new Date(0).toISOString(),
      };
    });
    const description =
      specialCareUnavailable ??
      (specialCare.isError
        ? '特别关心读取失败'
        : specialCare.data
          ? specialCare.data.fansCount === null
            ? '特关我的人数暂不可用'
            : `特关我的人数：${specialCare.data.fansCount} 人`
          : '正在读取特别关心…');
    return [
      { id: 'special:devices', name: '我的设备', items: devices },
      { id: 'special:bots', name: '机器人', items: robots },
      {
        id: 'special:care',
        name: '特别关心',
        items: specialItems,
        count: specialCare.data ? specialItems.length : null,
        description,
        onRetry:
          specialCareUnavailable === null && specialCare.isError
            ? () => {
                void specialCare.refetch();
              }
            : undefined,
      },
      {
        id: 'special:intimate',
        name: '亲密关系',
        items: buddyContacts.filter((contact) => intimateRelationOf(contact) !== null),
      },
    ];
  }, [
    buddyContacts,
    botUids,
    conversations,
    specialCare.data,
    specialCare.isError,
    specialCare.refetch,
    specialCareUnavailable,
    profileByUid,
    categoryById,
  ]);

  const historicalContactSections = useMemo(() => {
    const current = new Set(buddyContacts.map((contact) => contact.id));
    const former = new Map<string, Contact>();
    const temporary = new Map<string, Contact>();
    const seen = new Set<string>();
    const sources = [
      ...recentContactsData,
      ...((hiddenSessions.data ?? []) as HiddenSessionWire[]).filter((row) => row.resolvable),
      ...((deletedSessions.data ?? []) as DeletedSessionWire[]).filter((row) => row.resolvable),
    ];
    for (const row of sources) {
      const uid = row.targetUid;
      if (seen.has(uid)) continue;
      if (
        !uid ||
        uid === user.uid ||
        current.has(uid) ||
        botUids.has(uid) ||
        classifyChatType(row.chatType) !== 'direct'
      )
        continue;
      const type = toChatTypeNumber(row.chatType);
      seen.add(uid);
      const profile = profileByUid.get(uid);
      const uin = profile?.uin || ('targetUin' in row ? row.targetUin : '') || '';
      if (uin === user.identityValue) continue;
      const contact = buddyToContact(
        { uid, uin, qid: profile?.qid || '', categoryId: 0 },
        profileByUid,
        categoryById,
        botUids,
      );
      if (!profile && 'targetDisplayName' in row) contact.displayName = contactTitle(row);
      const target = type === 1 ? former : temporary;
      if (!target.has(uid)) target.set(uid, contact);
    }
    return [
      {
        id: 'history:former',
        name: '非好友会话',
        items: [...former.values()],
        description: '保留私聊记录，但不在当前好友列表',
      },
      { id: 'history:temporary', name: '临时会话', items: [...temporary.values()] },
    ];
  }, [
    buddyContacts,
    recentContactsData,
    hiddenSessions.data,
    deletedSessions.data,
    user,
    botUids,
    profileByUid,
    categoryById,
  ]);

  const contactDirectoryConversations = useMemo(() => {
    const map = new Map([
      ...hiddenConversationsById,
      ...deletedConversationsById,
      ...conversations.map((conversation) => [conversation.id, conversation] as const),
    ]);
    const details = (allGroups.data ?? []) as GroupDetailWire[];
    for (const detail of details)
      map.set(
        detail.groupCode,
        recentConversationCache.projection.group(detail, map.get(detail.groupCode)),
      );
    if (details.some((detail) => Object.hasOwn(detail, 'directory'))) {
      const currentCodes = new Set(
        details.filter((detail) => detail.directory).map((detail) => detail.groupCode),
      );
      for (const [id, conversation] of map)
        if (conversation.type === 'group')
          map.set(
            id,
            recentConversationCache.projection.membership(conversation, currentCodes.has(id)),
          );
    }
    return [...map.values()];
  }, [
    conversations,
    hiddenConversationsById,
    deletedConversationsById,
    allGroups.data,
    user,
    recentConversationCache,
  ]);

  const profileContacts = useMemo(() => {
    const byId = new Map<string, Contact>(buddyContacts.map((contact) => [contact.id, contact]));
    for (const section of specialContactSections)
      for (const contact of section.items) {
        if (!byId.has(contact.id)) byId.set(contact.id, contact);
      }
    for (const section of historicalContactSections)
      for (const contact of section.items) if (!byId.has(contact.id)) byId.set(contact.id, contact);
    return [...byId.values()];
  }, [buddyContacts, specialContactSections, historicalContactSections]);

  const groupsById = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations],
  );
  const contactRequests = useMemo(
    () =>
      ((buddyRequests.data ?? []) as BuddyRequestWire[]).map((request) =>
        buddyRequestToContactRequest(request, profileByUid),
      ),
    [buddyRequests.data, profileByUid],
  );
  const groupRequests = useMemo(
    () =>
      ((groupNotifies.data ?? []) as GroupNotifyWire[])
        .filter((n) => Object.hasOwn(GROUP_NOTIFY_ACTION, n.status))
        .map((n) => groupNotifyToGroupRequest(n, profileByUid, groupsById))
        .filter((r): r is NonNullable<typeof r> => r !== null),
    [groupNotifies.data, profileByUid, groupsById],
  );

  return {
    categoryById,
    botUids,
    buddyContacts,
    relationshipDirectory,
    topTimeByConv,
    visibleGroupNames,
    setVisibleGroupNames,
    attemptedGroupNames,
    groupNameByCode,
    hiddenUidSet,
    deletedUidSet,
    hiddenConversationsById,
    deletedConversationsById,
    conversations,
    sidebarConversations,
    specialContactSections,
    historicalContactSections,
    contactDirectoryConversations,
    profileContacts,
    contactRequests,
    groupRequests,
  };
}
