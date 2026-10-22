import { createHash } from 'node:crypto';
import { buildZip, readZipEntries, type ZipEntry } from '../common/zip';
import { sniffImageExt } from '../account/export/emoji_export';
import { isWindowsReservedName } from '../common/path_sanitize';
import { WEQ_ACCOUNT_SETTING_FILES, isWeqBackgroundName } from '../common/backup_account_paths';
import {
  weqCloneStickerReferences,
  weqClonePersona,
  WEQ_CLONE_STORES as CLONE_STORES,
} from './backup_refs';

export const WEQ_BACKUP_VERSION = 1;
export const WEQ_BACKUP_LIMITS = {
  maxEntries: 8192,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxArchiveBytes: 260 * 1024 * 1024,
} as const;
export const WEQ_BACKUP_PARTS = ['settings', 'accounts', 'api', 'clones'] as const;
export type WeqBackupPart = (typeof WEQ_BACKUP_PARTS)[number];

/** 包内是逻辑路径，不接受用户提供的落盘目标。实际目标由恢复服务按分区决定。 */
export interface WeqBackupFile {
  path: string;
  data: Buffer;
}
export interface WeqBackupManifest {
  format: 'weq-backup';
  version: typeof WEQ_BACKUP_VERSION;
  createdAt: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}
export interface WeqBackupBundle {
  manifest: WeqBackupManifest;
  files: WeqBackupFile[];
}
export interface WeqBackupSummary {
  createdAt: string;
  parts: Array<{ part: WeqBackupPart; files: number; bytes: number }>;
  accountConfigIds: string[];
  cloneConfigIds: string[];
  warnings: string[];
}

const SETTINGS_FILES = new Set([
  'settings/app.json',
  'settings/client.json',
  'settings/export-presets.json',
]);
const CONFIG_ID = /^\d{1,20}(?:_[0-9a-f]{8})?$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function isWeqBackupConfigId(value: string): boolean {
  return CONFIG_ID.test(value);
}

export function weqAccountBackupScope(path: string): string {
  const scope = path.split('/')[1] ?? '';
  return scope.endsWith('.json') ? scope.slice(0, -5) : scope;
}

