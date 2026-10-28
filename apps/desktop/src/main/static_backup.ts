import { stat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { linuxAccountDirName, type Platform, type MediaDirKey } from '@weq/platform';
import { runBackupProbe } from './backup_probe';
import {
  fetchOtherDeviceDatabaseKey,
  loginDbPaths,
  type AccountConfig,
  type AttachHook,
  type OtherDeviceInstance,
  type OtherDeviceKeyContext,
} from '@weq/service';
import { scanDirectories } from './directory_scan';

async function isFile(path: string) {
  return stat(path)
    .then((s) => s.isFile())
    .catch(() => false);
}

/** 已知布局按结构定位，不把账号目录名直接当作已验证身份。 */
export async function resolveBackupLocation(path: string) {
  for (const segments of [[], ['nt_db'], ['nt_qq', 'nt_db']]) {
    const dir = join(path, ...segments);
    if (!(await isFile(join(dir, 'nt_msg.db'))) || !(await isFile(join(dir, 'profile_info.db'))))
      continue;
    const dbDir = await realpath(dir);
    const parent = dirname(dbDir);
    let accountDir =
      basename(dbDir) !== 'nt_db' ? dbDir : basename(parent) === 'nt_qq' ? dirname(parent) : parent;
    const mediaPath = join(dbDir, 'nt_data');
    let mediaDir = await stat(mediaPath)
      .then((s) => (s.isDirectory() ? mediaPath : null))
      .catch(() => null);
    if (mediaDir) accountDir = dbDir;
    else if (basename(dbDir) === 'nt_db') {
      const sibling = join(parent, 'nt_data');
      mediaDir = await stat(sibling)
        .then((s) => (s.isDirectory() ? sibling : null))
        .catch(() => null);
    }
    return { accountDir, dbDir, mediaDir };
  }
  return null;
}

/** 旧调用仍可取数据库路径，用户选择与扫描结果始终使用完整账号根。 */
export async function resolveBackupDirectory(path: string): Promise<string | null> {
  return (await resolveBackupLocation(path))?.dbDir ?? null;
}

export interface BackupScanInfo {
  dirPath: string;
  dbDir: string;
  mediaDir: string | null;
  databaseCount: number | null;
  databaseBytes: number | null;
  sizePending: boolean;
  sizeError?: string;
}

export async function backupInfo(
  dbDir: string,
  onProgress?: (info: BackupScanInfo) => void,
  signal?: AbortSignal,
) {
  const location = await resolveBackupLocation(dbDir);
  if (!location) throw new Error('未找到 QQ 账号数据库目录');
  dbDir = location.dbDir;
  const files = (await readdir(dbDir)).filter((name) => name.endsWith('.db'));
  const info = {
    dirPath: location.accountDir,
    dbDir,
    databaseCount: files.length,
    databaseBytes: 0,
    mediaDir: location.mediaDir,
  };
  let unreadable = 0;
  let measured = 0;
  onProgress?.({ ...info, databaseBytes: null, sizePending: true });
  for (const name of files) {
    signal?.throwIfAborted();
    try {
      info.databaseBytes += (await stat(join(dbDir, name))).size;
      measured++;
    } catch {
      unreadable++;
    }
    onProgress?.({
      ...info,
      databaseBytes: measured ? info.databaseBytes : null,
      sizePending: true,
    });
  }
  const result = {
    ...info,
    databaseBytes: unreadable === files.length && files.length > 0 ? null : info.databaseBytes,
    sizePending: false,
    ...(unreadable ? { sizeError: `${unreadable} 个数据库大小未能读取` } : {}),
  };
  onProgress?.(result);
  return result;
}

export async function discoverBackups(
  path: string,
  recursive = false,
  options: { onCandidate?: (info: BackupScanInfo) => void; signal?: AbortSignal } = {},
) {
  const seen = new Set<string>();
  const result = await scanDirectories<BackupScanInfo>(
    path,
    async (directory) => {
      options.signal?.throwIfAborted();
      const location = await resolveBackupLocation(directory);
      if (!location || seen.has(location.dbDir)) return [];
      seen.add(location.dbDir);
      options.onCandidate?.({
        dirPath: location.accountDir,
        dbDir: location.dbDir,
        mediaDir: location.mediaDir,
        databaseCount: null,
        databaseBytes: null,
        sizePending: true,
      });
      try {
        return [await backupInfo(location.dbDir, options.onCandidate, options.signal)];
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const failed = {
          dirPath: location.accountDir,
          dbDir: location.dbDir,
          mediaDir: location.mediaDir,
          databaseCount: null,
          databaseBytes: null,
          sizePending: false,
          sizeError: error instanceof Error ? error.message : String(error),
        };
        options.onCandidate?.(failed);
        return [failed];
      }
    },
    recursive,
    options.signal,
  );
  return { candidates: result.items, truncated: result.truncated, unreadable: result.unreadable };
}

export type BackupScanCandidate = BackupScanInfo & {
  probe: Awaited<ReturnType<typeof probeBackup>> | null;
};
export type BackupScanEvent =
  | { kind: 'candidate'; candidate: BackupScanCandidate }
  | { kind: 'done'; truncated: boolean; unreadable: number };

/** 目录、文件体积和逐项身份验证分批回传，不等待整批原生探测。 */
export async function scanBackupCandidates(
  platform: Platform,
  configs: AccountConfig[],
  path: string,
  recursive: boolean,
  options: Parameters<typeof probeBackup>[3],
  emit?: (event: BackupScanEvent) => void,
  signal?: AbortSignal,
) {
  const result = await discoverBackups(path, recursive, {
    signal,
    onCandidate: (info) => emit?.({ kind: 'candidate', candidate: { ...info, probe: null } }),
  });
  const candidates = [];
  for (const info of result.candidates) {
    signal?.throwIfAborted();
    let probe: Awaited<ReturnType<typeof probeBackup>>;
    try {
      probe = await probeBackup(platform, configs, info.dirPath, options);
    } catch (error) {
      probe = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    signal?.throwIfAborted();
    const candidate = { ...info, probe };
    candidates.push(candidate);
    emit?.({ kind: 'candidate', candidate });
  }
  emit?.({ kind: 'done', truncated: result.truncated, unreadable: result.unreadable });
  return { ...result, candidates };
}

/**
 * 本机 QQ 数据根下的 `login.db`。手机备份缺 `gpro_*.db` 时，worker 会退到这些
 * 文件里按 uin 查 uid；拿不到就是空表，探测照旧。
 */
export function backupLoginDbPaths(platform: Platform): string[] {
  try {
    return loginDbPaths(platform);
  } catch {
    return [];
  }
}

export function matchingBackupConfigs(dbDir: string, configs: AccountConfig[]) {
  const parent = dirname(dbDir);
  const accountName = basename(parent) === 'nt_qq' ? basename(dirname(parent)) : basename(parent);
  const identities = new Set(
    configs
      .filter(
        (c) =>
          c.dataDir === dbDir ||
          accountName === c.uin ||
          (c.uid && accountName === linuxAccountDirName(c.uid)),
      )
      .map((c) => c.uin),
  );
  return configs.filter((c) => identities.has(c.uin));
}

export async function probeBackup(
  platform: Platform,
  configs: AccountConfig[],
  dbDir: string,
  options: {
    dbKey?: string;
    allowOnline: boolean;
    attachHook?: AttachHook;
    keyContext?: OtherDeviceKeyContext;
    resolveOnline?: () => Promise<OtherDeviceInstance[]>;
  },
) {
  const location = await resolveBackupLocation(dbDir);
  if (!location) return { ok: false as const, error: '未找到 QQ 账号数据库目录' };
  dbDir = location.dbDir;
  let matches = matchingBackupConfigs(dbDir, configs);
  const parent = dirname(dbDir);
  const accountName = basename(parent) === 'nt_qq' ? basename(dirname(parent)) : basename(parent);
  let identityError = '';
  if (
    !matches.length &&
    /^nt_qq_[0-9a-f]{32}$/i.test(accountName) &&
    options.allowOnline &&
    options.resolveOnline
  ) {
    try {
      const online = await options.resolveOnline();
      const resolved = configs.map((record) => ({
        ...record,
        uid: online.find((item) => item.uin === record.uin)?.uid || record.uid,
      }));
      matches = matchingBackupConfigs(dbDir, resolved);
    } catch (cause) {
      identityError = cause instanceof Error ? cause.message : String(cause);
    }
  }
  const namedAccount =
    basename(dbDir) === 'nt_db' &&
    (/^\d+$/.test(accountName) || /^nt_qq_[0-9a-f]{32}$/i.test(accountName));
  const eligible = matches.length ? matches : namedAccount ? [] : configs;
  const candidates: Array<{ key?: string; mobile?: boolean; source?: string; uin?: string }> = [];
  if (options.dbKey) candidates.push({ key: options.dbKey, source: 'manual' });
  else {
    candidates.push({});
    for (const c of eligible)
      if (c.dbKey) candidates.push({ key: c.dbKey, source: 'saved', uin: c.uin, mobile: c.mobile });
  }
  const loginDbPaths = backupLoginDbPaths(platform);
  const test = async (candidate: (typeof candidates)[number]) => {
    const result = await runBackupProbe({
      dirPath: dbDir,
      dbKey: candidate.key,
      expectedUin: candidate.uin,
      ...(loginDbPaths.length ? { loginDbPaths } : {}),
    });
    if (result.status === 'needKey') return null;
    if (result.status === 'error') return { error: result.error };
    const preview = result.preview;
    if (candidate.uin && candidate.uin !== preview.uin) return { error: '数据库账号与配置不匹配' };
    return {
      ok: true as const,
      needKey: false as const,
      derivedKey: result.dbKey,
      mobile: result.mobile || candidate.mobile || false,
      keySource: result.mobile ? 'android' : candidate.source,
      preview: {
        uin: preview.uin,
        uid: preview.uid,
        displayName: preview.displayName,
        avatarUrl: preview.avatarUrl,
      },
    };
  };
  let lastError =
    identityError ||
    (namedAccount && !eligible.length ? '未找到同账号已有配置，可手动输入密钥或先配置该账号' : '');
  for (const candidate of candidates) {
    try {
      const result = await test(candidate);
      if (result && !('error' in result)) return result;
      if (result) lastError = result.error ?? '备份数据库探测失败';
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (options.dbKey) return { ok: false as const, error: lastError };
  // 平铺备份由服务端校验 salt 归属，再以解密后的资料验证账号；必要时走现有提权流程。
  const requested = new Set<string>();
  if (options.allowOnline)
    for (const c of eligible) {
      if (requested.has(c.uin)) continue;
      requested.add(c.uin);
      try {
        const key = await fetchOtherDeviceDatabaseKey(
          platform,
          configs,
          options.attachHook,
          join(dbDir, 'nt_msg.db'),
          {
            enabled: options.allowOnline,
            expectedUin: c.uin,
            context: options.keyContext,
            resolveOnline:
              options.resolveOnline ??
              (async () => {
                const pid = platform.resolveQqPid(c.uin);
                return pid ? [{ pid, uin: c.uin, uid: c.uid ?? '' }] : [];
              }),
          },
        );
        if (!key.success) {
          lastError = key.error;
          continue;
        }
        const result = await test({ key: key.key, uin: key.uin, source: 'other-device' });
        if (result && !('error' in result)) return result;
        if (result) lastError = result.error ?? '备份数据库探测失败';
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  return { ok: true as const, needKey: true as const, error: lastError };
}

/** 与 QQ NT 在各桌面平台共用的 nt_data 相对布局一致。 */
export function backupMediaRoots(
  mediaDir: string,
  accountDir?: string,
): Partial<Record<MediaDirKey, string>> {
  const emoji = join(mediaDir, 'Emoji');
  return {
    accountDir:
      accountDir ??
      (basename(dirname(mediaDir)) === 'nt_qq' ? dirname(dirname(mediaDir)) : dirname(mediaDir)),
    ntDataDir: mediaDir,
    picDir: join(mediaDir, 'Pic'),
    pttDir: join(mediaDir, 'Ptt'),
    videoDir: join(mediaDir, 'Video'),
    fileDir: join(mediaDir, 'File'),
    emojiResourceDir: join(emoji, 'BaseEmojiSyastems', 'EmojiSystermResource'),
    marketFaceDir: join(emoji, 'marketface'),
    emojiRecvDir: join(emoji, 'emoji-recv'),
    personalEmojiDir: join(emoji, 'personal_emoji'),
    emojiRelatedDir: join(emoji, 'emoji-related', 'emoji'),
  };
}
