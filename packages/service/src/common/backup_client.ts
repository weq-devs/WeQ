export const WEQ_CLIENT_BACKUP_KEYS = [
  'weq.theme-preference',
  'weq.theme-accent',
  'weq.theme-background',
  'weq.theme-component-style',
  'weq.privacy-mode',
  'weq.group-badge-display.v1',
  'weq.groups.grouping',
  'weq.desktop.sidebarWidth.v2',
  'chat-template.layout.composerHeight',
  'chat-template.layout.groupInfoCollapsed',
  'chat-template.layout.composerCollapsed',
  'chat-template:conversation-preferences',
  'weq:tools-position',
  'weq:tools-docked',
] as const;

const KEYS = new Set<string>(WEQ_CLIENT_BACKUP_KEYS);
export function isWeqClientBackupKey(key: string): boolean {
  return KEYS.has(key) || /^weq:group-assistant-pins:\d{1,20}(?:_[0-9a-f]{8})?$/.test(key);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(key: string): never {
  throw new Error(`备份界面偏好无效：${key}`);
}
function json(value: string, key: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail(key);
  }
  if (!object(parsed)) fail(key);
  if (Object.keys(parsed).some((name) => ['__proto__', 'prototype', 'constructor'].includes(name)))
    fail(key);
  return parsed;
}

/** 只接受真实偏好键；会话草稿、令牌、恢复现场与原始消息不混入设置备份。 */
export function validateWeqClientSettings(value: unknown): asserts value is Record<string, string> {
  if (!object(value)) fail('根对象');
  for (const [key, entry] of Object.entries(value)) {
    if (!isWeqClientBackupKey(key) || typeof entry !== 'string' || entry.length > 4 * 1024 * 1024)
      fail(key);
    if (key === 'weq.theme-preference' && !['system', 'light', 'dark'].includes(entry)) fail(key);
    if (
      key === 'weq.theme-accent' &&
      entry !== '' &&
      !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(entry)
    )
      fail(key);
    if (
      key === 'weq.theme-background' &&
      !['plain', 'paper', 'grid', 'dots', 'wash', 'telegram'].includes(entry)
    )
      fail(key);
    if (key === 'weq.theme-component-style' && entry !== 'classic') fail(key);
    if (key === 'weq.groups.grouping' && !['notify', 'identity', 'size'].includes(entry)) fail(key);
    if (
      [
        'weq.privacy-mode',
        'chat-template.layout.groupInfoCollapsed',
        'chat-template.layout.composerCollapsed',
      ].includes(key) &&
      entry !== '0' &&
      entry !== '1'
    )
      fail(key);
    if (key === 'weq:tools-docked' && entry !== 'true' && entry !== 'false') fail(key);
    if (
      (key === 'weq.desktop.sidebarWidth.v2' || key === 'chat-template.layout.composerHeight') &&
      (!entry.trim() ||
        !Number.isFinite(Number(entry)) ||
        Number(entry) < 0 ||
        Number(entry) > 10000)
    )
      fail(key);
    if (key === 'weq:tools-position') {
      const position = json(entry, key);
      if (
        Object.keys(position).some((part) => part !== 'x' && part !== 'y') ||
        [position.x, position.y].some((part) => typeof part !== 'number' || !Number.isFinite(part))
      )
        fail(key);
    }
    if (key === 'weq.group-badge-display.v1')
      for (const [scope, display] of Object.entries(json(entry, key))) {
        let target: unknown;
        try {
          target = JSON.parse(scope);
        } catch {
          fail(key);
        }
        if (
          !Array.isArray(target) ||
          target.length !== 2 ||
          target.some((part) => typeof part !== 'string' || !part) ||
          !object(display) ||
          Object.keys(display).some((part) => part !== 'showTitle' && part !== 'showLevel') ||
          typeof display.showTitle !== 'boolean' ||
          typeof display.showLevel !== 'boolean'
        )
          fail(key);
      }
    if (key === 'chat-template:conversation-preferences')
      for (const preference of Object.values(json(entry, key))) {
        if (
          !object(preference) ||
          Object.keys(preference).some((part) => !['pinned', 'muted', 'blocked'].includes(part)) ||
          ['pinned', 'muted', 'blocked'].some((part) => typeof preference[part] !== 'boolean')
        )
          fail(key);
      }
    if (key.startsWith('weq:group-assistant-pins:'))
      for (const [group, pinned] of Object.entries(json(entry, key))) {
        if (!/^\d+$/.test(group) || typeof pinned !== 'boolean') fail(key);
      }
  }
}

function readClientSettings(
  storage: Pick<Storage, 'length' | 'key' | 'getItem'>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key || !isWeqClientBackupKey(key)) continue;
    const value = storage.getItem(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

export function snapshotWeqClientSettings(
  storage: Pick<Storage, 'length' | 'key' | 'getItem'>,
): Record<string, string> {
  const out = readClientSettings(storage);
  validateWeqClientSettings(out);
  return out;
}

/** 写入失败回滚已变更的偏好；确认成功后才可向服务端确认恢复回执。 */
export function applyWeqClientSettings(
  storage: Storage,
  values: Record<string, string>,
  replace = true,
): void {
  validateWeqClientSettings(values);
  const before = readClientSettings(storage);
  const keys = new Set([...Object.keys(values), ...(replace ? Object.keys(before) : [])]);
  try {
    for (const key of keys) {
      if (values[key] === undefined) storage.removeItem(key);
      else storage.setItem(key, values[key]);
    }
  } catch (error) {
    const failed: string[] = [];
    for (const key of keys) {
      try {
        if (before[key] === undefined) storage.removeItem(key);
        else storage.setItem(key, before[key]);
      } catch {
        failed.push(key);
      }
    }
    if (failed.length)
      throw new Error(`恢复界面偏好失败，${failed.length} 项未能回滚；请勿确认恢复成功。`);
    throw error;
  }
}