export function weqBackupPart(path: string): WeqBackupPart {
  if (
    path.length > 300 ||
    !/^[\p{L}\p{M}\p{N}_./-]+$/u.test(path) ||
    path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || isWindowsReservedName(part))
  )
    throw new Error('备份包含非法逻辑路径');
  if (SETTINGS_FILES.has(path)) return 'settings';
  if (path === 'api/settings.json') return 'api';
  const parts = path.split('/');
  if (parts[0] === 'accounts' && parts.length === 2) {
    const name = parts[1]!;
    if (name.endsWith('.json') && isWeqBackupConfigId(name.slice(0, -5))) return 'accounts';
  }
  if (parts[0] === 'accounts' && isWeqBackupConfigId(parts[1] ?? '')) {
    if (
      parts.length === 3 &&
      WEQ_ACCOUNT_SETTING_FILES.includes(parts[2] as (typeof WEQ_ACCOUNT_SETTING_FILES)[number])
    )
      return 'accounts';
    if (parts.length === 4 && parts[2] === 'background' && isWeqBackgroundName(parts[3]!))
      return 'accounts';
  }
  if (parts[0] === 'clones' && isWeqBackupConfigId(parts[1] ?? '')) {
    const name = parts[2] ?? '';
    if (
      parts.length === 3 &&
      name !== 'bot_exports.json' &&
      (CLONE_STORES.has(name) || (name.endsWith('.json') && SAFE_ID.test(name.slice(0, -5))))
    )
      return 'clones';
    if (parts.length === 4) {
      const asset = parts[3]!;
      if (name === 'assistant_runs' && /^[A-Za-z0-9._-]{1,120}\.json$/.test(asset)) return 'clones';
      if (name === 'reports' && /^[\p{L}\p{M}\p{N}_-]{1,200}\.(html|md|txt)$/u.test(asset))
        return 'clones';
      if (name === 'stickers' && /^[0-9a-f]{1,64}\.png$/i.test(asset)) return 'clones';
      if ((name === 'voice' || name === 'agentvoice') && /^[0-9a-f]{1,64}\.(wav|mp3)$/i.test(asset))
        return 'clones';
    }
  }
  throw new Error('备份包含不支持的数据类型，不接受 QQ 数据库或任意文件');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneAssetReferences(file: WeqBackupFile, value: Record<string, unknown>): string[] {
  const prefix = `clones/${file.path.split('/')[1]!}`;
  const paths: string[] = [];
  const add = (path: unknown, kind: 'stickers' | 'voice') => {
    if (
      typeof path !== 'string' ||
      !path.startsWith(`${kind}/`) ||
      weqBackupPart(`${prefix}/${path}`) !== 'clones'
    )
      throw new Error('克隆备份中的资产引用不是包内相对路径');
    paths.push(`${prefix}/${path}`);
  };
  const persona = weqClonePersona(value, file.path.split('/')[2]!) ?? {};
  for (const sticker of weqCloneStickerReferences(value, file.path.split('/')[2]!)) {
    if (sticker.localPath !== undefined) add(sticker.localPath, 'stickers');
    else if (typeof sticker.md5 === 'string' && /^[0-9a-f]{1,64}$/i.test(sticker.md5))
      add(`stickers/${sticker.md5}.png`, 'stickers');
  }
  if (persona.voiceProfile !== undefined) {
    if (!record(persona.voiceProfile)) throw new Error('克隆参考语音结构无效');
    if (persona.voiceProfile.refClips !== undefined) {
      if (!Array.isArray(persona.voiceProfile.refClips))
        throw new Error('克隆参考语音引用结构无效');
      for (const clip of persona.voiceProfile.refClips) {
        if (!record(clip)) throw new Error('克隆参考语音引用结构无效');
        add(clip.path, 'voice');
      }
    }
  }
  return paths;
}

/** 限制嵌套与节点数，避免导入时把异常 JSON 交给各业务存储。 */
export function parseWeqBackupJson(data: Buffer): unknown {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw new Error('备份 JSON 不是有效的 UTF-8 数据');
  }
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (queue.length) {
    const current = queue.pop()!;
    if (++nodes > 1_000_000 || current.depth > 64) throw new Error('备份 JSON 结构过于复杂');
    if (typeof current.value === 'number' && !Number.isFinite(current.value))
      throw new Error('备份 JSON 包含无效数字');
    if (!current.value || typeof current.value !== 'object') continue;
    for (const [key, child] of Object.entries(current.value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor')
        throw new Error('备份 JSON 包含不支持的属性');
      queue.push({ value: child, depth: current.depth + 1 });
    }
  }
  return value;
}

export function validateWeqCloneAsset(path: string, data: Buffer): void {
  if (path.includes('/stickers/')) {
    if (!sniffImageExt(data)) throw new Error('克隆表情资产不是支持的图片文件');
  } else if (path.endsWith('.wav')) {
    if (
      data.length < 12 ||
      data.toString('ascii', 0, 4) !== 'RIFF' ||
      data.toString('ascii', 8, 12) !== 'WAVE'
    )
      throw new Error('克隆语音资产不是 WAV 文件');
  } else if (path.endsWith('.mp3')) {
    if (
      data.length < 3 ||
      (data.toString('ascii', 0, 3) !== 'ID3' && !(data[0] === 0xff && (data[1]! & 0xe0) === 0xe0))
    )
      throw new Error('克隆语音资产不是 MP3 文件');
  }
}

