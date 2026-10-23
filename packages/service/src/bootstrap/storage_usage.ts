import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface StorageRoot {
  path: string;
  label: string;
  /** 宿主明确拥有的运行数据；安装资源不得开启。 */
  clearableAfterExit?: boolean;
  protected?: boolean;
  /** 独立业务根的损失说明，不能用通用运行缓存话术代替。 */
  confirmation?: string;
}

export interface StorageUsageItem {
  id: string;
  label: string;
  path: string;
  bytes: number;
  clearable: boolean;
  reason: string;
  incomplete: boolean;
  /** 混合目录只清理下载器拥有的文件，不能整目录删除。 */
  cleanupKind?: 'dress-previews' | 'dress-shared' | 'dress-data';
  /** 清理确认中需要额外告知的影响。 */
  confirmation?: string;
  requiresExit?: boolean;
}

// 只开放无长期状态、无打开的数据库句柄的下载/解码缓存。
const CACHE_LABELS: Readonly<Record<string, string>> = {
  avatar: '头像缓存',
  media: '图片/视频缓存',
  marketface: '商城表情缓存',
  marketpack: '商城表情包缓存',
  voice: '语音解码缓存',
  linkpreview: '链接预览缓存',
  sysemoji: '系统表情缓存',
  collection: '收藏媒体缓存',
  qqshow: 'QQ 秀资源缓存',
  dress_shared: '共享装扮资源缓存',
};

const DATA_LABELS: Readonly<Record<string, string>> = {
  ocr: '图片识别结果',
  agentlab: '好友克隆数据',
  'weq-assistant': 'WeQ 助手数据',
  export: '导出文件与任务',
  'merge-forward': '合并转发草稿与归档',
  'search-index': '全文搜索索引',
  'content-search': '内容搜索记录',
  'roam-msg': '漫游消息数据库',
  'roaming-jobs': '漫游任务记录',
  'collection-history': '收藏历史',
  deleted: '本地删除记录',
  anti_recall: '防撤回配置',
  api_usage: 'API 用量记录',
  intent_sense: '意图感知结果',
  dress: '装扮配置与自定义背景',
  dress_shared: '共享装扮资源',
  flash: '闪传文件',
  db_tolerance: '数据库容错数据',
  'db-repair': '数据库修复工作区',
  db_repair: '数据库修复工作区',
  dbfix: '历史数据库修复数据',
  dbfix2: '历史数据库修复数据',
  qqshow: 'QQ 秀资源',
  'managed-qq': '托管 QQ 数据与运行环境',
  diagnostics: '诊断文件',
  'protocol-research': '协议调试数据',
  models: '本地模型',
  config: '账号与应用配置',
  'config.json': '全局配置',
  logs: '运行日志',
  'remote-network': '远程连接状态',
  'web-exports': 'Web 导出文件',
  restore: '设置恢复暂存数据',
};

const RUNTIME_DATA_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Local Storage',
  'Session Storage',
  'Service Worker',
  'SharedStorage',
  'SharedStorage-wal',
  'Network',
  'Cookies',
  'Cookies-journal',
  'Preferences',
  'Secure Preferences',
  'Local State',
  'Partitions',
  'IndexedDB',
  'blob_storage',
  'databases',
  'WebStorage',
  'VideoDecodeStats',
  'Trust Tokens',
  'Trust Tokens-journal',
  'DIPS',
  'DIPS-wal',
  'TransportSecurity',
  'Network Persistent State',
  'Crashpad',
  'Crash Reports',
  'Session Cookies',
  'Session Cookies-journal',
  'BrowserMetrics',
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'lockfile',
  'media_device_salt',
  'QuotaManager',
  'QuotaManager-journal',
  'Web Data',
  'Web Data-journal',
  'Extension State',
]);

