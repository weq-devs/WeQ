import { createContext } from 'react';
import type { SettingsResetCardId, SettingsResetTarget } from '../../../../shared/settings_reset';
export interface ResetSave {
  readonly keys?: readonly string[];
  suspend: () => Promise<void>;
  reset: () => void;
  release: () => void;
}
export const SettingsResetCardContext = createContext<Set<ResetSave> | null>(null);
export const SettingsResetContext = createContext<{
  page: SettingsResetTarget['page'];
  open: (target: SettingsResetTarget) => void;
  saves: (card: SettingsResetCardId) => Set<ResetSave>;
} | null>(null);
