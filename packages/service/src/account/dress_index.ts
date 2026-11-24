import { createHash } from 'node:crypto';
import { constants, createReadStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { NtHelperBinding } from '@weq/native';
import { getHost, type HostBridge } from '../common/host';
import type { downloadUrlToFile } from './media_url';
import { ManagedDownload } from '../common/managed_download';
import { writeFileAtomicSync } from '../common/atomic_write';

export const DRESS_INDEX_KINDS = ['bubble', 'font', 'widget'] as const;
export type DressIndexKind = (typeof DRESS_INDEX_KINDS)[number];

interface DressIndexManifestBase {
  schemaVersion: 1;
  tag: string;
  baseUrl: string;
  parts: Record<DressIndexKind, { asset: string; sha256: string; size: number }>;
}
export type DressIndexManifest = DressIndexManifestBase &
  ({ format: 'ntdr-v1'; nativeCommit: string } | { format: 'ntdr-v2'; keyId: string });

export interface DressIndexState {
  kind: DressIndexKind;
  status: 'idle' | 'downloading' | 'ready' | 'failed';
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
  paused?: boolean;
  pauseReasons?: string[];
  source?: string;
  attempt?: number;
  retryAt?: number;
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
    typeof data.tag !== 'string' ||
    !/^dress-[a-zA-Z0-9._-]+$/.test(data.tag) ||
    (data.format === 'ntdr-v1'
      ? typeof data.nativeCommit !== 'string' || !/^[a-f0-9]{40}$/.test(data.nativeCommit)
      : data.format !== 'ntdr-v2' ||
        typeof data.keyId !== 'string' ||
        !/^[a-f0-9]{32}$/.test(data.keyId)) ||
    typeof data.baseUrl !== 'string' ||
    !data.parts ||
    typeof data.parts !== 'object'
  )
    throw new Error('装扮索引版本或源 native 身份无效');
  const url = new URL(data.baseUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (data.format === 'ntdr-v2' && !url.pathname.endsWith(`/releases/download/${data.tag}`))
  )
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
      Number(part.size) < (data.format === 'ntdr-v2' ? 50 : 22) ||
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

export function getDressIndexStore(sharedDirectory: string, native?: NtHelperBinding) {
  if (
    !configured ||
    (native?.getBuildInfo?.().isDev === true && !native.getDressResourceKeyIds?.().length)
  )
    return null;
  const key = resolve(sharedDirectory);
  let store = stores.get(key);
  if (!store) {
    let manifest = configured.manifest;
    try {
      manifest = parseDressIndexManifest(
        JSON.parse(readFileSync(join(sharedDirectory, 'index/active.json'), 'utf8')),
      );
    } catch {
      /* 沿用应用内清单。 */
    }
    store = new DressIndexStore(join(sharedDirectory, 'index'), manifest, {
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

function nativeIdentity(native: NtHelperBinding, manifest: DressIndexManifest): [] | [string] {
  if (manifest.format === 'ntdr-v2') return [manifest.keyId];
  return native.getDressResourceKeyIds ? [manifest.nativeCommit] : [];
}

/** 一个宿主共用索引文件；已装素材路径不经过此服务。 */
export class DressIndexStore {
  public directory: string;
  private readonly transfers = new Map<DressIndexKind, ManagedDownload>();
  private manuallyPaused = false;
  private continued = false;
  private disabled = false;
  private readonly pending = new Map<DressIndexKind, Promise<boolean>>();
  private readonly localPending = new Set<DressIndexKind>();
  private readonly verified = new Set<DressIndexKind>();
  private readonly legacyChecked = new Set<DressIndexKind>();
  private readonly failedAt = new Map<DressIndexKind, number>();
  private readonly states = new Map<DressIndexKind, DressIndexState>();
  private revision = 0;

  constructor(
    private readonly root: string,
    public manifest: DressIndexManifest,
    private readonly options: DressIndexOptions = {},
  ) {
    parseDressIndexManifest(manifest);
    this.directory = join(root, manifest.tag);
    this.disabled = existsSync(join(this.directory, 'removed.json'));
  }
  disable() {
    this.disabled = true;
  }

  pause() {
    this.manuallyPaused = true;
    this.continued = false;
    for (const transfer of this.transfers.values()) transfer.pause();
  }
  resume() {
    this.manuallyPaused = false;
    this.continued = true;
    for (const transfer of this.transfers.values()) transfer.continue();
  }
  candidate(manifest: DressIndexManifest) {
    return new DressIndexStore(this.root, manifest, { legacyDirectory: this.directory });
  }
  restoreManifest(manifest: unknown) {
    this.manifest = parseDressIndexManifest(manifest);
    this.directory = join(this.root, this.manifest.tag);
    this.states.clear();
    this.verified.clear();
    this.revision++;
  }
  async validate(native: NtHelperBinding): Promise<boolean> {
    return !!(await native.validateDressResourceIndexes?.(
      this.directory,
      ...nativeIdentity(native, this.manifest),
    ));
  }
  async adopt(candidate: DressIndexStore, native: NtHelperBinding): Promise<() => Promise<void>> {
    if (
      !(await native.reloadDressResourceIndexes?.(
        candidate.directory,
        ...nativeIdentity(native, candidate.manifest),
      ))
    )
      throw new Error('装扮索引加载失败，请先更新 WeQ 原生模块');
    const previous = {
      directory: this.directory,
      manifest: this.manifest,
      states: new Map(this.states),
      verified: new Set(this.verified),
      disabled: this.disabled,
    };
    const reloadPrevious = async () => {
      if (
        previous.disabled ||
        !(await native.reloadDressResourceIndexes?.(
          previous.directory,
          ...nativeIdentity(native, previous.manifest),
        ))
      )
        native.clearDressResourceIndexes?.();
    };
    try {
      writeFileAtomicSync(join(this.root, 'active.json'), JSON.stringify(candidate.manifest));
    } catch (error) {
      await reloadPrevious();
      throw error;
    }
    this.directory = candidate.directory;
    this.manifest = candidate.manifest;
    this.disabled = false;
    this.states.clear();
    this.verified.clear();
    for (const state of candidate.snapshot()) {
      this.states.set(state.kind, state);
      if (state.status === 'ready') this.verified.add(state.kind);
    }
    this.revision++;
    return async () => {
      await reloadPrevious();
      this.directory = previous.directory;
      this.manifest = previous.manifest;
      this.disabled = previous.disabled;
      this.states.clear();
      this.verified.clear();
      for (const [kind, state] of previous.states) this.states.set(kind, state);
      for (const kind of previous.verified) this.verified.add(kind);
      writeFileAtomicSync(join(this.root, 'active.json'), JSON.stringify(previous.manifest));
      this.revision++;
    };
  }
  async cleanPrevious(directory: string) {
    if (
      directory !== this.directory &&
      dirname(directory) === this.root &&
      existsSync(join(directory, 'installed-manifest.json'))
    ) {
      const manifest = parseDressIndexManifest(
        JSON.parse(readFileSync(join(directory, 'installed-manifest.json'), 'utf8')),
      );
      const previous = new DressIndexStore(this.root, manifest);
      if (previous.directory !== directory) return;
      for (const kind of DRESS_INDEX_KINDS)
        if (await previous.matches(join(directory, `${kind}.dat`), kind))
          await rm(join(directory, `${kind}.dat`), { force: true });
      if (DRESS_INDEX_KINDS.every((kind) => !existsSync(join(directory, `${kind}.dat`))))
        await rm(join(directory, 'installed-manifest.json'), { force: true });
    }
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
    if (this.disabled) return null;
    if (this.manifest.format === 'ntdr-v1') {
      const legacy = native.queryDressResourceUrl(kind, itemId, part);
      if (legacy) {
        this.preserveLegacy(kind);
        return legacy;
      }
    }
    if (!this.verified.has(kind) || !existsSync(join(this.directory, `${kind}.dat`))) {
      const prepared = this.ensure(kind, false, false);
      if (options.background) {
        // 仅检查、复用已经安装的索引；普通浏览不触发整类下载。
        void prepared.catch(() => false);
        return null;
      }
      if (!(await prepared)) return null;
    }
    const previous = process.env.NT_HELPER_DRESS_DIR;
    try {
      // native 查询是同步调用，目录覆盖不跨越任何异步边界。
      process.env.NT_HELPER_DRESS_DIR = this.directory;
      return native.queryDressResourceUrl(
        kind,
        itemId,
        part,
        ...nativeIdentity(native, this.manifest),
      );
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
      .then((matches) => (matches ? this.ensure(kind, false, false) : false))
      .catch(() => false);
  }

  ensure(
    kind: DressIndexKind,
    retry = false,
    allowDownload = true,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    const pending = this.pending.get(kind);
    if (pending)
      return allowDownload && this.localPending.has(kind)
        ? pending.then((ready) => ready || this.ensure(kind, retry, true, signal))
        : pending;
    if (this.verified.has(kind) && existsSync(join(this.directory, `${kind}.dat`)))
      return Promise.resolve(true);
    const now = this.options.now ?? Date.now;
    if (allowDownload && !retry && now() - (this.failedAt.get(kind) ?? -Infinity) < 60_000)
      return Promise.resolve(false);
    if (!allowDownload) this.localPending.add(kind);
    const task = this.prepare(kind, allowDownload, signal).finally(() => {
      this.pending.delete(kind);
      this.localPending.delete(kind);
    });
    this.pending.set(kind, task);
    return task;
  }

  /** 读取与旧版本迁移都不访问网络，供增强包页恢复真实安装状态。 */
  async inspect(): Promise<DressIndexState[]> {
    await Promise.all(DRESS_INDEX_KINDS.map((kind) => this.ensure(kind, false, false)));
    return this.snapshot();
  }

  /** 候选清单只检查本地目标；列出更新不会提前迁入资源或恢复已删除的包。 */
  async inspectStored(): Promise<DressIndexState[]> {
    await Promise.all(
      DRESS_INDEX_KINDS.map(async (kind) => {
        if (this.pending.has(kind)) return;
        const path = join(this.directory, `${kind}.dat`);
        if (this.verified.has(kind) && existsSync(path)) return;
        if (await this.matches(path, kind)) {
          this.verified.add(kind);
          this.update(kind, { status: 'ready', downloadedBytes: this.manifest.parts[kind].size });
        } else {
          this.verified.delete(kind);
          this.update(kind, { status: 'idle', downloadedBytes: 0 });
        }
      }),
    );
    return this.snapshot();
  }

  async remove(active = true): Promise<void> {
    this.disabled = true;
    if (this.pending.size) throw new Error('装扮索引正在准备，请稍后删除');
    for (const kind of DRESS_INDEX_KINDS) {
      for (const suffix of ['', '.incoming', '.incoming.part', '.incoming.resume.json'])
        await rm(join(this.directory, `${kind}.dat${suffix}`), { force: true });
    }
    this.verified.clear();
    this.states.clear();
    this.failedAt.clear();
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, 'removed.json'), JSON.stringify({ at: Date.now() }));
    if (active) await rm(join(this.root, 'active.json'), { force: true });
    this.revision += 1;
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

  private async prepare(
    kind: DressIndexKind,
    allowDownload: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const target = join(this.directory, `${kind}.dat`);
    const incoming = `${target}.incoming`;
    const part = this.manifest.parts[kind];
    try {
      await mkdir(this.directory, { recursive: true });
      if (!(await this.matches(target, kind))) {
        const legacy =
          this.options.legacyDirectory &&
          (allowDownload || !existsSync(join(this.directory, 'removed.json'))) &&
          join(this.options.legacyDirectory, `${kind}.dat`);
        if (legacy && (await this.matches(legacy, kind))) {
          await copyFile(legacy, incoming, constants.COPYFILE_FICLONE);
        } else {
          if (!allowDownload) return false;
          this.update(kind, { status: 'downloading', downloadedBytes: 0, error: undefined });
          let fetcher: HostBridge['fetchMedia'];
          try {
            fetcher = getHost().fetchMedia;
          } catch {
            /* 纯 Node 测试无宿主。 */
          }
          let lastProgressAt = 0;
          if (this.options.download) {
            const result = await this.options.download(
              `${this.manifest.baseUrl.replace(/\/$/, '')}/${part.asset}`,
              incoming,
              {
                expectedSize: part.size,
                expectedSha256: part.sha256,
                maxBytes: part.size,
                attempts: 2,
                fetcher,
                signal,
                onProgress: (downloadedBytes) => {
                  const now = Date.now();
                  if (now - lastProgressAt < 200 && downloadedBytes < part.size) return;
                  lastProgressAt = now;
                  this.update(kind, { downloadedBytes });
                },
              },
            );
            if (!result.ok) throw new Error(result.reason);
          } else {
            const transfer = new ManagedDownload({
              batch: true,
              total: part.size,
              maxBytes: part.size,
              signal,
              identity: { sha256: part.sha256, size: part.size },
              state: (state) =>
                this.update(kind, {
                  downloadedBytes: state.received,
                  paused: state.paused,
                  pauseReasons: state.reasons,
                  source: state.source,
                  attempt: state.attempt,
                  retryAt: state.retryAt,
                }),
              validate: async (path) => {
                if (!(await this.matches(path, kind)))
                  throw new Error('装扮索引大小或哈希校验失败');
              },
            });
            this.transfers.set(kind, transfer);
            if (this.manuallyPaused) transfer.pause();
            else if (this.continued) transfer.continue();
            try {
              await transfer.file(
                `${this.manifest.baseUrl.replace(/\/$/, '')}/${part.asset}`,
                incoming,
              );
            } finally {
              this.transfers.delete(kind);
            }
          }
        }
        signal?.throwIfAborted();
        if (!(await this.matches(incoming, kind))) throw new Error('装扮索引大小或哈希校验失败');
        await rename(incoming, target);
      }
      this.verified.add(kind);
      this.failedAt.delete(kind);
      this.revision += 1;
      this.update(kind, {
        status: 'ready',
        downloadedBytes: part.size,
        error: undefined,
        paused: false,
        pauseReasons: [],
      });
      if (DRESS_INDEX_KINDS.every((kind) => this.verified.has(kind))) {
        this.disabled = false;
        await rm(join(this.directory, 'removed.json'), { force: true });
        await writeFile(
          join(this.directory, 'installed-manifest.json'),
          JSON.stringify(this.manifest),
        );
      }
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
