import { groupDirectoryPreference, mutedFromNotifyLevel } from '../../lib/groupNotifications';
import { groupNoticeId } from '../../lib/contactNotice';
import { buddyRequestDirection, buddyRequestState } from '@weq/service/buddy-request';
import { isDataline, deviceAvatarDataUri } from '../../lib/deviceAvatar';
import { previewNodes, previewNodesToText } from '../../lib/conversationPreview';
import { selfIdentityValues } from '../../lib/selfIdentity';
import { classifyChatType, isGroupTempChatType } from '@weq/codec';
import { contactSenderName, contactTitle } from '../../lib/contactTitle';
import { displayGroupMemberName } from '../../im-template/template/user';
import type {
  Contact,
  Conversation,
  ConversationPreference,
  GroupJoinRequest,
  GroupMember,
  GroupNoticeHandleState,
  User,
} from '../../im-template/template';
import type {
  RecentContactWire,
  UserProfileWire,
  GroupMemberWire,
  BuddyWire,
  CategoryWire,
  BuddyRequestWire,
  GroupNotifyWire,
  GroupDetailWire,
} from './types';

export const fallbackPreference: ConversationPreference = {
  pinned: false,
  muted: false,
  blocked: false,
};

export function groupAvatarSrc(groupCode: string): string | null {
  return groupCode ? `https://p.qlogo.cn/gh/${groupCode}/${groupCode}/0` : null;
}

/** Public-CDN avatar URL for a conversation (undefined -> template fallback). */
export function avatarSrc(
  c: Pick<RecentContactWire, 'chatType' | 'targetUid' | 'targetUin'>,
): string | null {
  // C2C 必须先判：KCHATTYPETEMPC2CFROMGROUP 的名字里同时含 C2C 和 GROUP，先匹配
  // GROUP 会把对方 uid 当群号去拼 p.qlogo.cn，临时会话头像必裂。走 uin 外链才是真人头像。
  if (chatTypeKind(c.chatType) === 'direct') return senderAvatarSrc(c.targetUin);
  if (chatTypeKind(c.chatType) === 'group') return groupAvatarSrc(c.targetUid);
  return null;
}

