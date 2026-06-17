// @ts-nocheck
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

export type Contact = User & {
	createdAt: string;
	categoryId?: number;
	categoryName?: string | null;
	qid?: string | null;
	remark?: string | null;
	age?: number;
	gender?: number;
	signature?: string | null;
	intimacy?: number;
	customStatus?: string | null;
	onlineStatus?: string | null;
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

type ConversationBase = {
	id: string;
	updatedAt: string;
	preference?: ConversationPreference;
	unreadCount?: number;
	lastMessage: {
		id: string;
		senderId: string | null;
		senderDisplayName?: string | null;
		body: string | null;
		createdAt: string | undefined;
	} | null;
};

export type DirectConversation = ConversationBase & {
	type: "direct";
	otherUser: User;
	group: null;
	members: [];
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

export type GroupJoinRequest = {
	id: string;
	direction: "incoming" | "outgoing";
	status: "pending" | "accepted" | "rejected" | "cancelled";
	message: string | null;
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
};

export type MainView = "messages" | "contacts" | "tools";
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
