import { create } from 'zustand';
import { changePreference, preferenceValue, PREFERENCES_CHANGED } from '../lib/clientPreferences';

const KEY = 'weq:web-notifications';
function initialEnabled(): boolean {
  try {
    return preferenceValue(
      'webNotifications',
      typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === 'true',
    );
  } catch {
    return false;
  }
}
export const useWebNotices = create<{ enabled: boolean; set: (enabled: boolean) => void }>(
  (set) => ({
    enabled: initialEnabled(),
    set: (enabled) => {
      try {
        localStorage.setItem(KEY, String(enabled));
      } catch {
        /* 私密浏览仍保留本次偏好。 */
      }
      set({ enabled });
      void changePreference('webNotifications', enabled);
    },
  }),
);
if (typeof window !== 'undefined')
  window.addEventListener(PREFERENCES_CHANGED, () =>
    useWebNotices.setState({ enabled: initialEnabled() }),
  );
