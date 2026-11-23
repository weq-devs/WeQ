import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import {
  networkFetch,
  bounded,
  downloadSources,
  orderSources,
  recordSourceHealth,
} from '@weq/network';
import {
  FEED_TAG,
  FEED_ASSET,
  RESOURCE_FEED_TAG,
  verifyReleaseIndex,
  type ReleaseIndex,
  type ReleaseDescriptor,
} from '@weq/network/release-metadata';
import releaseKeys from '@weq/network/release-keys';
import { writeFileAtomic } from '@weq/service/atomic-write';

let root: string | undefined;
const feeds = new Map<string, ReleaseFeed>();
export function configureReleaseFeeds(directory: string) {
  root = directory;
}
export function getReleaseFeed(repository: string, feedTag = FEED_TAG) {
  const key = `${root ?? ''}:${repository}:${feedTag}`;
  let feed = feeds.get(key);
  if (!feed) {
    feed = new ReleaseFeed(repository, root, releaseKeys, feedTag);
    feeds.set(key, feed);
  }
  return feed;
}

export class ReleaseFeed {
  private index?: ReleaseIndex;
  private readonly snapshots = new Map<string, ReleaseDescriptor>();
  private pending?: Promise<ReleaseIndex | null>;
  private loading?: Promise<void>;
  private checkedAt = 0;
  constructor(
    private readonly repository: string,
    private readonly directory?: string,
    private readonly keys = releaseKeys,
    private readonly feedTag = FEED_TAG,
  ) {}
  private get path() {
    return (
      this.directory &&
      join(
        this.directory,
        'updates',
        `${this.repository.replace('/', '-')}${this.feedTag === FEED_TAG ? '' : `-${this.feedTag}`}-signed.json`,
      )
    );
  }
  private adopt(index: ReleaseIndex) {
    const expectedKind =
      this.feedTag === RESOURCE_FEED_TAG ? 'resource-release-index' : 'release-index';
    if (index.kind !== expectedKind) throw new Error('发布索引类型不匹配');
    if (
      index.kind === 'resource-release-index' &&
      this.index?.releases.some(
        (previous) =>
          !index.releases.some(
            (entry) => entry.track === previous.track && entry.prerelease === previous.prerelease,
          ),
      )
    )
      throw new Error('资源更新索引缺失已验证的包版本');
    for (const entry of index.releases) {
      const previous = this.index?.releases.find(
        (item) => item.prerelease === entry.prerelease && item.track === entry.track,
      );
      if (
        previous &&
        (entry.version && previous.version
          ? semver.lt(entry.version, previous.version)
          : Date.parse(entry.publishedAt) < Date.parse(previous.publishedAt))
      )
        throw new Error('发布索引倒退，保留已验证版本');
      this.snapshots.set(entry.tag, entry);
    }
    while (this.snapshots.size > 16) this.snapshots.delete(this.snapshots.keys().next().value!);
    this.index = index;
  }
  load(): Promise<void> {
    this.loading ??= this.loadCache();
    return this.loading;
  }
  private async loadCache() {
    if (this.path) {
      try {
        this.adopt(
          verifyReleaseIndex(
            JSON.parse(await readFile(this.path, 'utf8')),
            this.repository,
            this.keys,
          ),
        );
      } catch {
        /* 首次没有签名缓存，继续在线读取。 */
      }
    }
  }
  latest(includePrerelease: boolean, index = this.index) {
    return index?.releases
      .filter((item) => includePrerelease || !item.prerelease)
      .sort((a, b) =>
        a.version && b.version
          ? semver.rcompare(a.version, b.version)
          : Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
      )[0];
  }
  summary(version: string): string | undefined {
    return [...this.snapshots.values()].find((item) => item.version === version)?.summary;
  }
  async archive(version: string, name: string) {
    await this.load();
    const release = [...this.snapshots.values()].find(
      (item) => item.version === version && (item.tag === `v${version}` || item.tag === version),
    );
    const asset = release?.assets.find((item) => item.name === name);
    return asset && { ...asset, prerelease: release!.prerelease };
  }
  read(
    force = false,
    signal?: AbortSignal,
    fetcher: typeof fetch = networkFetch,
  ): Promise<ReleaseIndex | null> {
    if (this.pending) return this.pending;
    this.pending = this.check(force, signal, fetcher).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async check(force: boolean, signal: AbortSignal | undefined, fetcher: typeof fetch) {
    await this.load();
    if (!force && this.checkedAt && Date.now() - this.checkedAt < 5 * 60_000)
      return this.index ?? null;
    const deadline = Date.now() + 20000;
    const sources = orderSources(
      downloadSources(
        `https://github.com/${this.repository}/releases/download/${this.feedTag}/${FEED_ASSET}`,
      ),
    );
    for (let at = 0; at < sources.length && Date.now() < deadline; at += 3) {
      const requests: AbortController[] = [];
      let missingOrigin = false;
      const pending = sources.slice(at, at + 3).map(async (url) => {
        const request = new AbortController();
        requests.push(request);
        const requestSignal = AbortSignal.any([
          request.signal,
          AbortSignal.timeout(Math.min(8000, Math.max(1, deadline - Date.now()))),
          ...(signal ? [signal] : []),
        ]);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const fetched = fetcher(url, { signal: requestSignal });
          void fetched.then(
            (response) => {
              if (requestSignal.aborted) void response.body?.cancel().catch(() => {});
            },
            () => {},
          );
          const response = await bounded(fetched, requestSignal);
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            if (response.status === 404 && new URL(url).hostname === 'github.com')
              missingOrigin = true;
            throw new Error(`发布索引 HTTP ${response.status}`);
          }
          reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          for (;;) {
            const chunk = await bounded(reader.read(), requestSignal);
            if (chunk.done) break;
            bytes += chunk.value.length;
            if (bytes > 8 * 1024 ** 2) throw new Error('发布索引过大');
            chunks.push(chunk.value);
          }
          const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const index = verifyReleaseIndex(envelope, this.repository, this.keys);
          recordSourceHealth(url, true);
          return { envelope, index };
        } catch (error) {
          if (!request.signal.aborted && !signal?.aborted) recordSourceHealth(url, false);
          throw error;
        } finally {
          request.abort();
          void reader?.cancel().catch(() => {});
        }
      });
      let result: { envelope: unknown; index: ReleaseIndex } | undefined;
      try {
        result = await Promise.any(pending);
      } catch {
        /* 本批无可验证描述，继续有限候选或旧发布读取。 */
      } finally {
        for (const request of requests) request.abort();
        await Promise.allSettled(pending);
      }
      signal?.throwIfAborted();
      if (result) {
        this.adopt(result.index);
        this.checkedAt = Date.now();
        if (this.path) {
          await mkdir(join(this.directory!, 'updates'), { recursive: true });
          await writeFileAtomic(this.path, JSON.stringify(result.envelope));
        }
        return result.index;
      }
      // 原站明确没有新索引时，旧发布立即使用官方 API，不等全部镜像超时。
      if (missingOrigin) return null;
    }
    return null;
  }
}
