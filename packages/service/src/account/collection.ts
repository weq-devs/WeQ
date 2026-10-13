/**
 * CollectionService — read QQ favorites (收藏).
 *
 * 网络优先、数据库回退:能拿到 weiyun.com 的 p_skey 就走微云 collector 网关
 * (最新数据、不依赖本地 collection.db);拿不到凭据或网络请求失败均回退到本地
 * collection.db,保证收藏功能始终可用。
 */

import type { AccountSession } from '@weq/account';
import type { CollectionCachedContent, CollectionItem } from '@weq/db';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import type { NtHelperBinding } from '@weq/native';
import { applyCollectionFileDownload, COLLECTION_DOWNLOAD_BUILDS } from './web/collection_download';
import { getLogger, logErrorContext } from '../common/logger';
import { WebCredentialProvider } from './web/credential';
import type { WebCredential, WebNative } from './web/credential';
import {
  getCollectionDetailsNetwork,
  getCollectionListNetwork,
  getCollectionPageNetwork,
  type CollectionNetworkCursor,
  type CollectionNetworkOptions,
  type NetworkCollectionCursorPage,
} from './web/collection';
import type { CollectionNetworkDetail, NetworkCollectionPage } from './web/collection';
import { captureCollectionPages, type CollectionCaptureOptions } from './collection_capture';
import { CollectionHistoryStore, type CollectionHistorySummary } from './collection_history';
import { CollectionDetailStore } from './collection_detail_store';
import {
  CollectionMediaStore,
  collectionMediaReferences,
  collectionEmbeddedAudio,
  type CollectionMediaOptions,
  type CollectionMediaReceipt,
  type CollectionMediaExportEntry,
} from './collection_media';

const WEIYUN_DOMAIN = 'weiyun.com';

export interface CollectionPage {
  /** Items on this page, newest-collected first. */
  items: CollectionItem[];
  /** Offset this page started at. */
  offset: number;
  /** Requested page size. */
  limit: number;
  /** Whether more items exist past this page. */
  hasMore: boolean;
  /** Where the items came from — useful for the UI / debugging. */
  source: 'network' | 'db';
}

export interface CollectionDetailFetchOptions {
  force?: boolean;
  signal?: AbortSignal;
}

export class CollectionService {
  private readonly creds: WebCredentialProvider;
  private readonly logger;
  private readonly history?: CollectionHistoryStore;
  private readonly details?: CollectionDetailStore;
  private readonly media?: CollectionMediaStore;
  private readonly listedItems = new Map<string, CollectionItem>();

  constructor(
    private readonly nt: WebNative &
      Partial<Pick<NtHelperBinding, 'resolveQqRuntimeModules' | 'resolveAppidFromMajor'>>,
    private readonly session: AccountSession,
    private readonly resolvePid: () => number,
    historyRoot?: string,
  ) {
    this.creds = new WebCredentialProvider(nt, session.context.uin, resolvePid);
    this.logger = getLogger().child({ scope: 'collection', accountUin: session.context.uin });
    if (historyRoot) {
      this.history = new CollectionHistoryStore(historyRoot, session.context.uin);
      this.details = new CollectionDetailStore(join(historyRoot, 'details'), session.context.uin);
      this.media = new CollectionMediaStore(join(historyRoot, 'media', session.context.uin));
    }
  }

  /**
   * List collected items with pagination. Tries the collector network path
   * first (pulls up to offset+limit+1 items so `hasMore` is exact); falls back
   * to local collection.db only when a p_skey can't be obtained.
   */
  async listCollections(limit = 50, offset = 0): Promise<CollectionPage> {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const safeOffset = Math.max(0, offset);

    const network = await this.tryNetwork(safeLimit, safeOffset);
    if (network) return network;

    return this.fromDb(safeLimit, safeOffset);
  }

  /**
   * Local-only path. Instant (no network round-trip) and always succeeds, so
   * the UI can paint something before the slow collector fetch lands.
   */
  async listCollectionsFromDb(limit = 50, offset = 0): Promise<CollectionPage> {
    return this.fromDb(Math.max(1, Math.min(limit, 200)), Math.max(0, offset));
  }

  /**
   * Network-only path. Returns null when no weiyun p_skey is available or the
   * collector request fails — callers already holding db rows should simply
   * keep them rather than showing an error.
   */
  async listCollectionsFromNetwork(limit = 50, offset = 0): Promise<CollectionPage | null> {
    return this.tryNetwork(Math.max(1, Math.min(limit, 200)), Math.max(0, offset));
  }