export function senderAvatarSrc(uin: string): string | null {
  if (!uin || uin === '0') return null;
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`;
}

export function secondsToIsoTime(seconds: number | string | undefined): string | null {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

export function chatTypeKind(chatType: string | number): 'direct' | 'group' | null {
  const kind = classifyChatType(chatType);
  // 数据线（我的手机/我的电脑）按单聊解析，头像用设备图标兜底（isDataline()）。
  if (kind === 'direct' || kind === 'dataline') return 'direct';
  if (kind === 'group') return 'group';
  return null;
}

export function toIsoTime(seconds: string | undefined): string {
  return secondsToIsoTime(seconds) ?? new Date(0).toISOString();
}

export function currentUser(openedUin: string | null, selfProfile?: UserProfileWire | null): User {
  const identityValue = openedUin ?? 'unknown';
  return {
    id: `self:${identityValue}`,
    // 灰条（戳一戳等）里的 `<qq uin=u_…>` 装的是 uid，认「我」要靠它。
    uid: selfProfile?.uid || undefined,
    identityLabel: 'UIN',
    identityValue,
    username: `uin-${identityValue}`,
    displayName: selfProfile?.nick || 'WeQ',
    // Prefer the uin-derived CDN avatar (always resolvable) over the profile
    // DB's stored URL, which is frequently empty or a stale signed link.
    avatarUrl: senderAvatarSrc(identityValue) || selfProfile?.avatarUrl || null,
    signature: selfProfile?.signature || null,
  };
}

export function displayProfileName(profile?: UserProfileWire): string | null {
  if (!profile) return null;
  return profile.remark || profile.nick || profile.qid || profile.uin || null;
}

// function _genderLabel(value?: number): string | null {
//   if (value === 1) return '男';
//   if (value === 2) return '女';
//   return null;
// }

export function buddyToContact(
  buddy: BuddyWire,
  profileByUid: Map<string, UserProfileWire>,
  categoryById: Map<number, CategoryWire>,
  botUids: Set<string>,
): Contact {
  const profile = profileByUid.get(buddy.uid);
  const displayName = displayProfileName(profile) || buddy.qid || buddy.uin || buddy.uid;
  const category = categoryById.get(buddy.categoryId);
  const customStatus = profile?.customStatus?.desc?.trim() || null;

  return {
    id: buddy.uid,
    isFriend: profile?.isFriend,
    friendshipKnown: profile?.friendshipKnown,
    identityLabel: buddy.uin && buddy.uin !== '0' ? 'QQ' : 'UID',
    identityValue: buddy.uin && buddy.uin !== '0' ? buddy.uin : buddy.uid,
    username: buddy.uid,
    displayName,
    kind: botUids.has(buddy.uid) ? 'bot' : 'human',
    avatarUrl: senderAvatarSrc(buddy.uin) || profile?.avatarUrl || null,
    signature: profile?.signature || null,
    sigUpdateTime: profile?.sigUpdateTime,
    createdAt: new Date(0).toISOString(),
    categoryId: buddy.categoryId,
    categoryName: category?.name || null,
    qid: buddy.qid || profile?.qid || null,
    nick: profile?.nick || null,
    remark: profile?.remark || null,
    age: profile?.age,
    gender: profile?.gender,
    birthYear: profile?.birthYear,
    birthMonth: profile?.birthMonth,
    birthDay: profile?.birthDay,
    intimacy: profile?.intimacy,
    extRelation: profile?.extRelation ?? null,
    extInfo: profile?.extInfo ?? null,
    customStatus,
    onlineStatus: customStatus,
  };
}

export function groupDetailToConversation(
  detail: GroupDetailWire,
  fallback?: Conversation | null,
  user?: User,
): Conversation {
  // 没有 recent_contact 行时（群在列表里被删过 / 从没收发过消息）不拿群创建时间
  // 顶替「最后消息时间」——两者语义无关，曾经导致这类群按创建时间在会话列表里
  // 乱序（新建的群创建时间很新，会插到本该排最后的位置）。退化成最旧，交给排序
  // 沉底，与 lastMessage 仍是 null 的事实一致。
  const updatedAt = fallback?.updatedAt ?? new Date(0).toISOString();
  const group = fallback?.type === 'group' ? fallback.group : null;
  const notifyLevel =
    detail.directory?.notifyLevel ??
    (fallback?.type === 'group' ? fallback.notifyLevel : undefined);

  return {
    id: detail.groupCode,
    type: 'group',
    notifyLevel,
    updatedAt,
    otherUser: null,
    group: {
      id: detail.groupCode,
      name: detail.groupName || group?.name || detail.groupCode,
      identityLabel: 'Group',
      identityValue: detail.groupCode,
      avatarUrl: group?.avatarUrl || groupAvatarSrc(detail.groupCode),
      announcement: detail.pinnedAnnounce || group?.announcement || null,
      description: detail.description || null,
      remark: detail.remark || null,
      memberCount: detail.directory?.memberCount ?? detail.memberCount ?? group?.memberCount ?? 0,
      maxMemberCount: detail.maxMemberCount || undefined,
      role:
        detail.directory?.role ??
        (detail.ownerUid === user?.uid ? 'owner' : group?.role || 'member'),
      listed: Boolean(detail.directory),
      membershipKnown: Object.hasOwn(detail, 'directory'),
      roleKnown: Boolean(detail.directory?.role) || detail.ownerUid === user?.uid,
      unnamed: detail.directory?.unnamed ?? false,
      createTime: secondsToIsoTime(detail.createTime),
      labels: detail.labels || null,
      entranceQ: detail.entranceQ || null,
      customLabels: detail.customLabels
        .map((label) => label.content)
        .filter((label): label is string => Boolean(label)),
      customLabelRecords: detail.customLabels,
      addressName: detail.address?.locationName || null,
    },
    members: fallback?.type === 'group' ? fallback.members : [],
    preference: groupDirectoryPreference(
      notifyLevel,
      fallback?.preference,
      detail.directory?.pinned,
    ),
    unreadCount: fallback?.unreadCount ?? 0,
    lastMessage: fallback?.lastMessage ?? null,
  };
}

export function buddyRequestToContactRequest(
  request: BuddyRequestWire,
  profileByUid: Map<string, UserProfileWire>,
) {
  const profile = profileByUid.get(request.peerUid);
  const uin = profile?.uin ?? '';
  const contact: Contact = {
    id: request.peerUid,
    identityLabel: uin && uin !== '0' ? 'QQ' : 'UID',
    identityValue: uin && uin !== '0' ? uin : request.peerUid,
    username: request.peerUid,
    displayName: profile?.nick || profile?.remark || request.nick || request.peerUid,
    avatarUrl: senderAvatarSrc(uin) || profile?.avatarUrl || null,
    signature: profile?.signature || null,
    createdAt: secondsToIsoTime(request.timestamp) ?? new Date(0).toISOString(),
  };

  return {
    id: `buddy-request:${request.peerUid}:${request.timestamp}`,
    direction: buddyRequestDirection(request),
    status: buddyRequestState(request),
    message: request.verifyMsg || null,
    createdAt: contact.createdAt,
    respondedAt: null,
    user: contact,
  } as const;
}

/** 61002 —— 这条群通知在说什么事。 */
export const GROUP_NOTIFY_ACTION: Record<number, string> = {
  1: '申请加入',
  3: '被设置为管理员',
  6: '被移出群聊',
  11: '被管理员拒绝加入',
  13: '退出了群聊',
  15: '被取消管理员权限',
};

/** 61003 —— 这条通知的处理状态。 */
export const GROUP_NOTIFY_HANDLE_STATE: Record<number, GroupNoticeHandleState> = {
  0: 'none',
  1: 'pending',
  2: 'agreed',
  3: 'refused',
};

/** notify 里的一个人（申请人 / 处理人）→ Contact。uin 由 service 层查库补齐。 */
export function groupNotifyUserToContact(
  uid: string,
  uin: string,
  nick: string,
  profileByUid: Map<string, UserProfileWire>,
  createdAt: string,
): Contact {
  const profile = profileByUid.get(uid);
  const hasUin = (v: string | undefined): v is string => !!v && v !== '0';
  const resolvedUin = hasUin(uin) ? uin : hasUin(profile?.uin) ? profile.uin : '';
  return {
    id: uid,
    identityLabel: resolvedUin ? 'QQ' : 'UID',
    identityValue: resolvedUin || uid,
    username: uid,
    displayName: nick || profile?.remark || profile?.nick || resolvedUin || uid,
    avatarUrl: senderAvatarSrc(resolvedUin) || profile?.avatarUrl || null,
    signature: profile?.signature || null,
    createdAt,
  };
}

export function groupNotifyToGroupRequest(
  notify: GroupNotifyWire,
  profileByUid: Map<string, UserProfileWire>,
  groupsById: Map<string, Conversation>,
): GroupJoinRequest | null {
  const { groupUin } = notify;
  if (!/^[1-9]\d*$/.test(groupUin)) return null;
  const conversation = groupsById.get(groupUin);
  const group = conversation?.type === 'group' ? conversation.group : null;

  const createdAt = secondsToIsoTime(notify.msgTime) ?? new Date(0).toISOString();
  const user = groupNotifyUserToContact(
    notify.operatedUid,
    notify.operatedUin,
    notify.operatedNick,
    profileByUid,
    createdAt,
  );
  const handleState = GROUP_NOTIFY_HANDLE_STATE[notify.verifyStatus] ?? 'none';
  // 处理人只在真的有人处理过时才有意义 —— 未处理的申请里 61007 可能残留邀请人。
  const operator =
    notify.operatorUid && (handleState === 'agreed' || handleState === 'refused')
      ? groupNotifyUserToContact(
          notify.operatorUid,
          notify.operatorUin,
          notify.operatorNick,
          profileByUid,
          createdAt,
        )
      : null;

  return {
    id: groupNoticeId(notify),
    handleState,
    action: GROUP_NOTIFY_ACTION[notify.status] ?? '群通知',
    message: notify.remark || null,
    systemRemark: notify.systemRemark || null,
    createdAt,
    respondedAt: notify.opTime > 0 ? secondsToIsoTime(notify.opTime) : null,
    group: {
      id: group?.id ?? groupUin,
      conversationId: groupUin,
      identityLabel: group?.identityLabel ?? '群号',
      identityValue: group?.identityValue ?? groupUin,
      name: notify.groupName || group?.name || groupUin,
      avatarUrl: group?.avatarUrl ?? groupAvatarSrc(groupUin),
      announcement: group?.announcement ?? null,
      memberCount: group?.memberCount ?? 0,
    },
    user,
    operator,
    isDoubt: notify.sourceTable === 'doubt_group_notify_list',
  };
}

// function _groupRequestFromBuddyRequest(
//   request: BuddyRequestWire,
//   groupsById: Map<string, Conversation>,
//   profileByUid: Map<string, UserProfileWire>,
// ) {
//   if (!request.sourceGroupCode || request.sourceGroupCode === '0') return null;
//   const groupConversation = groupsById.get(request.sourceGroupCode);
//   if (groupConversation?.type !== 'group') return null;
//   const contactRequest = buddyRequestToContactRequest(request, profileByUid);
//
//   return {
//     id: `group-request:${request.sourceGroupCode}:${request.peerUid}:${request.timestamp}`,
//     direction: contactRequest.direction,
//     status: contactRequest.status,
//     message: contactRequest.message,
//     createdAt: contactRequest.createdAt,
//     respondedAt: null,
//     group: {
//       id: groupConversation.group.id,
//       conversationId: groupConversation.id,
//       identityLabel: groupConversation.group.identityLabel,
//       identityValue: groupConversation.group.identityValue,
//       name: groupConversation.group.name,
//       avatarUrl: groupConversation.group.avatarUrl,
//       announcement: groupConversation.group.announcement,
//       memberCount: groupConversation.group.memberCount,
//     },
//     user: contactRequest.user,
//   } as const;
// }

export function levelBracketFor(level?: number): number {
  if (level === undefined) return 0;
  if (level <= 10) return 1;
  if (level <= 20) return 2;
  if (level <= 40) return 3;
  if (level <= 60) return 4;
  if (level <= 80) return 5;
  return 6;
}

/**
 * wire 层群成员 → 模板层 GroupMember。「已加载成员分页」和「群内搜索命中」共用同
 * 一份映射，否则搜索结果会丢掉群主 / 等级 / bot 角标（ownerUid 只有群详情里有）。
 */
export function groupMemberWireToMember(
  m: GroupMemberWire,
  ctx: {
    ownerUid?: string;
    levelConfigs: Array<{ level: number; levelName: string }>;
    botUids: ReadonlySet<string>;
    profileByUid: Map<string, UserProfileWire>;
  },
): GroupMember {
  return {
    id: m.uid,
    identityLabel: m.uin && m.uin !== '0' ? 'QQ' : 'UID',
    identityValue: m.uin && m.uin !== '0' ? m.uin : m.uid,
    username: m.uid,
    uin: m.uin,
    card: m.card,
    remark: ctx.profileByUid.get(m.uid)?.remark,
    nick: m.nick || ctx.profileByUid.get(m.uid)?.nick,
    displayName: displayGroupMemberName(
      m.card,
      ctx.profileByUid.get(m.uid)?.remark,
      m.nick || ctx.profileByUid.get(m.uid)?.nick,
      m.uin || m.uid || 'Member',
    ),
    avatarUrl: senderAvatarSrc(m.uin),
    kind: ctx.botUids.has(m.uid) ? 'bot' : 'human',
    role: m.uid === ctx.ownerUid ? 'owner' : m.adminFlag > 0 ? 'admin' : 'member',
    joinedAt: toIsoTime(m.joinTime.toString()),
    lastSpeakAt: secondsToIsoTime(m.lastSpeakTime),
    muteUntil: secondsToIsoTime(m.muteUntil),
    customTitle: m.customTitle || null,
    memberLevel: m.memberLevel,
    memberFlag: m.memberFlag,
    levelName: levelNameFor(ctx.levelConfigs, m.memberLevel),
  };
}

export function levelNameFor(
  levelConfigs: Array<{ level: number; levelName: string }>,
  level?: number,
): string | null {
  if (level === undefined || level === 0) return null;
  const bracket = levelBracketFor(level);
  return levelConfigs.find((item) => item.level === bracket)?.levelName || `Lv${level}`;
}

/**
 * 群聊发起的临时会话的来源群号（60001）；非临时会话 / 值为 0 时返回 null。
 *
 * 发消息要用它：临时会话回复对方必须走 `routingHead.grpTmp`（来源群号 + 对方 uid），
 * 退化成普通 c2c 会被服务端当成非好友消息拒收。
 *
 * **不能只看 60001 非零**：它是会话行的冗余快照，会残留 —— 从群临时会话转成正式
 * 好友后（chatType 100 → 1），来源群号仍留在那一列不清。真正的判据是 chatType 本身
 * 仍是「群里发起的临时会话」（100）；否则和好友的普通私聊会被误判成临时会话，
 * 发文件被拦、标题被冠上「来自 xxx 群」。
 */
export function tempSourceGroupCode(c: RecentContactWire): string | null {
  if (!isGroupTempChatType(c.chatType)) return null;
  const code = c.tempSourceGroupCode;
  return code && code !== '0' ? code : null;
}

/**
 * 群聊发起的临时会话的来源群名（60001 是原始群号）。群不在我的群列表里（退群 /
 * 从未加入）时退化为群号，至少还能认出是哪个群。
 */
export function tempSourceGroupName(
  c: RecentContactWire,
  groupNameByCode: Map<string, string>,
): string | null {
  const code = tempSourceGroupCode(c);
  return code ? groupNameByCode.get(code) || code : null;
}

/** 40051 预览元素的 kind（text / face / grayTip* / …），拿不到返回 null。 */
export function previewElementKind(preview: unknown): string | null {
  if (!preview || typeof preview !== 'object') return null;
  const kind = (preview as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}

export function contactToConversation(
  c: RecentContactWire,
  user: User,
  groupNameByCode: Map<string, string>,
  botUids: Set<string>,
  displayNames: ReadonlyMap<string, string> = new Map(),
  groupNames: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
  profiles: ReadonlyMap<string, Pick<UserProfileWire, 'nick' | 'remark'>> = new Map(),
): Conversation | null {
  const kind = chatTypeKind(c.chatType);
  const title = contactTitle(c, profiles.get(c.targetUid));
  // 「自己」的身份集合：戳一戳灰条的预览里我这半只带 uid，需要它才能渲染成「你」。
  const names = new Map<string, string>();
  const memberNames = kind === 'group' ? groupNames.get(c.targetUid) : undefined;
  const senderName = contactSenderName(c, displayNames, memberNames);
  if (
    c.senderUid &&
    senderName &&
    !(/^\d+$/.test(senderName) && (memberNames?.get(c.senderUid) || displayNames.get(c.senderUid)))
  )
    names.set(c.senderUid, senderName);
  if (kind === 'direct' && title !== c.targetUid && title !== c.targetUin) {
    names.set(c.targetUid, title);
    if (c.targetUin && c.targetUin !== '0') names.set(c.targetUin, title);
  }
  const nodes = previewNodes(c.preview, new Set(selfIdentityValues(user)), {
    get: (id) => names.get(id) || memberNames?.get(id) || displayNames.get(id),
  });
  const preview = previewNodesToText(nodes) || null;
  const updatedAt = toIsoTime(c.sendTime);
  const preference: ConversationPreference = {
    ...fallbackPreference,
    muted: mutedFromNotifyLevel(c.notifyLevel),
  };
  const lastMessage = {
    id: `preview:${c.targetUid}:${c.sendTime}`,
    senderId: c.senderUid || null,
    senderDisplayName: senderName || null,
    // 预览元素的 kind：灰条（grayTip*）在列表里只显示内容、不加"昵称："前缀。
    kind: previewElementKind(c.preview),
    body: preview,
    previewNodes: nodes.length ? nodes : null,
    createdAt: updatedAt,
  };

  if (kind === 'direct') {
    const device = isDataline(c.chatType);
    const otherUser: User = {
      id: c.targetUid,
      identityLabel: device ? '设备' : c.targetUin && c.targetUin !== '0' ? 'QQ' : 'UID',
      identityValue: !device && c.targetUin && c.targetUin !== '0' ? c.targetUin : c.targetUid,
      username: c.targetUid,
      displayName: title,
      kind: botUids.has(c.targetUid) ? 'bot' : 'human',
      avatarUrl: device ? deviceAvatarDataUri(c.targetUid) : avatarSrc(c),
    };

    return {
      id: c.targetUid,
      type: 'direct',
      updatedAt,
      otherUser,
      group: null,
      members: [],
      preference,
      unreadCount: 0,
      lastMessage,
      chatType: c.chatType,
      tempSourceGroupName: tempSourceGroupName(c, groupNameByCode),
      tempSourceGroupCode: tempSourceGroupCode(c),
    };
  }

  if (kind === 'group') {
    return {
      id: c.targetUid,
      type: 'group',
      notifyLevel: c.notifyLevel,
      updatedAt,
      otherUser: null,
      group: {
        id: c.targetUid,
        name:
          !c.targetDisplayName && !c.targetRemark
            ? groupNameByCode.get(c.targetUid) || title
            : title,
        identityLabel: 'Group',
        identityValue: c.targetUid,
        avatarUrl: avatarSrc(c),
        announcement: null,
        memberCount: 0,
        role: 'member',
        listed: false,
        membershipKnown: false,
        roleKnown: false,
      },
      members: [],
      preference,
      unreadCount: 0,
      lastMessage,
    };
  }

  return null;
}