export function validateWeqBackground(data: Buffer, extension: string): void {
  const image = sniffImageExt(data);
  if (image && (image === extension || (image === '.jpg' && extension === '.jpeg'))) return;
  if (
    extension === '.webm' &&
    data.length >= 4 &&
    data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  )
    return;
  if (
    (extension === '.mp4' || extension === '.mov') &&
    data.length >= 12 &&
    ['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(data.toString('ascii', 4, 8))
  )
    return;
  throw new Error('自定义背景格式与文件内容不符');
}

function validateFile(file: WeqBackupFile): void {
  const part = weqBackupPart(file.path);
  if (file.data.length > WEQ_BACKUP_LIMITS.maxEntryBytes) throw new Error('备份单文件超过 64 MiB');
  if (!file.path.endsWith('.json')) {
    if (part === 'accounts') {
      validateWeqBackground(file.data, file.path.slice(file.path.lastIndexOf('.')));
      return;
    }
    if (file.path.includes('/reports/')) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(file.data);
      } catch {
        throw new Error('助手报告不是有效的 UTF-8 数据');
      }
      return;
    }
    validateWeqCloneAsset(file.path, file.data);
    return;
  }
  const value = parseWeqBackupJson(file.data);
  if (
    part === 'clones' &&
    (file.path.endsWith('/usage.json') || file.path.endsWith('/assistant_sessions.json'))
  ) {
    if (!Array.isArray(value)) throw new Error('备份用量记录必须是 JSON 数组');
    return;
  }
  if (!record(value)) throw new Error('备份配置必须是 JSON 对象');
  if (part === 'accounts' && file.path.split('/').length === 2) {
    const id = file.path.slice('accounts/'.length, -5);
    if (
      value.configId !== id ||
      typeof value.uin !== 'string' ||
      !/^\d{1,20}$/.test(value.uin) ||
      (id !== value.uin && !id.startsWith(`${value.uin}_`)) ||
      typeof value.dbKey !== 'string' ||
      !record(value.algos) ||
      typeof value.lastLoginAt !== 'number' ||
      !Number.isFinite(value.lastLoginAt) ||
      (value.dataDir !== undefined && typeof value.dataDir !== 'string')
    )
      throw new Error('备份账号配置与其标识不一致或字段无效');
  }
  if (part === 'clones') {
    const name = file.path.split('/')[2]!;
    if (file.path.split('/').length === 3 && !CLONE_STORES.has(name)) {
      if (
        !record(value.persona) ||
        value.persona.id !== name.slice(0, -5) ||
        !Array.isArray(value.pairs)
      )
        throw new Error('备份克隆记录与其标识不一致或字段无效');
    }
    cloneAssetReferences(file, value);
  }
}

function digest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 清单与负载一一对应；CRC 和 SHA-256 用于损坏检测，不是来源认证。 */
export function buildWeqBackup(
  files: readonly WeqBackupFile[],
  createdAt = new Date().toISOString(),
): Buffer {
  if (!files.length) throw new Error('没有选择可备份的数据');
  if (files.length + 1 > WEQ_BACKUP_LIMITS.maxEntries) throw new Error('备份文件数量超过限制');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('备份时间无效');
  let total = 0;
  const names = new Set<string>();
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const file of sorted) {
    validateFile(file);
    const name = file.path.normalize('NFC').toLowerCase();
    if (names.has(name)) throw new Error('备份文件路径重复或大小写冲突');
    names.add(name);
    total += file.data.length;
    if (total > WEQ_BACKUP_LIMITS.maxTotalBytes)
      throw new Error('备份解压体积超过 256 MiB，请分批备份');
  }
  const manifest: WeqBackupManifest = {
    format: 'weq-backup',
    version: WEQ_BACKUP_VERSION,
    createdAt,
    files: sorted.map((file) => ({
      path: file.path,
      bytes: file.data.length,
      sha256: digest(file.data),
    })),
  };
  const metadata = Buffer.from(JSON.stringify(manifest));
  if (total + metadata.length > WEQ_BACKUP_LIMITS.maxTotalBytes)
    throw new Error('备份清单与数据的总体积超过限制');
  const output = buildZip([
    { name: 'manifest.json', data: metadata },
    ...sorted.map((file) => ({ name: file.path, data: file.data })),
  ]);
  if (output.length > WEQ_BACKUP_LIMITS.maxArchiveBytes) throw new Error('备份包体积超过限制');
  return output;
}

