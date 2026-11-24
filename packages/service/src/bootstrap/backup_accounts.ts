import { ClientStateStore, validateClientState } from './client_state';
import { isDefaultModelSelection } from '@weq/agentlab';
import { existsSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative } from 'node:path';
import { DRAFT_MEDIA_DIR, isDraftImageName, mapDraftImagePaths } from '../common/draft_media';
import { MAX_SHARED_DRAFT_IMAGE_BYTES } from '../common/client_preferences';
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
import {
  parseWeqBackupJson,
  validateWeqBackground,
  validateWeqDraftImage,
  WEQ_BACKUP_LIMITS,
  type WeqBackupFile,
} from './backup_bundle';
import { readWeqBackupFile } from './backup_clones';
import { isDressScope } from '../account/dress_config';
import {
  dressConversationBackgroundFiles,
  isDressConversationEntries,
} from '../account/dress_conversations';

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
  if (name === 'dress.json' || name === 'dress-conversations.json' || name === 'client-state.json')
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
  if (name === 'dress-conversations.json') {
    if (!isDressConversationEntries(value)) fail(name);
    return;
  }
  const input = record(value, name);
  if (name === 'anti-recall.json') {
    bools(input, ['enabled', 'notifyEnabled'], name);
    if (input.method !== undefined && !['weq', 'proxy', 'database'].includes(String(input.method)))
      fail(name);
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
    if (input.scope !== undefined && !isDressScope(input.scope)) fail(name);
    if (input.scopes !== undefined) {
      const scopes = record(input.scopes, name);
      if (['bubble', 'font', 'widget'].some((kind) => !isDressScope(scopes[kind]))) fail(name);
    }
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
    for (const key of ['backgroundOpacity', 'widgetOpacity']) {
      const opacity = input[key];
      if (
        opacity !== undefined &&
        (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1)
      )
        fail(`${name}.${key}`);
    }
  }
}

export function snapshotWeqAccountPreferences(
  root: string,
  cache: string,
  scope: string,
  maxDraftMediaBytes: number = WEQ_BACKUP_LIMITS.maxTotalBytes,
  selection?: { preferences: boolean; drafts: boolean },
): { files: WeqBackupFile[]; warnings: string[] } {
  const files: WeqBackupFile[] = [],
    warnings: string[] = [];
  const mediaDir = join(root, 'config', 'accounts', scope, DRAFT_MEDIA_DIR);
  const media = new Map<string, string | undefined>();
  let draftMediaBytes = 0;
  let missingDraftImages = false;
  for (const name of WEQ_ACCOUNT_SETTING_FILES) {
    if (name === 'dress.json') continue;
    if (
      selection &&
      ((name !== 'client-state.json' && (!selection.preferences || name === 'tolerance.json')) ||
        (name === 'client-state.json' && !selection.preferences && !selection.drafts))
    )
      continue;
    const path = weqAccountSettingPath(root, cache, scope, name);
    const value = existsSync(path)
      ? name === 'client-state.json'
        ? new ClientStateStore(path).exportState(selection?.drafts !== false)
        : parseWeqBackupJson(readWeqBackupFile(path))
      : name === 'client-state.json'
        ? { revision: 0, values: {}, records: {}, drafts: {} }
        : {};
    const input = record(value, name);
    if (name === 'intent.json')
      for (const key of Object.keys(input)) if (key !== 'conversationOverrides') delete input[key];
    if (name === 'anti-recall.json')
      for (const key of Object.keys(input))
        if (!['enabled', 'method', 'mode', 'targets', 'notifyTargets'].includes(key))
          delete input[key];
    if (name === 'client-state.json' && input.records && typeof input.records === 'object')
      delete (input.records as Record<string, unknown>).order;
    if (selection && name === 'client-state.json') {
      const records = record(input.records, name);
      input.values = {};
      input.records = selection.preferences
        ? Object.fromEntries(
            Object.entries(records).filter(([key]) => key === 'pins' || key === 'notifications'),
          )
        : {};
      if (!selection.drafts) input.drafts = {};
      delete input.externalDrafts;
      delete input.versionedDrafts;
      delete input.draftBytes;
      delete input.epoch;
      if (
        !Object.keys(input.records as object).length &&
        !Object.keys(input.drafts as object).length
      )
        continue;
    }
    if (selection && !Object.keys(input).length) continue;
    validateWeqAccountPreference(name, input);
    if (name === 'client-state.json') {
      mapDraftImagePaths(input.drafts, (path) => {
        if (!isAbsolute(path)) return;
        const name = relative(mediaDir, path);
        if (!isDraftImageName(name)) return;
        if (media.has(name)) return media.get(name);
        let data: Buffer;
        try {
          if (
            realpathSync(mediaDir) !==
            join(realpathSync(root), 'config', 'accounts', scope, DRAFT_MEDIA_DIR)
          )
            throw new Error('草稿图片目录已重定向');
          data = readWeqBackupFile(join(mediaDir, name), MAX_SHARED_DRAFT_IMAGE_BYTES);
          validateWeqDraftImage(name, data);
        } catch {
          missingDraftImages = true;
          media.set(name, undefined);
          return;
        }
        draftMediaBytes += data.length;
        if (draftMediaBytes > maxDraftMediaBytes) throw new Error('草稿图片使备份总体积超过限制');
        const reference = `${DRAFT_MEDIA_DIR}/${name}`;
        files.push({ path: `accounts/${scope}/${reference}`, data });
        media.set(name, reference);
        return reference;
      });
    }
    files.push({ path: `accounts/${scope}/${name}`, data: Buffer.from(JSON.stringify(input)) });
    if (name === 'dress-conversations.json' && isDressConversationEntries(input))
      for (const file of dressConversationBackgroundFiles(input)) {
        const source = join(root, 'config', 'accounts', scope, file);
        try {
          const data = readWeqBackupFile(source);
          validateWeqBackground(data, extname(file));
          files.push({ path: `accounts/${scope}/background/${file}`, data });
        } catch {
          warnings.push('有会话自定义背景无法备份，已保留装扮选择。');
        }
      }
  }
  if (missingDraftImages) warnings.push('部分草稿图片缺失或格式无法备份，已保留原引用。');
  return { files, warnings };
}
