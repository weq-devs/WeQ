import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { NtHelperBinding } from '@weq/native';
import { getHost, type HostBridge } from '../common/host';
import { downloadUrlToFile } from './media_url';

export const DRESS_INDEX_KINDS = ['bubble', 'font', 'widget'] as const;
export type DressIndexKind = (typeof DRESS_INDEX_KINDS)[number];

export interface DressIndexManifest {
  schemaVersion: 1;
  tag: string;
  nativeCommit: string;
  format: 'ntdr-v1';
  baseUrl: string;
  parts: Record<DressIndexKind, { asset: string; sha256: string; size: number }>;
}

export interface DressIndexState {
  kind: DressIndexKind;
  status: 'idle' | 'downloading' | 'ready' | 'failed';
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
}

export interface DressIndexEvent {
  store: DressIndexStore;
  state: DressIndexState;
}

const listeners = new Set<(event: DressIndexEvent) => void>();
let configured: { manifest: DressIndexManifest; legacyDirectory?: string } | null = null;
const stores = new Map<string, DressIndexStore>();

export function parseDressIndexManifest(value: unknown): DressIndexManifest {
  if (!value || typeof value !== 'object') throw new Error('装扮索引清单不是对象');
  const data = value as Record<string, unknown>;
  if (
    data.schemaVersion !== 1 ||
    data.format !== 'ntdr-v1' ||
    typeof data.tag !== 'string' ||
    !/^dress-[a-zA-Z0-9._-]+$/.test(data.tag) ||
    typeof data.nativeCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(data.nativeCommit) ||
    typeof data.baseUrl !== 'string' ||
    !data.parts ||
    typeof data.parts !== 'object'
  )
    throw new Error('装扮索引版本或源 native 身份无效');
  const url = new URL(data.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('装扮索引下载地址无效');
  const parts = data.parts as Record<string, unknown>;
  for (const kind of DRESS_INDEX_KINDS) {
    const part = parts[kind] as Record<string, unknown> | undefined;
    if (
      !part ||
      part.asset !== `dress-${kind}.dat` ||
      typeof part.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(part.sha256) ||
      !Number.isSafeInteger(part.size) ||
      Number(part.size) < 22 ||
      Number(part.size) > 64 * 1024 * 1024
    )
      throw new Error(`装扮索引类别清单无效：${kind}`);
  }
  return value as DressIndexManifest;
}

/** 清单由宿主读取随应用发布的固定版本，不访问远端 latest。 */
export function configureDressIndexResources(input: {
  manifest: unknown;
  legacyDirectory?: string;
}): void {
  configured = { ...input, manifest: parseDressIndexManifest(input.manifest) };
}

export function subscribeDressIndexResources(listener: (event: DressIndexEvent) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDressIndexStore(sharedDirectory: string, native: NtHelperBinding) {
  if (!configured || native.getBuildInfo?.().isDev === true) return null;
  const key = `${resolve(sharedDirectory)}:${configured.manifest.tag}`;
  let store = stores.get(key);
  if (!store) {
    store = new DressIndexStore(join(sharedDirectory, 'index'), configured.manifest, {
      legacyDirectory: configured.legacyDirectory,
    });
    stores.set(key, store);
  }
  return store;
}

interface DressIndexOptions {
  legacyDirectory?: string;
  download?: typeof downloadUrlToFile;
  now?: () => number;
}

/** 一个宿主共用索引文件；已装素材路径不经过此服务。 */
export class DressIndexStore {
  readonly directory: string;
  private readonly pending = new Map<DressIndexKind, Promise<boolean>>();
  private readonly verified = new Set<DressIndexKind>();
  private readonly legacyChecked = new Set<DressIndexKind>();
  private readonly failedAt = new Map<DressIndexKind, number>();
  private readonly states = new Map<DressIndexKind, DressIndexState>();
  private revision = 0;

  constructor(
    directory: string,
    readonly manifest: DressIndexManifest,
    private readonly options: DressIndexOptions = {},
  ) {
    parseDressIndexManifest(manifest);
    this.directory = join(directory, manifest.tag);
  }

  snapshot(): DressIndexState[] {
    return DRESS_INDEX_KINDS.map(
      (kind) =>
        this.states.get(kind) ?? {
          kind,
          status: 'idle',
          downloadedBytes: 0,
          totalBytes: this.manifest.parts[kind].size,
        },
    );
  }

  getRevision() {
    return this.revision;
  }

  private update(kind: DressIndexKind, patch: Partial<DressIndexState>) {
    const state: DressIndexState = {
      kind,
      status: 'idle',
      downloadedBytes: 0,
      totalBytes: this.manifest.parts[kind].size,
      ...this.states.get(kind),
      ...patch,
    };
    this.states.set(kind, state);
    for (const listener of listeners) {
      try {
        listener({ store: this, state: { ...state } });
      } catch {
        /* 展示失败不影响下载。 */
      }
    }
  }

  async resolve(
    native: NtHelperBinding,
    kind: DressIndexKind,
    itemId: string,
    part: string,
    options: { background?: boolean } = {},
  ): Promise<ReturnType<NtHelperBinding['queryDressResourceUrl']>> {
    const legacy = native.queryDressResourceUrl(kind, itemId, part);
    if (legacy) {
      this.preserveLegacy(kind);
      return legacy;
    }
    if (!this.verified.has(kind) || !existsSync(join(this.directory, `${kind}.dat`))) {
      const prepared = this.ensure(kind);
      if (options.background) {
        // 在线协议无需等待静态下载；就绪事件会让失败的消息装扮重新解析。
        void prepared.catch(() => false);
        return null;
      }
      if (!(await prepared)) return null;
    }
    const previous = process.env.NT_HELPER_DRESS_DIR;
    try {
      // native 查询是同步调用，目录覆盖不跨越任何异步边界。
      process.env.NT_HELPER_DRESS_DIR = this.directory;
      return native.queryDressResourceUrl(kind, itemId, part);
    } finally {
      if (previous === undefined) delete process.env.NT_HELPER_DRESS_DIR;
      else process.env.NT_HELPER_DRESS_DIR = previous;
    }
  }

  private preserveLegacy(kind: DressIndexKind): void {
    if (!this.options.legacyDirectory || this.legacyChecked.has(kind)) return;
    this.legacyChecked.add(kind);
    const source = join(this.options.legacyDirectory, `${kind}.dat`);
    // 命中的旧索引后台迁入用户目录；校验不符的未知文件不触发下载或覆盖。
    void this.matches(source, kind)
      .then((matches) => (matches ? this.ensure(kind) : false))
      .catch(() => false);
  }

  ensure(kind: DressIndexKind, retry = false): Promise<boolean> {
    const pending = this.pending.get(kind);
    if (pending) return pending;
    if (this.verified.has(kind) && existsSync(join(this.directory, `${kind}.dat`)))
      return Promise.resolve(true);
    const now = this.options.now ?? Date.now;
    if (!retry && now() - (this.failedAt.get(kind) ?? -Infinity) < 60_000)
      return Promise.resolve(false);
    const task = this.prepare(kind).finally(() => this.pending.delete(kind));
    this.pending.set(kind, task);
    return task;
  }

  private async matches(path: string, kind: DressIndexKind): Promise<boolean> {
    try {
      const info = await lstat(path);
      const expected = this.manifest.parts[kind];
      if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.size) return false;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return hash.digest('hex') === expected.sha256;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async prepare(kind: DressIndexKind): Promise<boolean> {
    const target = join(this.directory, `${kind}.dat`);
    const incoming = `${target}.${randomUUID()}.incoming`;
    const part = this.manifest.parts[kind];
    try {
      await mkdir(this.directory, { recursive: true });
      if (!(await this.matches(target, kind))) {
        const legacy =
          this.options.legacyDirectory && join(this.options.legacyDirectory, `${kind}.dat`);
        if (legacy && (await this.matches(legacy, kind))) {
          await copyFile(legacy, incoming, constants.COPYFILE_FICLONE);
        } else {
          this.update(kind, { status: 'downloading', downloadedBytes: 0, error: undefined });
          let fetcher: HostBridge['fetchMedia'];
          try {
            fetcher = getHost().fetchMedia;
          } catch {
            /* 纯 Node 测试无宿主。 */
          }
          let lastProgressAt = 0;
          const result = await (this.options.download ?? downloadUrlToFile)(
            `${this.manifest.baseUrl.replace(/\/$/, '')}/${part.asset}`,
            incoming,
            {
              expectedSize: part.size,
              expectedSha256: part.sha256,
              maxBytes: part.size,
              attempts: 2,
              fetcher,
              onProgress: (downloadedBytes) => {
                const now = Date.now();
                if (now - lastProgressAt < 200 && downloadedBytes < part.size) return;
                lastProgressAt = now;
                this.update(kind, { downloadedBytes });
              },
            },
          );
          if (!result.ok) throw new Error(result.reason);
        }
        if (!(await this.matches(incoming, kind))) throw new Error('装扮索引大小或哈希校验失败');
        await rename(incoming, target);
      }
      this.verified.add(kind);
      this.failedAt.delete(kind);
      this.revision += 1;
      this.update(kind, { status: 'ready', downloadedBytes: part.size, error: undefined });
      return true;
    } catch (error) {
      this.failedAt.set(kind, (this.options.now ?? Date.now)());
      this.update(kind, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      await rm(incoming, { force: true });
    }
  }
}