const DATA_RISKS: Readonly<Record<string, string>> = {
  ocr: '将丢失已保存的文字识别结果；原图片过期或缺失时无法重新识别。',
  agentlab: '将删除好友克隆的配置、对话、记忆与训练数据，无法自动恢复。',
  'weq-assistant': '将删除助手对话、记忆与本地资料，无法自动恢复。',
  export: '将删除应用内部的导出文件、任务和进度；未另存的导出成果会丢失。',
  'web-exports': '将删除 Web 导出文件，已有下载链接将失效。',
  'merge-forward': '将删除合并转发草稿、归档与本地附件，无法自动恢复。',
  'search-index': '将删除全文搜索索引，下次搜索需要重新建立。',
  'content-search': '将删除搜索观察记录及其保存的消息，未保存在原库中的内容可能无法恢复。',
  'roam-msg': '将删除已获取的漫游消息；云端过期后可能无法再次获取。',
  'roaming-jobs': '将删除漫游任务、进度与覆盖记录，未完成的任务不会继续。',
  'collection-history': '将删除收藏历史快照，云端已删除的内容可能无法恢复。',
  deleted: '将删除本地删除记录，原先隐藏的消息可能重新出现。',
  anti_recall: '将删除防撤回设置；不会修改 QQ 原库或替你卸载已安装的 QQ 触发器。',
  api_usage: '将删除 API 用量与费用统计，不会撤销实际产生的服务商费用。',
  intent_sense: '将删除意图分析结果、会话偏好与相关配置，重新分析可能产生费用。',
  dress: '将删除装扮预览、旧配置和自定义背景原件，未备份的背景无法恢复。',
  flash: '将删除本地闪传文件；云端已过期的文件无法重新下载。',
  db_tolerance: '将删除数据库容错设置、坏页与隔离记录；不会修复损坏数据库。',
  models: '将删除本地模型，下次使用需重新下载，离线功能将暂时不可用。',
  'managed-qq':
    '请先完全退出托管 QQ 并备份需要的内容；此目录可能包含本地聊天数据库、媒体和登录状态，清除后可能永久丢失，不能只按安装缓存处理。',
  config: '将删除账号密钥、认证及应用配置，需要重新配置或登录。QQ 原始聊天库不会删除。',
  'config.json': '将重置全局设置，自动进入、服务、主题等偏好会丢失。',
  'remote-network': '将删除远程连接身份与状态，设备可能需要重新配对。',
  logs: '将删除运行日志，已发生问题的排查证据无法恢复。',
  diagnostics: '将删除诊断报告与故障证据，无法自动恢复。',
  'protocol-research': '将删除协议调试记录及捕获原件，无法自动恢复。',
};

function dataRisk(name: string): string {
  if (['db-repair', 'db_repair', 'dbfix', 'dbfix2'].includes(name)) {
    return '将删除修复备份、报告及历史记录，失去回滚能力；不会删除 QQ 原始数据库。';
  }
  return DATA_RISKS[name] ?? '将删除此项本地数据，可能失去登录状态或历史记录，无法保证恢复。';
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

/** 与 MediaCacheService.basePath / readFromDisk 的 sha1(URL) 图片命名一致。 */
export async function listDressPreviewFiles(
  path: string,
): Promise<{ files: string[]; bytes: number; incomplete: boolean }> {
  const files: string[] = [];
  let bytes = 0;
  let incomplete = false;
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return { files, bytes, incomplete };
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length > 500_000) return { files, bytes, incomplete: true };
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f]{40}\.(png|jpg|gif|webp)$/.test(entry.name)) continue;
      try {
        const file = join(path, entry.name);
        const stat = await lstat(file);
        if (!stat.isFile()) continue;
        files.push(file);
        bytes += stat.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incomplete = true;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incomplete = true;
  }
  return { files, bytes, incomplete };
}

