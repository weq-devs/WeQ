import { lstat, readdir, realpath, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

export type SearchCacheTable = 'buddy_msg_fts' | 'group_msg_fts';
export type SearchRetirementResult = { status: 'retired' | 'absent' | 'busy' | 'unrecognized' };
export interface SearchRetirementOptions {
  root: string;
  table: SearchCacheTable;
  sourcePath: string;
  inspect: (path: string) => Promise<boolean>;
  unheld: (paths: string[]) => Promise<boolean>;
  signal?: AbortSignal;
  remove?: (path: string) => Promise<void>;
}
interface Receipt {
  version: 1;
  table: SearchCacheTable;
  target: string;
  phase: 'planned' | 'renamed' | 'complete';
}
const allowed = new Set(['index.db', 'index.db-wal', 'index.db-shm']);
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function save(path: string, state: Receipt) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** 仅退役已验证的自建索引目录；不复制大库，原库与未知文件不参与删除。 */
async function retireUnlocked(options: SearchRetirementOptions): Promise<SearchRetirementResult> {
  const { root, table, sourcePath, inspect, unheld, signal } = options;
  signal?.throwIfAborted();
  if (!['buddy_msg_fts', 'group_msg_fts'].includes(table)) throw new Error('搜索缓存来源无效');
  if (!(await exists(root))) return { status: 'absent' };
  const canonicalRoot = await realpath(root),
    source = await realpath(sourcePath);
  const directory = join(canonicalRoot, table),
    journal = join(canonicalRoot, `.${table}-retirement.json`);
  const validate = async (target: string, partial = false) => {
    const info = await lstat(target);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      dirname(await realpath(target)) !== canonicalRoot
    )
      return false;
    const entries = await readdir(target);
    if (!partial && !entries.includes('index.db')) return false;
    for (const entry of entries) {
      if (!allowed.has(entry)) return false;
      const path = join(target, entry),
        item = await lstat(path);
      if (!item.isFile() || item.isSymbolicLink() || (await realpath(path)) === source)
        return false;
    }
    return entries.includes('index.db') ? inspect(join(target, 'index.db')) : partial;
  };
  let state: Receipt | undefined;
  if (await exists(journal)) {
    const value: unknown = JSON.parse(await readFile(journal, 'utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== 1 ||
      !('table' in value) ||
      value.table !== table ||
      !('target' in value) ||
      typeof value.target !== 'string' ||
      !('phase' in value) ||
      !['planned', 'renamed', 'complete'].includes(String(value.phase))
    )
      return { status: 'unrecognized' };
    const target = value.target;
    if (
      dirname(target) !== canonicalRoot ||
      !new RegExp(`^\\.retired-${table}-[0-9a-f-]{36}$`).test(basename(target)) ||
      relative(canonicalRoot, target).startsWith('..')
    )
      return { status: 'unrecognized' };
    state = { version: 1, table, target, phase: value.phase as Receipt['phase'] };
    if (state.phase === 'complete' && !(await exists(directory))) return { status: 'retired' };
  }
  if (!state || state.phase === 'complete') {
    if (!(await exists(directory))) return { status: 'absent' };
    if (!(await validate(directory))) return { status: 'unrecognized' };
    if (!(await unheld([...allowed].map((name) => join(directory, name)))))
      return { status: 'busy' };
    signal?.throwIfAborted();
    state = {
      version: 1,
      table,
      target: join(canonicalRoot, `.retired-${table}-${randomUUID()}`),
      phase: 'planned',
    };
    await save(journal, state);
  }
  if (state.phase === 'planned' && !(await exists(state.target))) {
    if (!(await exists(directory))) return { status: 'unrecognized' };
    if (!(await validate(directory))) return { status: 'unrecognized' };
    if (!(await unheld([...allowed].map((name) => join(directory, name)))))
      return { status: 'busy' };
    signal?.throwIfAborted();
    await rename(directory, state.target);
  }
  if (await exists(state.target)) {
    if (!(await validate(state.target, state.phase === 'renamed')))
      return { status: 'unrecognized' };
    if (!(await unheld([...allowed].map((name) => join(state!.target, name)))))
      return { status: 'busy' };
    state.phase = 'renamed';
    await save(journal, state);
    signal?.throwIfAborted();
    if (options.remove) await options.remove(state.target);
    else await rm(state.target, { recursive: true });
  }
  state.phase = 'complete';
  await save(journal, state);
  return { status: 'retired' };
}

/** SQLite 的进程间锁随进程退出自动释放；只保存一个空的微型锁文件，不复制索引。 */
export async function retireSearchIndex(
  options: SearchRetirementOptions,
): Promise<SearchRetirementResult> {
  options.signal?.throwIfAborted();
  if (!(await exists(options.root))) return { status: 'absent' };
  const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite',
  ) as typeof import('node:sqlite');
  const lock = new DatabaseSync(
    join(await realpath(options.root), '.search-index-retirement.lock.db'),
  );
  let acquired = false;
  try {
    try {
      lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
      acquired = true;
    } catch {
      return { status: 'busy' };
    }
    return await retireUnlocked(options);
  } finally {
    if (acquired) lock.exec('ROLLBACK');
    lock.close();
  }
}
