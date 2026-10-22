import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface StorageRoot {
  path: string;
  label: string;
}

export interface StorageUsageItem {
  id: string;
  label: string;
  path: string;
  bytes: number;
  clearable: boolean;
  reason: string;
  incomplete: boolean;
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
  dress: '装扮数据',
  dress_shared: '共享装扮资源',
  flash: '闪传文件',
  db_tolerance: '数据库容错数据',
  'db-repair': '数据库修复工作区',
  db_repair: '数据库修复工作区',
  dbfix: '历史数据库修复数据',
  dbfix2: '历史数据库修复数据',
  qqshow: 'QQ 秀资源',
  'managed-qq': '托管 QQ 运行环境',
  diagnostics: '诊断文件',
  'protocol-research': '协议调试数据',
  models: '本地模型',
  config: '账号与应用配置',
  'config.json': '全局配置',
  logs: '运行日志',
  'remote-network': '远程连接状态',
  'web-exports': 'Web 导出文件',
};

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

/** 按最具体的根归属计数；自定义缓存、旧默认缓存、Electron profile 可以互相嵌套。 */
export async function listStorageUsage(
  dataRoot: string,
  cacheRoot: string,
  extraRoots: readonly StorageRoot[] = [],
): Promise<StorageUsageItem[]> {
  const roots: Array<StorageRoot & { cache: boolean; active: boolean }> = [];
  for (const item of [
    { path: cacheRoot, label: '缓存', cache: true, active: true },
    { path: join(dataRoot, 'cache'), label: '默认缓存', cache: true, active: false },
    { path: dataRoot, label: 'WeQ 数据', cache: false, active: false },
    ...extraRoots.map((root) => ({ ...root, cache: false, active: false })),
  ]) {
    const path = await canonical(item.path);
    if (!roots.some((root) => root.path === path)) roots.push({ ...item, path });
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
          clearable: false,
          reason: '应用运行资源，不在此处直接清理',
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
      const size = await measureStorage(path, new Set(nested));
      const entry = entries.find((entry) => entry.name === name);
      const clearable =
        root.cache &&
        Object.hasOwn(CACHE_LABELS, name) &&
        nested.length === 0 &&
        !entry?.isSymbolicLink() &&
        (!entry || entry.isDirectory()) &&
        !size.incomplete;
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
        reason: clearable
          ? '清理后按需重新下载或生成'
          : entry?.isSymbolicLink()
            ? '符号链接，仅统计链接本身，不清理目标'
            : size.incomplete
              ? '读取不完整，暂不提供清理'
              : name === 'models'
                ? '由模型设置管理，避免删除正在使用的模型'
                : '持久数据或运行中资源，不在此处直接清理',
        incomplete: size.incomplete,
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
