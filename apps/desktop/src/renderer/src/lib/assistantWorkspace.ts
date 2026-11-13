import { forgetClientRetry } from './clientPreferences';

const key = (account: string, kind: string) =>
  `weq:assistant:${encodeURIComponent(account)}:${kind}`;
const deletedSessions = new Map<string, Set<string>>();

export function isAssistantSessionDeleted(account: string, sessionId: string | null): boolean {
  return Boolean(sessionId && deletedSessions.get(account)?.has(sessionId));
}

export function isAssistantDraftDeleted(account: string, draftKey: string): boolean {
  return (
    draftKey.startsWith('assistant:') &&
    draftKey !== 'assistant:new' &&
    isAssistantSessionDeleted(account, draftKey.slice('assistant:'.length))
  );
}

/** 本轮删除不允许迟到的输入效果、重试或旧搜索命中重新接续这段会话。 */
export function markAssistantSessionDeleted(account: string, sessionId: string): void {
  const deleted = deletedSessions.get(account) ?? new Set<string>();
  deleted.add(sessionId);
  deletedSessions.set(account, deleted);
  forgetClientRetry(`assistant:${account}:assistant:${sessionId}`);
  try {
    window.localStorage.removeItem(key(account, `draft:${sessionId}`));
    window.localStorage.removeItem(`weq.sync.draft-base:${account}:assistant:${sessionId}`);
    if (window.localStorage.getItem(key(account, 'selected')) === sessionId)
      window.localStorage.removeItem(key(account, 'selected'));
  } catch {
    /* 删除标记仍在内存中生效，不依赖浏览器缓存可写。 */
  }
}

export function readAssistantSession(account: string): string | null {
  try {
    const sessionId = window.localStorage.getItem(key(account, 'selected')) || null;
    return isAssistantSessionDeleted(account, sessionId) ? null : sessionId;
  } catch {
    return null;
  }
}

export function rememberAssistantSession(account: string, sessionId: string | null): void {
  if (isAssistantSessionDeleted(account, sessionId)) return;
  try {
    if (sessionId) window.localStorage.setItem(key(account, 'selected'), sessionId);
    else window.localStorage.removeItem(key(account, 'selected'));
  } catch {
    /* 存储不可用时仍可在当前窗口使用。 */
  }
}

export function readAssistantDraft(account: string, sessionId: string | null): string {
  if (isAssistantSessionDeleted(account, sessionId)) return '';
  try {
    return window.localStorage.getItem(key(account, `draft:${sessionId ?? 'new'}`)) ?? '';
  } catch {
    return '';
  }
}

export function rememberAssistantDraft(
  account: string,
  sessionId: string | null,
  draft: string,
): void {
  try {
    const storageKey = key(account, `draft:${sessionId ?? 'new'}`);
    if (draft && !isAssistantSessionDeleted(account, sessionId))
      window.localStorage.setItem(storageKey, draft);
    else window.localStorage.removeItem(storageKey);
  } catch {
    /* 不让浏览器配额或隐私设置打断输入。 */
  }
}
