import {
  currentAccountScope,
  isAccountStateReady,
  saveAccountRecords,
  sharedAccountRecords,
} from './clientPreferences';

const storageKey = (scope: string) => `weq:workspace-read:v1:${encodeURIComponent(scope)}:tasks`;

export function readTaskResults(scope: string): Record<string, string> {
  if (isAccountStateReady() && scope === currentAccountScope())
    return Object.fromEntries(
      Object.entries(sharedAccountRecords('tasks')).filter(
        (row): row is [string, string] => typeof row[1] === 'string',
      ),
    );
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey(scope)) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

export function rememberTaskResults(scope: string, results: Record<string, string>): void {
  if (scope === currentAccountScope()) saveAccountRecords('tasks', results);
  try {
    const key = storageKey(scope);
    if (Object.keys(results).length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    const serialized = JSON.stringify(results);
    if (window.localStorage.getItem(key) !== serialized)
      window.localStorage.setItem(key, serialized);
  } catch {
    /* 存储禁用或写满时仍保留本窗口的已读状态。 */
  }
}
