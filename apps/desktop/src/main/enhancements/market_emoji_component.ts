import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ManagedDownload } from '@weq/service/managed-download';
import type { MarketEmojiAsset } from '../../shared/enhancement_release';
import { parseMarketCatalog, setMarketCatalogReader } from '../market_catalog';
import type { EnhancementComponent } from './packs';

export function createMarketEmojiComponent(directory: string, fetcher?: typeof fetch) {
  let active: string | null = null;
  let target: MarketEmojiAsset | undefined;
  let verified: ReturnType<typeof load> = null;
  let candidate: ReturnType<typeof load> = null;
  let transfer: ManagedDownload | undefined;
  const file = (version: string, compressed = false) =>
    join(directory, `${version}.csv${compressed ? '.gz' : ''}`);
  const files = () => {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  function load(version: string, path: string, compressed: boolean) {
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.size > 16 * 1024 ** 2) return null;
      const data = readFileSync(path);
      if (createHash('sha256').update(data).digest('hex') !== version) return null;
      const csv = compressed ? gunzipSync(data, { maxOutputLength: 16 * 1024 ** 2 }) : data;
      return {
        version,
        compressed,
        entries: parseMarketCatalog(new TextDecoder('utf-8', { fatal: true }).decode(csv)),
      };
    } catch {
      return null;
    }
  }
  let inspected = false;
  const installed = () => {
    if (!inspected) {
      verified = active
        ? (load(active, file(active, true), true) ?? load(active, file(active), false))
        : null;
      inspected = true;
    }
    return verified;
  };
  setMarketCatalogReader(installed);
  const validate = async () => {
    if (!(candidate ?? installed())) throw new Error('商城表情目录缺失或校验失败');
  };
  const component: EnhancementComponent = {
    id: 'market-emoji:catalog',
    name: '商城表情目录',
    state: () => {
      const current = installed();
      const ready = !!current;
      const updateAvailable = !!target && current?.version !== target.sha256;
      const installedNames = new Set(
        active
          ? current
            ? [`${active}.csv${current.compressed ? '.gz' : ''}`]
            : [`${active}.csv`, `${active}.csv.gz`]
          : [],
      );
      let sizeOnDisk = 0;
      let activeBytes = 0;
      for (const name of files()) {
        const bytes = lstatSync(join(directory, name), { throwIfNoEntry: false })?.size ?? 0;
        sizeOnDisk += bytes;
        if (installedNames.has(name)) activeBytes += bytes;
      }
      return {
        ready,
        installed: !!active,
        identity: current?.version ?? 'missing',
        downloadBytes: updateAvailable ? (target?.sizeBytes ?? 0) : 0,
        sizeOnDisk,
        activeBytes,
        updateAvailable,
      };
    },
    select: (entry) => {
      if (entry.type !== 'market-emoji') throw new Error('商城表情目录组件不匹配');
      target = entry.asset;
    },
    ensure: async (report, signal) => {
      if (!target) throw new Error('尚未取得商城表情目录的发布清单');
      const { sha256, sizeBytes, url } = target;
      const compressed = target.name === 'market.csv.gz';
      const destination = file(sha256, compressed);
      candidate =
        installed()?.version === sha256 ? installed() : load(sha256, destination, compressed);
      if (candidate) return;
      transfer = new ManagedDownload({
        batch: true,
        total: sizeBytes,
        maxBytes: sizeBytes,
        identity: { sha256, size: sizeBytes },
        fetcher,
        signal,
        state: (state) =>
          report({
            received: state.received,
            total: state.total,
            paused: state.paused,
            pauseReasons: state.reasons,
            source: state.source,
            attempt: state.attempt,
            retryAt: state.retryAt,
            note: '下载商城表情目录',
          }),
        validate: async (path, _response, bytes) => {
          candidate = bytes === sizeBytes ? load(sha256, path, compressed) : null;
          if (!candidate) throw new Error('商城表情目录校验失败');
        },
      });
      try {
        await mkdir(directory, { recursive: true });
        await transfer.file(url, destination);
      } finally {
        transfer = undefined;
      }
    },
    check: async () => {
      candidate = null;
      inspected = false;
      await validate();
    },
    activate: () => {
      if (!candidate) return () => {};
      const before = installed();
      const beforeVersion = active;
      active = candidate.version;
      verified = candidate;
      inspected = true;
      candidate = null;
      return () => {
        active = beforeVersion;
        verified = before;
      };
    },
    installation: () => ({ type: 'market-emoji', version: active }),
    cleanup: async () => {
      if (!active) return;
      const installedFile = file(active, verified?.compressed);
      await Promise.all(
        files()
          .filter(
            (name) =>
              /^[a-f0-9]{64}\.csv(?:\.gz)?(?:\.part|\.resume\.json)?$/.test(name) &&
              join(directory, name) !== installedFile,
          )
          .map((name) => rm(join(directory, name), { force: true })),
      );
    },
    remove: async () => {
      active = null;
      verified = null;
      candidate = null;
      await rm(directory, { recursive: true, force: true });
    },
    pause: () => transfer?.pause(),
    resume: () => transfer?.continue(),
  };
  return {
    component,
    validate,
    restore(version: unknown) {
      active = typeof version === 'string' && /^[a-f0-9]{64}$/.test(version) ? version : null;
      inspected = false;
    },
  };
}
