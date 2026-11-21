import {
  changePreference,
  preferenceValue,
  useClientPreferences,
} from '../../lib/clientPreferences';
import { Toggle } from './controls';
import type { PreferenceKey } from '@weq/service/client-preferences';

export function SharedDisplayToggle({
  name,
  label,
  fallback,
  disabled,
}: {
  name: {
    [K in PreferenceKey]: import('@weq/service/client-preferences').PreferenceValues[K] extends boolean
      ? K
      : never;
  }[PreferenceKey];
  label: string;
  fallback?: boolean;
  disabled?: boolean;
}) {
  useClientPreferences((state) => state.tick);
  return (
    <Toggle
      label={label}
      disabled={disabled}
      checked={preferenceValue(name, fallback)}
      onChange={(value) => void changePreference(name, value)}
    />
  );
}
