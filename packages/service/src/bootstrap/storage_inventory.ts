import { eventTimeFormatter } from '@weq/time';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { DbRepairHistory } from '../account/db_repair/history';
import { dbRepairPaths } from '../account/db_repair/paths';
import { measureStorage, RUNTIME_CACHE_NAMES, type StorageUsageItem } from './storage_usage';

const REPAIR_NAMES = new Set(['db_repair', 'db-repair', 'dbfix', 'dbfix2']);
const CONFIG_NAMES = new Set(['config', 'config.json']);
const MEDIA_NAMES = new Set(['avatar', 'media', 'voice', 'linkpreview', 'collection']);
const DRESS_NAMES = new Set([
  'dress',
  'dress_shared',
  'qqshow',
  'redpack',
  'marketface',
  'marketpack',
  'sysemoji',
]);
const SYSTEM_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
type BackupLink = { historyPath: string; recordId: string };

async function json(path: string): Promise<Record<string, unknown> | null> {
  try {
    if ((await lstat(path)).size > 4 * 1024 * 1024) return null;
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function entries(path: string) {
  const files = await readdir(path, { withFileTypes: true });
  if (files.length > 500_000) throw new Error('存储明细过多');
  return files;
}

function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
function scopedEntries(base: StorageUsageItem, path: string) {
  return entries(path).then((files) =>
    files.filter((file) => !base.excludedPaths?.includes(join(path, file.name))),
  );
}
function measureItem(base: StorageUsageItem, path: string) {
  return measureStorage(path, new Set(base.excludedPaths));
}
function canRemove(base: StorageUsageItem, path: string) {
  return !base.protected && !base.excludedPaths?.some((excluded) => contains(path, excluded));
}

function itemAt(base: StorageUsageItem, path: string, label: string): StorageUsageItem {
  return {
    ...base,
    id: `storage:${path}`,
    path,
    label,
    clearable: false,
    requiresExit: false,
    cleanupKind: undefined,
    confirmation: undefined,
    action: 'none',
    management: 'cleanup',
  };
}

async function backupItems(
  base: StorageUsageItem,
  accountRoot: string,
  links: Map<string, BackupLink>,
): Promise<StorageUsageItem[]> {
  const result: StorageUsageItem[] = [];
  for (const entry of await scopedEntries(base, accountRoot)) {
    const path = join(accountRoot, entry.name);
    if (entry.name !== 'backups' || !entry.isDirectory()) {
      const item = itemAt(
        base,
        path,
        entry.name === 'work' ? '数据库修复临时文件' : '数据库修复记录与报告',
      );
      Object.assign(item, await measureItem(base, path));
      item.category = entry.name === 'work' ? 'repair-work' : 'repair-history';
      item.management = entry.name === 'work' ? 'cleanup' : 'repair';
      item.clearable =
        entry.name === 'work' && entry.isDirectory() && !item.incomplete && canRemove(base, path);
      item.requiresExit = item.clearable;
      item.action = item.clearable ? 'data' : 'none';
      item.confirmation = item.clearable
        ? '将删除修复临时工作文件，保留数据库备份、修复记录与报告。'
        : undefined;
      result.push(item);
      continue;
    }
    for (const backup of await scopedEntries(base, path)) {
      const backupDir = join(path, backup.name);
      const item = itemAt(base, backupDir, '历史数据库备份');
      Object.assign(item, await measureItem(base, backupDir));
      item.category = 'db-backups';
      const meta = backup.isDirectory() ? await json(join(backupDir, 'meta.json')) : null;
      const dbName = typeof meta?.dbName === 'string' ? meta.dbName : '';
      const validName = /^[^/\\]+\.db$/.test(dbName) && dbName !== '..';
      const contents = backup.isDirectory() ? await entries(backupDir) : [];
      const recognized =
        validName &&
        typeof meta?.uin === 'string' &&
        typeof meta.at === 'string' &&
        typeof meta.source === 'string' &&
        resolve(meta.source) !== resolve(join(backupDir, dbName)) &&
        contents.some((file) => file.name === dbName && file.isFile()) &&
        contents.every((file) => file.isFile() && [dbName, 'meta.json'].includes(file.name));
      const link = recognized ? links.get(resolve(join(backupDir, dbName))) : undefined;
      item.backup = {
        account: typeof meta?.uin === 'string' ? meta.uin : basename(accountRoot),
        database: dbName || '未识别数据库',
        at: typeof meta?.at === 'string' ? meta.at : '',
        status: !recognized ? 'unrecognized' : link ? 'linked' : 'orphan',
        ...link,
      };
      item.label = `${item.backup.account} · ${item.backup.database}`;
      item.clearable = recognized && !item.incomplete && canRemove(base, backupDir);
      item.requiresExit = item.clearable;
      item.action = item.clearable ? 'db-backup' : 'none';
      item.cleanupKind = 'db-backup';
      item.reason = recognized
        ? '数据库备份，修复记录与报告单独保留'
        : '备份元数据不完整，仅统计占用';
      item.confirmation =
        '仅删除这份数据库备份，保留修复记录与报告；对应备份将不能再用于回滚，不会删除 QQ 原始数据库。';
      result.push(item);
    }
  }
  return result;
}

async function splitRepair(
  base: StorageUsageItem,
  accountRoot: boolean,
  links: Map<string, BackupLink>,
): Promise<StorageUsageItem[]> {
  if ((await lstat(base.path)).isSymbolicLink()) return [classify(base)];
  if (accountRoot) return backupItems(base, base.path, links);
  const result: StorageUsageItem[] = [];
  const children = await scopedEntries(base, base.path);
  if (children.some((entry) => entry.name === 'backups' && entry.isDirectory()))
    return backupItems(base, base.path, links);
  for (const entry of children) {
    const path = join(base.path, entry.name);
    const child = itemAt(base, path, '历史数据库修复数据');
    if (
      entry.isDirectory() &&
      (await entries(path)).some((file) =>
        ['backups', 'history.json', 'reports', 'work'].includes(file.name),
      )
    ) {
      result.push(...(await backupItems(base, path, links)));
    } else {
      Object.assign(child, await measureItem(base, path));
      const database = entry.isDirectory() || /\.db(?:-wal|-shm)?$/.test(entry.name);
      child.category = database ? 'db-backups' : 'repair-history';
      child.management = database ? 'cleanup' : 'repair';
      if (database) {
        child.label = `历史数据库文件（待确认） · ${entry.name}`;
        child.reason = '缺少可确认归属的备份元数据，仅统计和定位，不参与清理';
        child.backup = {
          account: '未识别账号',
          database: entry.isDirectory() ? '未识别数据库' : entry.name,
          at: '',
          status: 'unrecognized',
        };
      }
      result.push(child);
    }
  }
  return result;
}

async function splitProgramBackups(base: StorageUsageItem): Promise<StorageUsageItem[]> {
  if (!(await lstat(base.path)).isDirectory() || (await lstat(base.path)).isSymbolicLink())
    return [classify(base)];
  const result: StorageUsageItem[] = [];
  for (const entry of await scopedEntries(base, base.path)) {
    const path = join(base.path, entry.name);
    const item = itemAt(base, path, `历史程序修补备份 · ${entry.name}`);
    Object.assign(item, await measureItem(base, path));
    const meta = entry.isDirectory() ? await json(join(path, 'before.json')) : null;
    const files = Array.isArray(meta?.files) ? meta.files : [];
    const names = new Set(['before.json', 'installed.json', 'entitlements-before.txt']);
    const recognized =
      files.length > 0 &&
      files.every((file: unknown) => {
        if (
          !file ||
          typeof file !== 'object' ||
          !('backup' in file) ||
          typeof file.backup !== 'string'
        )
          return false;
        if (dirname(resolve(file.backup)) !== resolve(path)) return false;
        names.add(basename(file.backup));
        return true;
      }) &&
      (await entries(path)).every((file) => file.isFile() && names.has(file.name));
    item.category = 'program-backups';
    item.clearable = recognized && !item.incomplete && canRemove(base, path);
    item.requiresExit = item.clearable;
    item.action = item.clearable ? 'program-backup' : 'none';
    const at = typeof meta?.capturedAt === 'string' ? meta.capturedAt : '';
    const time =
      at && /(?:Z|[+-]\d{2}:\d{2})$/.test(at) && Number.isFinite(Date.parse(at))
        ? `${eventTimeFormatter.format(new Date(at))}（北京时间）`
        : at;
    item.reason = time ? `备份时间：${time}` : '未识别的程序备份，仅统计占用';
    item.confirmation =
      '将删除这组旧程序文件备份，不能再用它恢复当时的安装状态；不删除数据库备份、聊天数据或当前程序。';
    result.push(item);
  }
  return result;
}

function classify(item: StorageUsageItem): StorageUsageItem {
  const name = basename(item.path);
  const base = {
    ...item,
    category: 'unknown' as StorageUsageItem['category'],
    management: 'cleanup' as const,
    action: 'none' as StorageUsageItem['action'],
  };
  if (CONFIG_NAMES.has(name))
    return { ...base, management: 'backup', action: item.clearable ? 'data' : 'none' };
  if (name === 'anti_recall' || name === 'restore' || name.startsWith('config.json.'))
    return { ...base, management: 'backup', clearable: false, requiresExit: false };
  if (item.management === 'backup' || item.label.startsWith('桌面运行数据')) {
    if (RUNTIME_CACHE_NAMES.has(name))
      return {
        ...base,
        label: '桌面运行缓存',
        category: 'cache',
        action: item.clearable ? 'cache' : 'none',
        confirmation: item.clearable ? '仅删除桌面缓存，后续使用时会重新生成。' : undefined,
      };
    return { ...base, management: 'runtime', clearable: false, requiresExit: false };
  }
  if (name === 'remote-network')
    return { ...base, management: 'runtime', clearable: false, requiresExit: false };
  if (name === 'flash')
    return {
      ...base,
      label: '历史闪传下载与任务',
      management: 'downloads',
      clearable: false,
      requiresExit: false,
    };
  if (item.clearable && !item.requiresExit)
    return {
      ...base,
      category: MEDIA_NAMES.has(name) ? 'media' : DRESS_NAMES.has(name) ? 'dress' : 'cache',
      action: 'cache',
    };
  if (item.clearable || ['models', 'ocr', 'agentlab', 'export', 'logs'].includes(name))
    return { ...base, category: 'persistent', action: item.clearable ? 'data' : 'none' };
  return { ...base, clearable: false };
}

/** 为展示和清理提供同一份业务清单；拆分项替代原目录，不重复累计。 */
export async function organizeStorageUsage(items: StorageUsageItem[]): Promise<StorageUsageItem[]> {
  const result: StorageUsageItem[] = [];
  const links = new Map<string, BackupLink>();
  // 自定义工作盘只保存备份，历史仍在原缓存；先跨根建立关联，再拆分统计。
  for (const item of items) {
    const accounts = REPAIR_NAMES.has(basename(item.path))
      ? await entries(item.path)
          .then((files) => [
            item.path,
            ...files.filter((file) => file.isDirectory()).map((file) => join(item.path, file.name)),
          ])
          .catch(() => [])
      : REPAIR_NAMES.has(basename(dirname(item.path)))
        ? [item.path]
        : [];
    for (const account of accounts) {
      const paths = dbRepairPaths(account);
      const info = await lstat(paths.history).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      for (const record of new DbRepairHistory(paths).list())
        if (typeof record.backupPath === 'string' && record.backupPath) {
          const backupPath = record.backupPath;
          links.set(await realpath(backupPath).catch(() => resolve(backupPath)), {
            historyPath: paths.history,
            recordId: record.id,
          });
        }
    }
  }
  for (const item of items) {
    if (SYSTEM_NAMES.has(basename(item.path).toLowerCase())) {
      result.push(classify(item));
      continue;
    }
    try {
      if (REPAIR_NAMES.has(basename(item.path)))
        result.push(...(await splitRepair(item, false, links)));
      else if (REPAIR_NAMES.has(basename(dirname(item.path))))
        result.push(...(await splitRepair(item, true, links)));
      else if (basename(item.path) === 'repair-backups')
        result.push(...(await splitProgramBackups(item)));
      else result.push(classify(item));
    } catch {
      result.push({
        ...classify(item),
        clearable: false,
        incomplete: true,
        reason: '明细读取不完整，请刷新后重试',
      });
    }
  }
  return result;
}