export function readWeqBackup(data: Buffer): WeqBackupBundle {
  if (data.length > WEQ_BACKUP_LIMITS.maxArchiveBytes) throw new Error('备份包体积超过限制');
  const entries = readZipEntries(data, WEQ_BACKUP_LIMITS);
  const metadata = entries.find((entry) => entry.name === 'manifest.json');
  if (!metadata) throw new Error('不是 WeQ 备份包：缺少清单');
  const raw = parseWeqBackupJson(metadata.data);
  if (!record(raw) || raw.format !== 'weq-backup') throw new Error('不是 WeQ 备份包');
  if (raw.version !== WEQ_BACKUP_VERSION) throw new Error('不支持此 WeQ 备份版本');
  if (
    typeof raw.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.createdAt)) ||
    !Array.isArray(raw.files)
  )
    throw new Error('备份清单结构无效');
  if (!raw.files.length || raw.files.length + 1 !== entries.length)
    throw new Error('备份清单与文件数量不一致');
  const byName = new Map<string, ZipEntry>();
  for (const entry of entries) {
    const name = entry.name.normalize('NFC').toLowerCase();
    if (byName.has(name)) throw new Error('备份文件路径大小写冲突');
    byName.set(name, entry);
  }
  const files: WeqBackupFile[] = [];
  const manifestFiles: WeqBackupManifest['files'] = [];
  const seen = new Set<string>();
  for (const item of raw.files) {
    if (
      !record(item) ||
      typeof item.path !== 'string' ||
      typeof item.bytes !== 'number' ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      typeof item.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(item.sha256)
    )
      throw new Error('备份文件清单字段无效');
    const key = item.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error('备份清单路径重复');
    seen.add(key);
    const entry = byName.get(key);
    if (
      !entry ||
      entry.name !== item.path ||
      entry.data.length !== item.bytes ||
      digest(entry.data) !== item.sha256
    )
      throw new Error('备份文件缺失、体积不符或内容校验失败');
    const file = { path: entry.name, data: entry.data };
    validateFile(file);
    files.push(file);
    manifestFiles.push({ path: item.path, bytes: item.bytes, sha256: item.sha256 });
  }
  return {
    manifest: {
      format: 'weq-backup',
      version: WEQ_BACKUP_VERSION,
      createdAt: raw.createdAt,
      files: manifestFiles,
    },
    files,
  };
}

export function summarizeWeqBackup(bundle: WeqBackupBundle): WeqBackupSummary {
  const parts = new Map<WeqBackupPart, { part: WeqBackupPart; files: number; bytes: number }>();
  const accounts = new Set<string>();
  const clones = new Set<string>();
  const names = new Set(bundle.files.map((file) => file.path));
  const warnings: string[] = [];
  for (const file of bundle.files) {
    const part = weqBackupPart(file.path);
    const row = parts.get(part) ?? { part, files: 0, bytes: 0 };
    row.files++;
    row.bytes += file.data.length;
    parts.set(part, row);
    if (part === 'accounts') accounts.add(weqAccountBackupScope(file.path));
    if (part === 'accounts' && file.path.endsWith('/dress.json')) {
      const value = parseWeqBackupJson(file.data);
      if (
        record(value) &&
        typeof value.backgroundFile === 'string' &&
        value.backgroundFile &&
        !names.has(
          `accounts/${weqAccountBackupScope(file.path)}/background/${value.backgroundFile}`,
        )
      )
        warnings.push(`${file.path} 有未包含在备份中的自定义背景`);
    }
    if (part === 'clones') clones.add(file.path.split('/')[1]!);
    if (part === 'clones' && file.path.endsWith('.json')) {
      const value = parseWeqBackupJson(file.data);
      if (record(value) && cloneAssetReferences(file, value).some((path) => !names.has(path)))
        warnings.push(`${file.path} 有未包含在备份中的克隆资产`);
    }
  }
  return {
    createdAt: bundle.manifest.createdAt,
    parts: WEQ_BACKUP_PARTS.flatMap((part) => parts.get(part) ?? []),
    accountConfigIds: [...accounts].sort(),
    cloneConfigIds: [...clones].sort(),
    warnings,
  };
}
