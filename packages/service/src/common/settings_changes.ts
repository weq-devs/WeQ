import { isDeepStrictEqual } from 'node:util';
import type { SharedPreferences } from './shared_preferences';

export interface SettingsChange {
  fields: string[];
  groups: string[];
  clientFields: string[];
}

function changedFields(before: object = {}, after: object = {}): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => !isDeepStrictEqual(Reflect.get(before, key), Reflect.get(after, key)),
  );
}

type SettingsValues = { sharedPreferences?: SharedPreferences };

/** 广播只携带字段名；接收方按实际依赖刷新。 */
export function diffSettings(
  before: SettingsValues = {},
  after: SettingsValues = {},
): SettingsChange {
  const { sharedPreferences: previous, ...oldFields } = before;
  const { sharedPreferences: next, ...newFields } = after;
  return {
    fields: changedFields(oldFields, newFields),
    groups: changedFields(previous, next),
    clientFields: changedFields(previous?.client, next?.client),
  };
}

type SettingsListener = (change?: SettingsChange) => void;
const listeners = new Set<SettingsListener>();
export function onSettingsChanged(listener: SettingsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function emitSettingsChanged(change?: SettingsChange): void {
  for (const listener of listeners) listener(change);
}
