import { useSyncExternalStore } from 'react';
import { changePreference, preferenceValue, PREFERENCES_CHANGED } from '../lib/clientPreferences';
import { CALENDAR_SOURCE_ORDER, type CalendarKind } from '@weq/service/conversation-calendar';

export const CALENDAR_KINDS_KEY = 'weq.calendar.kinds';
const listeners = new Set<() => void>();
let previous: string | null | undefined;
let selected = [...CALENDAR_SOURCE_ORDER];
function snapshot(): CalendarKind[] {
  let raw: string | null = null;
  try {
    raw = JSON.stringify(
      preferenceValue(
        'calendar',
        JSON.parse(localStorage.getItem(CALENDAR_KINDS_KEY) ?? 'null') ?? [
          ...CALENDAR_SOURCE_ORDER,
        ],
      ),
    );
  } catch {
    return selected;
  }
  if (raw !== previous) {
    previous = raw;
    try {
      const value: unknown = raw === null ? null : JSON.parse(raw);
      selected = Array.isArray(value)
        ? CALENDAR_SOURCE_ORDER.filter((kind) => value.includes(kind))
        : [...CALENDAR_SOURCE_ORDER];
    } catch {
      selected = [...CALENDAR_SOURCE_ORDER];
    }
  }
  return selected;
}
function subscribe(notify: () => void) {
  listeners.add(notify);
  const changed = (event: StorageEvent) => {
    if (!event.key || event.key === CALENDAR_KINDS_KEY) notify();
  };
  window.addEventListener('storage', changed);
  window.addEventListener(PREFERENCES_CHANGED, notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener('storage', changed);
    window.removeEventListener(PREFERENCES_CHANGED, notify);
  };
}
export function setCalendarKinds(kinds: CalendarKind[]): void {
  void changePreference('calendar', kinds);
  selected = CALENDAR_SOURCE_ORDER.filter((kind) => kinds.includes(kind));
  const raw = JSON.stringify(selected);
  try {
    localStorage.setItem(CALENDAR_KINDS_KEY, raw);
    previous = raw;
  } catch {
    /* 无持久化存储时保留本窗口选择。 */
  }
  for (const notify of listeners) notify();
}
export function useCalendarKinds(): [CalendarKind[], typeof setCalendarKinds] {
  return [useSyncExternalStore(subscribe, snapshot), setCalendarKinds];
}
