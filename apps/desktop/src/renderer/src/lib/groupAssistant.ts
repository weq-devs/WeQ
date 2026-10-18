import type { Conversation } from '../im-template/template/types';

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

export function loadGroupAssistantPins(account: string): GroupAssistantPins {
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
}
