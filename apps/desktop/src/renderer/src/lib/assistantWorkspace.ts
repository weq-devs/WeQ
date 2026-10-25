const key = (account: string, kind: string) =>
  `weq:assistant:${encodeURIComponent(account)}:${kind}`;

export function readAssistantSession(account: string): string | null {
  try {
    return window.localStorage.getItem(key(account, 'selected')) || null;
  } catch {
    return null;
  }
}

export function rememberAssistantSession(account: string, sessionId: string | null): void {
  try {
    if (sessionId) window.localStorage.setItem(key(account, 'selected'), sessionId);
    else window.localStorage.removeItem(key(account, 'selected'));
  } catch {
    /* 存储不可用时仍可在当前窗口使用。 */
  }
}

export function readAssistantDraft(account: string, sessionId: string | null): string {
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
    if (draft) window.localStorage.setItem(storageKey, draft);
    else window.localStorage.removeItem(storageKey);
  } catch {
    /* 不让浏览器配额或隐私设置打断输入。 */
  }
}
