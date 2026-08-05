// @ts-nocheck
import type { PreviewNode } from "../../lib/conversationPreview";

export type User = {
	id: string;
	identityLabel: string;
	identityValue: string;
	username: string;
	displayName: string;
	avatarUrl: string | null;
	signature?: string | null;
	kind?: "human" | "bot";
};

/** profile_info_v6 21000 列解出的资料扩展信息（特权/互动标识/教育/所在地/兴趣/空间相册）。 */
export type ProfileExtInfo = {
	interactMarks: Array<{ type?: string; markId?: number; iconUrl?: string }>;
	privileges: Array<{
		bizId?: number;
		level?: number;
		opened: boolean;
		iconUrl?: string;
		jumpUrl?: string;
	}>;
	school?: string;
	degree?: string;
	country?: string;
	province?: string;
	city?: string;
	interests: string[];
	album: Array<{
		photoId?: string;
		time?: number;
		urls: Array<{ size?: number; url?: string }>;
	}>;
};

/**
 * 在线状态（service 的 FormattedOnlineStatus 在模板层的结构副本）。模板层不依赖
 * service，所以这里按结构声明而非直接 import。
 */
export type OnlineStatusInfo = {
	uid: string;
	uin: string;
	type: number;
	typeName: string;
	subType: number;
	subTypeName: string;
	displayStatus: string;
	weather?: {
		weather: string;
		city: string;
		area: string;
		weatherDesc: string;
	};
};

export type Contact = User & {
	createdAt: string;
	categoryId?: number;
	categoryName?: string | null;
	qid?: string | null;
	nick?: string | null;
	remark?: string | null;
	age?: number;
	gender?: number;
	birthYear?: number;
	birthMonth?: number;
	birthDay?: number;
	signature?: string | null;
	intimacy?: number;
	customStatus?: string | null;
	onlineStatus?: string | null;
	onlineStatusObj?: OnlineStatusInfo;
	/** 扩展（密友）关系：displayId 为当前展示的关系，preselectedIds 为预设标签。 */
	extRelation?: { preselectedIds: number[]; displayId?: number } | null;
	/** 21000 列：特权 logo、所在城市、教育经历、兴趣标签、QQ空间相册。 */
	extInfo?: ProfileExtInfo | null;
};

export type GroupMemberRole = "owner" | "admin" | "member";

export type GroupMember = User & {
	role: GroupMemberRole;
	joinedAt: string;
	lastSpeakAt?: string | null;
	muteUntil?: string | null;
	customTitle?: string | null;
	memberLevel?: number;
	levelName?: string | null;
};

export type ConversationHighlightKind =
	| "atMe"
	| "atAll"
	| "replyMe"
	| "specialCare"
	| "newFile"
	| "redPacket"
	| "unknown";

export type ConversationHighlight = {
	kind: ConversationHighlightKind;
	rawKind: number;
	senderUid: string;
	msgSeq: string;
};

type ConversationBase = {
	id: string;
	updatedAt: string;
	preference?: ConversationPreference;
	unreadCount?: number;
	/**
	 * 提醒高亮标记（特别关心 / @我 / …）：该会话存在对应类别的未读时置位，
	 * 来自 msg_unread_info_table 的 48902 高亮扩展。msgSeq 保留但不展示。
	 */
	highlights?: ConversationHighlight[] | null;
	lastMessage: {
		id: string;
		senderId: string | null;
		senderDisplayName?: string | null;
		body: string | null;
		/**
		 * 预览的富节点形式（文本 + 表情），由 lib/conversationPreview 从 40051
		 * 解析而来。会话列表优先渲染它，这样「看出来了 /斜眼笑」能把表情画出来。
		 * `body` 是同一份内容的纯文本，搜索 / @我 检测仍走它。
		 */
		previewNodes?: PreviewNode[] | null;
		createdAt: string | undefined;
	} | null;
};

