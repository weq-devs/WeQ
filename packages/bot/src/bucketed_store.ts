/**
 * 按键分桶的 JSON 存储（可选布局，`config.storage.bucketed` 开启；缺省仍为单文件 BotJsonFile）。
 *
 * 动机：单文件布局下每次写入都是整文件 validate + stringify + fsync，且启动即把
 * 全部对端（scope）的数据常驻内存。多对端 bot（记忆带向量时单库可达数十 MB）下，
 * 这是消息热路径的耗时下限与常驻内存大头（#118 消除深拷贝后剩余的结构性瓶颈）。
 *
 * 布局：`<dir>/<hex(key)>.json` 每键一个文件（hex 编码兼容含 `/` `:` 的 scope 键）。
 * - **惰性加载 + LRU**：只缓存最近使用的至多 maxBuckets 个桶；淘汰只丢内存副本
 *   （写入永远同步落盘，无丢数据窗口），下次访问再从磁盘读回；
 * - **写入只动单键文件**：校验 value → stringify → 原子写（tmp + fsync + rename）→
 *   深冻结发布进缓存，与 BotJsonFile 同款契约（失败不发布、损坏原件拒绝加载）；
 * - **legacy 迁移**：目录不存在且旧单文件存在时，一次性拆分为桶文件并把旧文件
 *   改名为 `<name>.json.migrated` 保留；迁移中途失败可重入（以旧文件为准重拆）。
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { deepFreeze } from './json_file';

export function bucketFileName(key: string): string {
  return `${Buffer.from(key, 'utf8').toString('hex')}.json`;
}

export function bucketKeyOf(fileName: string): string | null {
  if (!fileName.endsWith('.json')) return null;
  const hex = fileName.slice(0, -'.json'.length);
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  try {
    return Buffer.from(hex, 'hex').toString('utf8');
  } catch {
    return null;
  }
}

export interface BucketedJsonDirOptions {
  /** 内存中最多缓存的桶数（LRU 淘汰；默认 64）。写入不受影响——永远同步落盘。 */
  maxBuckets?: number;
}

export class BucketedJsonDir<V> {
  private readonly cache = new Map<string, V>();
  private readonly maxBuckets: number;

  constructor(
    readonly dir: string,
    private readonly validValue: (raw: unknown) => raw is V,
    opts: BucketedJsonDirOptions = {},
  ) {
    this.maxBuckets = Math.max(1, opts.maxBuckets ?? 64);
    mkdirSync(dir, { recursive: true });
  }

  private bucketPath(key: string): string {
    return join(this.dir, bucketFileName(key));
  }

  /** 读一个键：缓存命中直接返回（冻结数据），未命中从磁盘惰性加载并校验。 */
  get(key: string): V | undefined {
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      // LRU：命中即移到最近端。
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const path = this.bucketPath(key);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(`读取 Bot 存储桶失败，原件已保留：${path}`, { cause: error });
    }
    if (!this.validValue(raw)) throw new Error(`Bot 存储桶结构无效，原件已保留：${path}`);
    const value = deepFreeze(raw);
    this.publish(key, value);
    return value;
  }

  /** 写一个键：校验 → 序列化 → 原子落盘成功后才发布进缓存（冻结）。 */
  set(key: string, value: V): void {
    this.persist(key, value);
    this.publish(key, deepFreeze(value));
  }

  /** 校验 + 原子落盘，不动缓存（迁移专用：避免把全部桶灌进内存，保持惰性加载收益）。 */
  private persist(key: string, value: V): void {
    if (!this.validValue(value)) throw new Error('Bot 存储结构无效，未保存变更');
    const data = JSON.stringify(value);
    const path = this.bucketPath(key);
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, data, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, path);
    } catch (error) {
      throw new Error(`保存 Bot 存储失败，未提交变更：${path}`, { cause: error });
    } finally {
      try {
        if (fd !== undefined) closeSync(fd);
      } finally {
        try {
          unlinkSync(tmp);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            console.error('Bot 存储临时文件清理失败');
        }
      }
    }
  }

  /** 当前目录里的全部键（readdir + 文件名解码；不入缓存）。 */
  keys(): string[] {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const out: string[] = [];
    for (const file of files) {
      const key = bucketKeyOf(file);
      if (key !== null) out.push(key);
    }
    return out;
  }

  /** 测试/诊断用：当前内存缓存的桶数。 */
  get cachedCount(): number {
    return this.cache.size;
  }

  private publish(key: string, value: V): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > this.maxBuckets) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  /**
   * legacy 单文件 → 分桶目录的一次性迁移。返回是否执行了迁移。
   * 旧文件校验通过后逐键原子写入桶文件，最后把旧文件改名 `.migrated` 保留；
   * 目录已存在非空且旧文件也在时视为上次迁移未完成，以旧文件为准重拆（可重入）。
   */
  static migrateLegacy<V>(
    legacyPath: string,
    dir: string,
    validWhole: (raw: unknown) => raw is Record<string, V>,
    validValue: (raw: unknown) => raw is V,
    opts: BucketedJsonDirOptions = {},
  ): BucketedJsonDir<V> | null {
    let wholeRaw: unknown;
    try {
      wholeRaw = JSON.parse(readFileSync(legacyPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`读取 Bot 存储失败，原件已保留：${legacyPath}`, { cause: error });
    }
    if (!validWhole(wholeRaw)) throw new Error(`Bot 存储结构无效，原件已保留：${legacyPath}`);
    const target = new BucketedJsonDir<V>(dir, validValue, opts);
    // 只落盘不灌缓存：迁移后保持惰性加载，内存只驻留真正被访问的热桶。
    for (const [key, value] of Object.entries(wholeRaw)) {
      target.persist(key, value);
    }
    renameSync(legacyPath, `${legacyPath}.migrated`);
    return target;
  }
}

/** 供 store 构造用：legacy 文件存在则迁移，否则直接开目录。 */
export function openBucketed<V>(
  legacyPath: string,
  dir: string,
  validWhole: (raw: unknown) => raw is Record<string, V>,
  validValue: (raw: unknown) => raw is V,
  opts: BucketedJsonDirOptions = {},
): BucketedJsonDir<V> {
  const migrated = BucketedJsonDir.migrateLegacy(legacyPath, dir, validWhole, validValue, opts);
  if (migrated) return migrated;
  return new BucketedJsonDir<V>(dir, validValue, opts);
}

/** 迁移后清理入口（保留原件语义下手动确认后再删）。 */
export function removeMigratedLegacy(legacyPath: string): void {
  rmSync(`${legacyPath}.migrated`, { force: true });
}