  /** A single resumable cloud page; errors remain visible and never fall back to a local summary. */
  async readNetworkPage(
    cursor: CollectionNetworkCursor | null = null,
    options: CollectionNetworkOptions = {},
  ): Promise<NetworkCollectionCursorPage> {
    const credential = await this.creds.forDomain(WEIYUN_DOMAIN);
    return getCollectionPageNetwork(credential, cursor, options);
  }

  captureNetworkPages(
    options: CollectionCaptureOptions,
    networkOptions: CollectionNetworkOptions = {},
  ) {
    return captureCollectionPages(
      this.session.context.uin,
      (cursor) =>
        this.readNetworkPage(cursor, {
          ...networkOptions,
          signal: options.signal ?? networkOptions.signal,
        }),
      options,
    );
  }

  async syncNetworkHistory(signal?: AbortSignal): Promise<CollectionHistorySummary> {
    if (!this.history) throw new Error('收藏历史存储未配置。');
    const checkpoint = this.history.checkpointForResume();
    await this.captureNetworkPages({
      ...(checkpoint ? { checkpoint } : {}),
      signal,
      maxPages: 1000,
      onPage: async (page) => this.history?.savePage(page),
    });
    return this.history.summary();
  }

  collectionHistorySummary(): CollectionHistorySummary | null {
    return this.history?.summary() ?? null;
  }

  writeCollectionHistorySnapshot(path: string): void {
    if (!this.history) throw new Error('收藏历史存储未配置。');
    this.history.writeSnapshot(path);
  }

  writeCollectionDetailSnapshot(path: string): void {
    if (!this.details) throw new Error('收藏详情存储未配置。');
    this.details.writeSnapshot(path);
  }

  /** Total number of collected items (db-backed count, 0 when db/table absent). */
  async countCollections(): Promise<number> {
    return this.session.collection.count();
  }

  /** Fresh local detail lookup; never sends a request to QQ. */
  async readCachedDetail(cid: string): Promise<CollectionItem | null> {
    const item = await this.session.collection.getByCid(cid);
    if (!item) return null;
    const stored = this.details?.get(cid);
    if (stored) item.cachedContent = stored;
    return item;
  }

  /** Cached content is independent of whether QQ has a local list row for it. */
  async readCachedContent(cid: string): Promise<CollectionCachedContent | null> {
    const stored = this.details?.get(cid);
    if (stored) return stored;
    const local = await this.session.collection.cachedContentByCids([cid]);
    return local.get(cid) ?? null;
  }

  private async cachedListItem(cid: string): Promise<CollectionItem | null> {
    const item = this.listedItems.get(cid);
    if (item) return item;
    const historical = this.history?.getByCid(cid);
    if (historical) return historical;
    try {
      return await this.session.collection.getByCid(cid);
    } catch {
      return null;
    }
  }

  mediaCacheDirectory(): string {
    if (!this.media) throw new Error('收藏附件缓存未配置。');
    return this.media.root;
  }

  async cachedMediaName(id: string): Promise<string> {
    if (!this.media) throw new Error('收藏附件缓存未配置。');
    return (await this.media.savedFile(id)).name;
  }

  async saveMediaAs(id: string, path: string): Promise<void> {
    if (!this.media) throw new Error('收藏附件缓存未配置。');
    await this.media.saveAs(id, path);
  }

