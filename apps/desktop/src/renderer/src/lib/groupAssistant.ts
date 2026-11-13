import type { Conversation, ConversationPreferences } from '../im-template/template/types';
import {
  accountBinding,
  isAccountStateReady,
  saveAccountRecords,
  sharedAccountRecords,
} from './clientPreferences';

export type GroupAssistantPins = Record<string, boolean>;

export function sidebarConversationsWithoutAssistant(
  conversations: Conversation[],
  assistantIds: ReadonlySet<string>,
): Conversation[] {
  // 临时打开只改变聊天选中态，不能改变 QQ 群助手的归属。
  return conversations.filter((row) => row.type !== 'group' || !assistantIds.has(row.id));
}

export function isAssistantPinned(
  row: Pick<Conversation, 'id' | 'preference'>,
  pins: GroupAssistantPins,
): boolean {
  return pins[row.id] ?? row.preference?.pinned ?? false;
}

/** 群助手只覆盖分类内置顶，免打扰等仍保留会话来源和显式本地偏好。 */
export function groupAssistantPreferences(
  rows: readonly Conversation[],
  preferences: ConversationPreferences,
  pins: GroupAssistantPins,
): ConversationPreferences {
  return {
    ...preferences,
    ...Object.fromEntries(
      rows.map((row) => {
        const current = {
          pinned: false,
          muted: false,
          blocked: false,
          ...row.preference,
          ...preferences[row.id],
        };
        return [row.id, { ...current, pinned: isAssistantPinned(row, pins) }];
      }),
    ),
  };
}

export function loadGroupAssistantPins(account: string): GroupAssistantPins {
  if (isAccountStateReady() && accountBinding()?.expectedAccountUin === account)
    return Object.fromEntries(
      Object.entries(sharedAccountRecords('pins')).filter(
        (row): row is [string, boolean] => typeof row[1] === 'boolean',
      ),
    );
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(`weq:group-assistant-pins:${account}`) ?? '{}',
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([id, pinned]) => /^\d+$/.test(id) && typeof pinned === 'boolean',
      ),
    );
  } catch {
    return {};
  }
}

export function saveGroupAssistantPins(account: string, pins: GroupAssistantPins): void {
  window.localStorage.setItem(`weq:group-assistant-pins:${account}`, JSON.stringify(pins));
  if (accountBinding()?.expectedAccountUin === account) saveAccountRecords('pins', pins);
}
