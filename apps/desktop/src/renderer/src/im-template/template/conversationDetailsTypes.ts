// @ts-nocheck
import type { Conversation } from "./types";

export type GroupConversationView = Extract<Conversation, { type: "group" }>;

export type GroupUpdateInput = {
	name?: string;
	announcement?: string | null;
	avatar?: { source: "none" } | { source: "github" | "weavatar"; ref: string };
};