/** 按最具体的根归属计数；自定义缓存、旧默认缓存、Electron profile 可以互相嵌套。 */
export async function listStorageUsage(
  dataRoot: string,
  cacheRoot: string,
  extraRoots: readonly StorageRoot[] = [],
): Promise<StorageUsageItem[]> {
  const roots: Array<StorageRoot & { cache: boolean; active: boolean; primary: boolean }> = [];
  for (const item of [
    { path: cacheRoot, label: '缓存', cache: true, active: true, primary: false },
    {
      path: join(dataRoot, 'cache'),
      label: '默认缓存',
      cache: true,
      active: false,
      primary: false,
    },
    { path: dataRoot, label: 'WeQ 数据', cache: false, active: false, primary: true },
    ...extraRoots.map((root) => ({ ...root, cache: false, active: false, primary: false })),
  ]) {
    const path = await canonical(item.path);
    const existing = roots.find((root) => root.path === path);
    if (!existing) roots.push({ ...item, path });
    else if (!existing.cache && item.clearableAfterExit) existing.clearableAfterExit = true;
  }
  const items: StorageUsageItem[] = [];
  for (const root of roots) {
    let entries: import('node:fs').Dirent[];
    try {
      const info = await lstat(root.path);
      if (!info.isDirectory()) {
        items.push({
          id: `storage:${root.path}`,
          label: root.label,
          path: root.path,
          bytes: info.size,
          clearable: !root.protected && root.clearableAfterExit === true && !info.isSymbolicLink(),
          requiresExit: !root.protected && root.clearableAfterExit === true,
          reason: root.clearableAfterExit
            ? '退出应用后清除；文件无法保证恢复'
            : '应用安装资源，请通过系统卸载管理',
          ...(root.clearableAfterExit
            ? {
                confirmation:
                  root.confirmation ?? '此项是应用运行文件，删除后可能需要重新登录或下载。',
              }
            : {}),
          incomplete: false,
        });
        continue;
      }
      entries = await readdir(root.path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        items.push({
          id: `storage:${root.path}`,
          label: root.label,
          path: root.path,
          bytes: 0,
          clearable: false,
          reason: '目录不可读取，占用统计不完整',
          incomplete: true,
        });
      }
      continue;
    }
    const names = new Set(entries.map((entry) => entry.name));
    if (root.cache && root.active) for (const name of Object.keys(CACHE_LABELS)) names.add(name);
    const excluded = roots
      .filter((other) => other !== root && contains(root.path, other.path))
      .map((other) => other.path);
    for (const name of [...names].sort()) {
      const path = join(root.path, name);
      if (excluded.includes(path)) continue;
      const nested = excluded.filter((other) => contains(path, other));
      const entry = entries.find((entry) => entry.name === name);
      const previews =
        root.cache && name === 'dress' && entry?.isDirectory() && nested.length === 0
          ? await listDressPreviewFiles(path)
          : undefined;
      const size = await measureStorage(path, new Set([...nested, ...(previews?.files ?? [])]));
      if (previews) {
        items.push({
          id: `storage:dress-previews:${path}`,
          label: root.active ? '装扮预览图片' : '装扮预览图片（默认目录）',
          path,
          bytes: previews.bytes,
          clearable: !previews.incomplete && !size.incomplete,
          reason: '只清理下载的预览图片，保留自定义背景和旧版装扮配置',
          incomplete: previews.incomplete || size.incomplete,
          cleanupKind: 'dress-previews',
        });
      }
      const safeCache =
        root.cache &&
        Object.hasOwn(CACHE_LABELS, name) &&
        nested.length === 0 &&
        !entry?.isSymbolicLink() &&
        (!entry || entry.isDirectory()) &&
        !size.incomplete;
      const persistent =
        !root.protected &&
        name !== 'storage-maintenance' &&
        !['.ds_store', 'thumbs.db', 'desktop.ini'].includes(name.toLowerCase()) &&
        !safeCache &&
        (Object.hasOwn(DATA_LABELS, name) ||
          (root.clearableAfterExit === true && (!root.primary || RUNTIME_DATA_NAMES.has(name)))) &&
        nested.length === 0 &&
        !entry?.isSymbolicLink() &&
        !size.incomplete;
      const clearable = safeCache || persistent;
      const label =
        (root.cache && Object.hasOwn(CACHE_LABELS, name) ? CACHE_LABELS[name] : undefined) ??
        (Object.hasOwn(DATA_LABELS, name) ? DATA_LABELS[name] : undefined) ??
        name;
      items.push({
        id: root.active ? name : `storage:${path}`,
        label:
          root.cache && !root.active
            ? `${label}（默认目录）`
            : !root.cache && root.label !== 'WeQ 数据'
              ? `${root.label} / ${label}`
              : label,
        path,
        bytes: size.bytes,
        clearable,
        requiresExit: persistent,
        reason: persistent
          ? '退出应用后清除；请先确认风险并保留需要的副本'
          : clearable
            ? name === 'dress_shared'
              ? '清理已下载的字体、气泡与挂件，保留账号装扮设置'
              : '清理后按需重新下载或生成'
            : entry?.isSymbolicLink()
              ? '符号链接，仅统计链接本身，不清理目标'
              : size.incomplete
                ? '读取不完整，暂不提供清理'
                : name === 'models'
                  ? '由模型设置管理，避免删除正在使用的模型'
                  : '持久数据或运行中资源，不在此处直接清理',
        incomplete: size.incomplete,
        ...(safeCache && name === 'dress_shared' ? { cleanupKind: 'dress-shared' as const } : {}),
        ...(persistent && previews ? { cleanupKind: 'dress-data' as const } : {}),
        ...(persistent ? { confirmation: root.confirmation ?? dataRisk(name) } : {}),
        ...(safeCache && name === 'dress_shared'
          ? {
              confirmation:
                '共享装扮资源清理后，当前字体、气泡与挂件可能暂时不可用，重新进入账号后按需下载；装扮设置不会删除。',
            }
          : {}),
      });
    }
  }
  return items;
}

/** 不跟随目录中的符号链接；上限或读取失败必须显式标记，不能把部分结果冒充总量。 */
export async function measureStorage(
  root: string,
  excluded = new Set<string>(),
): Promise<{ bytes: number; incomplete: boolean }> {
  let bytes = 0;
  let visited = 0;
  let incomplete = false;
  const stack = [root];
  while (stack.length) {
    const batch = stack.splice(-32).filter((path) => !excluded.has(path));
    visited += batch.length;
    if (visited > 500_000) return { bytes, incomplete: true };
    await Promise.all(
      batch.map(async (path) => {
        try {
          const info = await lstat(path);
          if (info.isDirectory()) {
            for (const name of await readdir(path)) stack.push(join(path, name));
          } else if (info.isFile() || info.isSymbolicLink()) bytes += info.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incomplete = true;
        }
      }),
    );
  }
  return { bytes, incomplete };
}