  async exportCachedMedia(
    cid: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<CollectionMediaExportEntry[]> {
    if (!this.media) return [];
    signal?.throwIfAborted();
    const content = await this.readCachedContent(cid);
    const item = await this.cachedListItem(cid);
    const refs = collectionMediaReferences(cid, content, item);
    const entries: CollectionMediaExportEntry[] = [];
    for (const reference of refs) {
      // Detail-embedded audio is already cached; extract it without network I/O.
      if (reference.embeddedSha256)
        await this.media.download(reference, {
          signal,
          embeddedBytes: collectionEmbeddedAudio(content) ?? undefined,
        });
      entries.push(await this.media.exportCached(reference, directory, signal));
    }
    return entries;
  }

  /** URLs and identities come from the account's own metadata, never IPC input. */
  async downloadMedia(
    cid: string,
    options: CollectionMediaOptions = {},
  ): Promise<CollectionMediaReceipt[]> {
    if (!this.media) throw new Error('收藏附件缓存未配置。');
    options.signal?.throwIfAborted();
    const content = await this.readCachedContent(cid);
    const item = await this.cachedListItem(cid);
    if (!content && !item) throw new Error('未找到这条收藏。');
    const refs = collectionMediaReferences(cid, content, item);
    if (refs.length > 1000) throw new Error('此收藏附件过多，请分批处理。');
    const receipts: CollectionMediaReceipt[] = [];
    for (const ref of refs) {
      options.signal?.throwIfAborted();
      receipts.push(
        await this.media.download(ref, {
          ...options,
          resolveDownload: (reference, signal) => this.resolveFileDownload(reference, signal),
          embeddedBytes: ref.embeddedSha256
            ? (collectionEmbeddedAudio(content) ?? undefined)
            : undefined,
        }),
      );
    }
    return receipts;
  }

  private async resolveFileDownload(
    reference: import('./collection_media').CollectionMediaReference,
    signal: AbortSignal,
  ): Promise<{ url: string; cookie: string }> {
    signal.throwIfAborted();
    const descriptor = reference.storedFile;
    if (
      !descriptor ||
      !reference.expectedMd5 ||
      !reference.expectedSize ||
      !/^[0-9a-f]{32}$/.test(reference.expectedMd5) ||
      !/^\d+$/.test(reference.expectedSize)
    )
      throw new Error('收藏附件的来源信息不完整。');
    // Only use request layouts verified for the currently running official build.
    if (
      process.platform !== 'darwin' ||
      process.arch !== 'arm64' ||
      !this.nt.resolveQqRuntimeModules ||
      !this.nt.resolveAppidFromMajor
    )
      throw new Error('当前 QQ 版本的收藏附件下载尚未验证。');
    const pid = this.resolvePid();
    const modules = this.nt.resolveQqRuntimeModules(pid);
    if (!modules) throw new Error('请先连接在线 QQ。');
    const stamp = (path: string): string => {
      const value = statSync(path, { bigint: true });
      if (!value.isFile()) throw new Error('运行中 QQ 的模块不可用。');
      return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
    };
    const generation = [stamp(modules.majorPath), stamp(modules.wrapperPath)].join('/');
    const check = (): void => {
      signal.throwIfAborted();
      const current = this.nt.resolveQqRuntimeModules!(pid);
      if (
        this.resolvePid() !== pid ||
        current?.majorPath !== modules.majorPath ||
        current?.wrapperPath !== modules.wrapperPath ||
        [stamp(modules.majorPath), stamp(modules.wrapperPath)].join('/') !== generation
      )
        throw new Error('QQ 会话或版本已变化，请重新连接后重试。');
    };
    const info = this.nt.resolveAppidFromMajor(modules.majorPath);
    const build = `${info.version}-${info.build}`;
    check();
    if (!COLLECTION_DOWNLOAD_BUILDS.has(build))
      throw new Error('当前 QQ 版本的收藏附件下载尚未验证。');
    const cred = await this.creds.forDomain(WEIYUN_DOMAIN);
    check();
    const resource = await applyCollectionFileDownload(
      cred,
      reference.cid,
      {
        ...descriptor,
        name: reference.name,
        uid: descriptor.uid === undefined ? undefined : BigInt(descriptor.uid),
        size: BigInt(reference.expectedSize),
        md5: Buffer.from(reference.expectedMd5, 'hex'),
        sha1: descriptor.sha1 === undefined ? undefined : Buffer.from(descriptor.sha1, 'hex'),
      },
      build,
      { signal },
    );
    check();
    return resource;
  }

  /** Fetch declared file/video originals before export; offline export only copies the cache. */
  async downloadOriginalFiles(cid: string, signal?: AbortSignal): Promise<{ failed: number }> {
    if (!this.media) throw new Error('收藏附件缓存未配置。');
    const content = await this.readCachedContent(cid);
    const item = await this.cachedListItem(cid);
    const refs = collectionMediaReferences(cid, content, item).filter((ref) => ref.storedFile);
    if (refs.length > 1000) throw new Error('此收藏附件过多，请分批处理。');
    let failed = 0;
    let consecutiveFailures = 0;
    for (const ref of refs) {
      signal?.throwIfAborted();
      const receipt = await this.media.download(ref, {
        signal,
        resolveDownload: (reference, requestSignal) =>
          this.resolveFileDownload(reference, requestSignal),
      });
      if (receipt.state !== 'downloaded') {
        failed++;
        if (++consecutiveFailures >= 3) break;
      } else consecutiveFailures = 0;
    }
    return { failed };
  }

  /**
   * Fetch up to 20 full favorite bodies from operation 20001. Existing official
   * QQ or WeQ cache entries are reused unless `force` is requested.
   */
  async fetchDetails(
    cids: readonly string[],
    options: CollectionDetailFetchOptions = {},
  ): Promise<CollectionNetworkDetail[]> {
    if (cids.length < 1 || cids.length > 20 || new Set(cids).size !== cids.length) {
      throw new Error('收藏详情每批需要 1–20 个不同的 ID。');
    }
    options.signal?.throwIfAborted();
    const cached = options.force
      ? new Map<string, CollectionCachedContent>()
      : await this.cached(cids);
    const missing = cids.filter((cid) => !cached.has(cid));
    if (missing.length > 0) {
      const credential = await this.creds.forDomain(WEIYUN_DOMAIN);
      options.signal?.throwIfAborted();
      let capture: ReturnType<CollectionDetailStore['saveRawBatch']> | undefined;
      const fetched = await getCollectionDetailsNetwork(credential, missing, {
        signal: options.signal,
        onRawResponse: this.details
          ? ({ cids: responseCids, response }) => {
              capture = this.details?.saveRawBatch(responseCids, response);
            }
          : undefined,
      });
      options.signal?.throwIfAborted();
      if (this.details) {
        if (!capture) throw new Error('收藏详情原始响应未保存。');
        this.details.commitBatch(fetched, capture);
      }
      for (const detail of fetched) {
        detail.content.fetched = true;
        cached.set(detail.cid, detail.content);
      }
    }
    return cids.map((cid) => {
      const content = cached.get(cid);
      if (!content) throw new Error(`收藏详情未返回：${cid}`);
      return { cid, content };
    });
  }

  /**
   * 网络路径:拿 weiyun.com p_skey → collector.fcg 拉取。拿不到 p_skey 或网络请求
   * 失败均返回 null,让调用方回退 collection.db。
   */
  private async tryNetwork(limit: number, offset: number): Promise<CollectionPage | null> {
    let cred: WebCredential;
    try {
      cred = await this.creds.forDomain(WEIYUN_DOMAIN);
    } catch (error) {
      // 拿不到凭据(未 attach / 静态账号 noPid / 关了 ClientKey)→ 回退 db。
      this.logger.info('no weiyun p_skey — falling back to collection.db', {
        event: 'collection-network-no-cred',
        ...logErrorContext(error),
      });
      return null;
    }
    if (!cred.pskey) {
      this.logger.info('empty weiyun p_skey — falling back to collection.db', {
        event: 'collection-network-empty-pskey',
      });
      return null;
    }

    // 有凭据:网络拉取,失败则回退 db。
    const wanted = offset + limit + 1;
    let page: NetworkCollectionPage;
    try {
      page = await getCollectionListNetwork(cred, wanted);
    } catch (error) {
      this.logger.warn('collection network fetch failed — falling back to collection.db', {
        event: 'collection-network-fetch-failed',
        ...logErrorContext(error),
      });
      return null;
    }
    const window = page.items.slice(offset, offset + limit);
    for (const item of window) this.listedItems.set(item.cid, item);
    // Cloud summaries do not carry full content. Preserve independently loaded
    // local details when the network stage replaces the initial database page.
    try {
      const cached = await this.cached(window.map((item) => item.cid));
      for (const item of window) {
        const content = cached.get(item.cid);
        if (content) item.cachedContent = content;
      }
    } catch (error) {
      this.logger.warn('collection detail cache unavailable', {
        event: 'collection-detail-cache-failed',
        ...logErrorContext(error),
      });
    }
    const hasMore = page.hasMore || page.items.length > offset + limit;
    return { items: window, offset, limit, hasMore, source: 'network' };
  }

  /** Local collection.db path — fetches one extra row to compute `hasMore`. */
  private async fromDb(limit: number, offset: number): Promise<CollectionPage> {
    const rows = await this.session.collection.listAll(limit + 1, offset);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const stored = this.details?.getMany(items.map((item) => item.cid));
    if (stored) {
      for (const item of items) {
        const content = stored.get(item.cid);
        if (content) item.cachedContent = content;
      }
    }
    return {
      items,
      offset,
      limit,
      hasMore,
      source: 'db',
    };
  }

  /** Merge official QQ detail rows with WeQ's durable network detail cache. */
  private async cached(cids: readonly string[]): Promise<Map<string, CollectionCachedContent>> {
    let cached = new Map<string, CollectionCachedContent>();
    try {
      cached = await this.session.collection.cachedContentByCids(cids);
    } catch (error) {
      this.logger.warn('official collection detail cache unavailable', {
        event: 'collection-detail-db-failed',
        ...logErrorContext(error),
      });
    }
    const stored = this.details?.getMany(cids);
    if (stored) {
      for (const [cid, content] of stored) cached.set(cid, content);
    }
    return cached;
  }
}
