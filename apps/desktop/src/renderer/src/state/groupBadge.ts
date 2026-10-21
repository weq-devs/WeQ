import { create } from 'zustand';

export const GROUP_BADGE_STORAGE_KEY = 'weq.group-badge-display.v1';
export interface GroupBadgeDisplay {
  showTitle: boolean;
  showLevel: boolean;
}
export const DEFAULT_GROUP_BADGE_DISPLAY: Readonly<GroupBadgeDisplay> = {
  showTitle: true,
  showLevel: true,
};
type Preferences = Record<string, GroupBadgeDisplay>;

function validKey(key: string): boolean {
  try {
    const scope: unknown = JSON.parse(key);
    return (
      Array.isArray(scope) &&
      scope.length === 2 &&
      scope.every((part) => typeof part === 'string' && part.length > 0)
    );
  } catch {
    return false;
  }
}

function validDisplay(value: unknown): value is GroupBadgeDisplay {
  return (
    value !== null &&
    typeof value === 'object' &&
    'showTitle' in value &&
    typeof value.showTitle === 'boolean' &&
    'showLevel' in value &&
    typeof value.showLevel === 'boolean'
  );
}

export function groupBadgeKey(uin: string | null, groupId: string): string | null {
  return uin && groupId ? JSON.stringify([uin, groupId]) : null;
}

export function parseGroupBadgePreferences(raw: string | null): Preferences {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const preferences: Preferences = {};
    for (const [key, entry] of Object.entries(value)) {
      if (validKey(key) && validDisplay(entry))
        preferences[key] = { showTitle: entry.showTitle, showLevel: entry.showLevel };
    }
    return preferences;
  } catch {
    return {};
  }
}

function readPreferences(): Preferences {
  try {
    return parseGroupBadgePreferences(localStorage.getItem(GROUP_BADGE_STORAGE_KEY));
  } catch {
    return {};
  }
}

export const useGroupBadgeDisplay = create<{
  preferences: Preferences;
  setDisplay: (key: string, patch: Partial<GroupBadgeDisplay>) => void;
  reload: () => void;
}>((set) => ({
  preferences: readPreferences(),
  setDisplay(key, patch) {
    if (!validKey(key)) throw new Error('无效的群显示偏好目标');
    // 先读取落盘值，避免独立窗口覆盖其他群刚保存的偏好；保存失败不伪装成功。
    const preferences = readPreferences();
    preferences[key] = { ...DEFAULT_GROUP_BADGE_DISPLAY, ...preferences[key], ...patch };
    if (preferences[key].showTitle && preferences[key].showLevel) delete preferences[key];
    localStorage.setItem(GROUP_BADGE_STORAGE_KEY, JSON.stringify(preferences));
    set({ preferences });
  },
  reload: () => set({ preferences: readPreferences() }),
}));

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === GROUP_BADGE_STORAGE_KEY || event.key === null)
      useGroupBadgeDisplay.getState().reload();
  });
}