export type DirectConversation = ConversationBase & {
	type: "direct";
	otherUser: User;
	group: null;
	members: [];
	chatType?: string | number;
	/**
	 * 群聊发起的临时会话的来源群名（60001 → 群列表解析）。群不在我的群列表里时
	 * 退化为群号；非临时会话为空。
	 */
	tempSourceGroupName?: string | null;
};

export type GroupConversation = ConversationBase & {
	type: "group";
	otherUser: null;
	group: {
		id: string;
		name: string;
		identityLabel: string;
		identityValue: string;
		avatarUrl: string | null;
		announcement: string | null;
		description?: string | null;
		remark?: string | null;
		memberCount: number;
		maxMemberCount?: number;
		role: GroupMemberRole;
		createTime?: string | null;
		labels?: string | null;
		entranceQ?: string | null;
		customLabels?: string[];
		addressName?: string | null;
		bulletins?: Array<{
			id: string;
			text: string;
			createdAt: string;
			publisherUid: string;
		}>;
		essenceMessages?: Array<{
			id: string;
			msgSeq: number;
			senderName: string;
			operatorName: string;
			createdAt: string;
			active: boolean;
		}>;
		levelConfigs?: Array<{
			level: number;
			name: string;
		}>;
	};
	members: GroupMember[];
};

export type Conversation = DirectConversation | GroupConversation;

export type MessageAction = {
	id: string;
	label: string;
	value?: string;
	style?: "default" | "primary" | "danger";
};

export type Message = {
	id: string;
	conversationId: string;
	senderId: string;
	body: string;
	actions?: MessageAction[];
	streamStatus?: "complete" | "streaming" | "failed";
	createdAt: string;
	sender?: User;
};

export type InvitePreview = {
	id: string;
	inviter: User;
	expiresAt: string;
	used: boolean;
	expired: boolean;
};

export type ContactSearchResult = {
	user: User;
	relation: "self" | "contact" | "none" | "outgoing" | "incoming";
	conversationId: string | null;
	requestId: string | null;
};

export type GroupSearchResult = {
	group: {
		id: string;
		conversationId: string;
		identityLabel: string;
		identityValue: string;
		name: string;
		avatarUrl: string | null;
		announcement: string | null;
		memberCount: number;
	};
	relation: "member" | "none" | "outgoing";
	requestId: string | null;
};

export type ContactRequest = {
	id: string;
	direction: "incoming" | "outgoing";
	status: "pending" | "accepted" | "rejected" | "cancelled";
	message: string | null;
	createdAt: string;
	respondedAt: string | null;
	user: User;
};

/** 群通知的处理状态（QQ 61003 列）。 */
export type GroupNoticeHandleState = "none" | "pending" | "agreed" | "refused";

export type GroupJoinRequest = {
	id: string;
	/** 61003：无需处理 / 待处理 / 已同意 / 已拒绝。 */
	handleState: GroupNoticeHandleState;
	/** 这条通知在说什么（申请加入 / 退出群聊 / 被移出…）。 */
	action: string;
	/** 入群问答（"问题：… 答案：…"）等附言，无则 null。 */
	message: string | null;
	/** 风险提示等系统备注，无则 null。 */
	systemRemark: string | null;
	createdAt: string;
	respondedAt: string | null;
	group: {
		id: string;
		conversationId: string;
		identityLabel: string;
		identityValue: string;
		name: string;
		avatarUrl: string | null;
		announcement: string | null;
		memberCount: number;
	};
	user: User;
	/** 61007：处理这条通知的管理员，未处理时为 null。 */
	operator: User | null;
	isDoubt?: boolean;
};

export type MainView = "home" | "messages" | "contacts" | "export" | "agentlab" | "cache" | "tools" | "qzone" | "channel";
export type ContactTab = "friends" | "groups";
export type ContactNoticeView = "friend" | "group";
export type SettingsTab = "general" | "notifications" | "account";

export type ConversationPreference = {
	pinned: boolean;
	muted: boolean;
	blocked: boolean;
};

export type ConversationPreferences = Record<string, ConversationPreference>;
export type ConversationDrafts = Record<string, string>;
