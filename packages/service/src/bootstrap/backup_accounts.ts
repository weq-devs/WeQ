import { ClientStateStore, validateClientState } from './client_state';
import { isDefaultModelSelection } from '@weq/agentlab';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  INTENT_TUNING_KEYS,
  isIntentTuningValue,
  validateSuggestionFallbackTexts,
} from '../common/intent_context';
import {
  WEQ_ACCOUNT_SETTING_FILES,
  isWeqBackgroundName,
  type WeqAccountSettingFile,
} from '../common/backup_account_paths';
import { parseWeqBackupJson, type WeqBackupFile } from './backup_bundle';
import { readWeqBackupFile } from './backup_clones';

function fail(name: string): never {
  throw new Error(`账号偏好备份无效：${name}`);
}
function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(name);
  return value as Record<string, unknown>;
}
function strings(value: unknown, name: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail(name);
}
function bools(value: Record<string, unknown>, names: string[], where: string) {
  for (const key of names)
    if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(`${where}.${key}`);
}

export function weqAccountSettingPath(
  root: string,
  cache: string,
  scope: string,
  name: WeqAccountSettingFile,
): string {
  if (name === 'dress.json' || name === 'client-state.json')
    return join(root, 'config', 'accounts', scope, name);
  const category =
    name === 'anti-recall.json'
      ? 'anti_recall'
      : name === 'intent.json'
        ? 'intent_sense'
        : 'db_tolerance';
  return join(cache, category, scope, 'config.json');
}

export function validateWeqAccountPreference(name: WeqAccountSettingFile, value: unknown): void {
  if (name === 'client-state.json') {
    validateClientState(value);
    return;
  }
  const input = record(value, name);
  if (name === 'anti-recall.json') {
    bools(input, ['enabled', 'notifyEnabled'], name);
    if (input.mode !== undefined && input.mode !== 'all' && input.mode !== 'selected') fail(name);
    if (input.targets !== undefined) {
      if (!Array.isArray(input.targets)) fail(name);
      for (const target of input.targets) {
        const entry = record(target, name);
        if (
          typeof entry.id !== 'string' ||
          !['c2c', 'group', 'dataline'].includes(String(entry.kind))
        )
          fail(name);
      }
    }
    if (input.notifyTargets !== undefined) strings(input.notifyTargets, name);
  } else if (name === 'tolerance.json') {
    if (input.level !== undefined && ![0, 1, 2, 3].includes(Number(input.level))) fail(name);
    if (input.level !== undefined && typeof input.level !== 'number') fail(name);
    if (
      input.grantedAt !== undefined &&
      (typeof input.grantedAt !== 'string' || !Number.isFinite(Date.parse(input.grantedAt)))
    )
      fail(name);
  } else if (name === 'intent.json') {
    bools(
      input,
      [
        'enabled',
        'profileEnabled',
        'suggestionsEnabled',
        'analyzeAfterSelf',
        'suggestAfterSelf',
        'persistentDisplay',
        'hoverDisplay',
        'loadingAnimation',
        'suggestionFallbackEnabled',
        'hfMirror',
      ],
      name,
    );
    if (input.suggestionFallbackTexts !== undefined) {
      try {
        validateSuggestionFallbackTexts(input.suggestionFallbackTexts);
      } catch {
        fail(`${name}.suggestionFallbackTexts`);
      }
    }
    if (input.engine !== undefined && input.engine !== 'api' && input.engine !== 'local')
      fail(name);
    if (
      input.profileEngine !== undefined &&
      !['follow', 'api', 'local', 'heuristic'].includes(String(input.profileEngine))
    )
      fail(name);
    if (
      input.featureSettingsVersion !== undefined &&
      input.featureSettingsVersion !== 1 &&
      input.featureSettingsVersion !== 2
    )
      fail(name);
    for (const key of INTENT_TUNING_KEYS)
      if (input[key] !== undefined && !isIntentTuningValue(key, input[key])) fail(`${name}.${key}`);
    for (const key of ['providerRef', 'profileProviderRef', 'suggestionProviderRef'])
      if (input[key] !== undefined && input[key] !== null) {
        const ref = record(input[key], `${name}.${key}`);
        if (isDefaultModelSelection(ref)) continue;
        if ('useDefault' in ref) fail(`${name}.${key}`);
        if (typeof ref.providerId !== 'string' || typeof ref.model !== 'string')
          fail(`${name}.${key}`);
      }
    if (input.conversationOverrides !== undefined)
      for (const enabled of Object.values(record(input.conversationOverrides, name)))
        if (typeof enabled !== 'boolean') fail(name);
  } else {
    for (const key of ['installedBubbles', 'installedFonts', 'installedWidgets'])
      if (
        input[key] !== undefined &&
        (!Array.isArray(input[key]) ||
          input[key].some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0))
      )
        fail(`${name}.${key}`);
    for (const key of ['activeBubble', 'activeFont', 'activeWidget'])
      if (
        input[key] !== undefined &&
        (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || input[key] < 0)
      )
        fail(`${name}.${key}`);
    for (const key of ['bubbleMeta', 'fontMeta', 'widgetMeta'])
      if (input[key] !== undefined)
        for (const metadata of Object.values(record(input[key], name))) {
          const entry = record(metadata, name);
          for (const field of ['name', 'previewUrl'])
            if (entry[field] !== undefined && typeof entry[field] !== 'string') fail(name);
        }
    if (input.scope !== undefined && input.scope !== 'mine' && input.scope !== 'all') fail(name);
    if (
      input.background !== undefined &&
      !['none', 'qq', 'custom'].includes(String(input.background))
    )
      fail(name);
    if (
      input.backgroundFile !== undefined &&
      (typeof input.backgroundFile !== 'string' ||
        (input.backgroundFile !== '' && !isWeqBackgroundName(input.backgroundFile)))
    )
      fail(`${name}.backgroundFile`);
    if (input.widgetId !== undefined && typeof input.widgetId !== 'string') fail(name);
    if (
      input.backgroundOpacity !== undefined &&
      (typeof input.backgroundOpacity !== 'number' ||
        !Number.isFinite(input.backgroundOpacity) ||
        input.backgroundOpacity < 0 ||
        input.backgroundOpacity > 1)
    )
      fail(name);
  }
}

export function snapshotWeqAccountPreferences(
  root: string,
  cache: string,
  scope: string,
): { files: WeqBackupFile[]; warnings: string[] } {
  const files: WeqBackupFile[] = [],
    warnings: string[] = [];
  for (const name of WEQ_ACCOUNT_SETTING_FILES) {
    if (name === 'dress.json') continue;
    const path = weqAccountSettingPath(root, cache, scope, name);
    const value = existsSync(path)
      ? name === 'client-state.json'
        ? new ClientStateStore(path).exportState()
        : parseWeqBackupJson(readWeqBackupFile(path))
      : name === 'client-state.json'
        ? { revision: 0, values: {}, records: {}, drafts: {} }
        : {};
    const input = record(value, name);
    if (name === 'intent.json')
      for (const key of Object.keys(input)) if (key !== 'conversationOverrides') delete input[key];
    if (name === 'anti-recall.json')
      for (const key of Object.keys(input))
        if (key !== 'targets' && key !== 'notifyTargets') delete input[key];
    if (name === 'client-state.json' && input.records && typeof input.records === 'object')
      delete (input.records as Record<string, unknown>).order;
    validateWeqAccountPreference(name, input);
    files.push({ path: `accounts/${scope}/${name}`, data: Buffer.from(JSON.stringify(input)) });
  }
  return { files, warnings };
}
