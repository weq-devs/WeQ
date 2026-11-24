import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelStore, ModelEntry, ModelDownloadProgress } from '@weq/service';
import type { EnhancementReleaseComponent } from '../../shared/enhancement_release';
import { releaseContentVersion, modelReleaseComponent } from './release_catalog';
import type { EnhancementComponent } from './packs';

export function createModelComponent<T extends ModelEntry>(
  store: ModelStore<T>,
  id: string,
  busy: () => boolean = () => false,
) {
  let candidate = store;
  let revision: string | null = null;
  let target = store.getModel(id)!;
  let previousDirectory = '';
  let previousModel: ModelEntry | undefined;
  let manuallyPaused = false;
  let continued = false;
  let inspected = '';
  let inspection: Promise<void> | undefined;
  let reusable = new Set<string>();
  let activeReady = false;
  const fileIdentity = (source: ModelStore<T>) =>
    source.getModel(id)!.files.map((file) => {
      try {
        const info = statSync(source.resolveModelPaths(id)[file.key]!);
        return [file.sha256, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
      } catch {
        return null;
      }
    });
  const identity = () =>
    JSON.stringify([
      store.resolveModelDir(id),
      fileIdentity(store),
      candidate.resolveModelDir(id),
      fileIdentity(candidate),
    ]);
  const inspect = async (): Promise<void> => {
    if (inspection) await inspection;
    const key = identity();
    if (key === inspected) return;
    inspection = (async () => {
      activeReady = await store.verifyModel(id);
      reusable = await store.reusableFiles(candidate, id);
      inspected = key;
    })();
    try {
      await inspection;
    } finally {
      inspection = undefined;
    }
  };
  const same = (a: ModelEntry, b: ModelEntry) =>
    JSON.stringify(a.files.map((file) => [file.key, file.name, file.sizeBytes, file.sha256])) ===
    JSON.stringify(b.files.map((file) => [file.key, file.name, file.sizeBytes, file.sha256]));
  const missing = () => {
    const checked = identity() === inspected;
    return target.files.reduce(
      (sum, file) =>
        sum +
        (checked && reusable.has(file.key)
          ? 0
          : (file.sizeBytes ?? Math.round(target.sizeBytes * file.weight))),
      0,
    );
  };
  const fileSizes = () => {
    const seen = new Set<string>();
    let sizeOnDisk = 0;
    let activeBytes = 0;
    for (const source of new Set([store, candidate]))
      for (const path of Object.values(source.resolveModelPaths(id)))
        for (const suffix of ['', '.part']) {
          try {
            const info = statSync(`${path}${suffix}`);
            const key = `${info.dev}:${info.ino}`;
            if (info.isFile() && !seen.has(key)) {
              seen.add(key);
              sizeOnDisk += info.size;
              if (source === store && !suffix) activeBytes += info.size;
            }
          } catch {
            /* 缺失文件不占空间。 */
          }
        }
    return { sizeOnDisk, activeBytes };
  };
  const component: EnhancementComponent = {
    id: `model:${id}`,
    name: (store.getModel(id) as ModelEntry & { name?: string }).name ?? id,
    inspect,
    installation: () => ({
      type: 'model',
      id,
      revision: store.installedRevision(id),
      model: store.getModel(id),
      removed: store.isRemoved(id),
    }),
    state: () => ({
      ready: store.getModelStatus(id)!.downloaded && (identity() !== inspected || activeReady),
      installed: !!store.installedRevision(id),
      identity: JSON.stringify([
        store.resolveModelDir(id),
        store.getModel(id)!.files.map((file) => {
          try {
            const info = statSync(store.resolveModelPaths(id)[file.key]!);
            return [file.sha256, info.size, info.mtimeMs];
          } catch {
            return null;
          }
        }),
      ]),
      ...fileSizes(),
      downloadBytes: missing(),
      updateAvailable: !same(store.getModel(id)!, target),
    }),
    select: (release: EnhancementReleaseComponent) => {
      if (release.type !== 'model' || release.id !== id) throw new Error('模型组件不匹配');
      const sizeBytes = release.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      target = {
        ...store.getModel(id)!,
        minWeqVersion: release.minWeqVersion ?? store.getModel(id)!.minWeqVersion,
        files: release.files.map((file) => {
          const original = store.registeredModel(id)?.files.find((entry) => entry.key === file.key);
          const previous = new URL(file.url);
          const pinned = original && new URL(original.url);
          const knownFloating =
            original?.sha256 === file.sha256 &&
            original?.sizeBytes === file.sizeBytes &&
            (previous.hostname === 'modelscope.cn' || previous.hostname === 'www.modelscope.cn') &&
            pinned?.hostname === 'modelscope.cn' &&
            previous.pathname.replace('/resolve/master/', '/resolve/PIN/') ===
              pinned.pathname.replace(/\/resolve\/[a-f0-9]{40}\//, '/resolve/PIN/');
          return {
            ...file,
            ...(knownFloating ? { url: original!.url, sources: original!.sources } : {}),
            weight: file.sizeBytes / sizeBytes,
          };
        }),
        sizeBytes,
      };
      revision = releaseContentVersion([release]);
      candidate = same(store.getModel(id)!, target) ? store : store.revisionStore(target, revision);
      inspected = '';
    },
    ensure: async (report, signal) => {
      manuallyPaused = false;
      continued = false;
      if (candidate === store) {
        if (await store.verifyModel(id)) {
          report({ received: 0, total: 0 });
          return;
        }
        revision ??= releaseContentVersion([modelReleaseComponent(target)]);
        candidate = store.revisionStore(target, revision);
      }
      await store.reuseInto(candidate, id);
      await inspect();
      const initial = target.sizeBytes - missing();
      const progress = (p: ModelDownloadProgress) => {
        if (p.id === id)
          report({
            received: Math.max(0, p.downloadedBytes - initial),
            total: target.sizeBytes - initial,
            paused: p.paused,
            pauseReasons: p.pauseReasons,
            source: p.source,
            attempt: p.attempt,
            retryAt: p.retryAt,
            note: '准备模型文件',
          });
      };
      candidate.on('progress', progress);
      try {
        const downloading = candidate.downloadModel(
          id,
          Object.fromEntries(target.files.map((file) => [file.key, file.sources ?? file.url])),
          signal,
        );
        if (manuallyPaused) candidate.pauseDownload(id);
        else if (continued) candidate.continueDownload(id);
        const result = await downloading;
        if (!result.success) throw new Error(result.error ?? '模型下载失败');
        signal.throwIfAborted();
        await writeFile(
          join(candidate.resolveModelDir(id), 'model-files.json'),
          JSON.stringify(target.files),
        );
      } finally {
        candidate.off('progress', progress);
      }
    },
    check: async () => {
      if (!(await store.verifyModel(id))) throw new Error('已有模型校验失败，请重试');
    },
    activate: () => {
      if (candidate === store || !revision) return () => {};
      previousDirectory = store.resolveModelDir(id);
      previousModel = store.getModel(id);
      return store.activateRevision(candidate, id, revision);
    },
    cleanup: async () => {
      if (previousDirectory)
        await store.cleanPreviousRevision(id, previousDirectory, previousModel);
    },
    remove: async () => {
      if (
        candidate !== store &&
        candidate.resolveModelDir(id) !== store.resolveModelDir(id) &&
        !candidate.deleteModel(id, false)
      )
        throw new Error('候选模型正在下载，请稍后删除');
      if (!store.deleteModel(id)) throw new Error('模型正在使用，请稍后删除');
    },
    busy: () => busy(),
    pause: () => {
      manuallyPaused = true;
      continued = false;
      candidate.pauseDownload(id);
    },
    resume: () => {
      manuallyPaused = false;
      continued = true;
      candidate.continueDownload(id);
    },
  };
  return {
    component,
    paths: () => candidate.resolveModelPaths(id),
    directory: () => candidate.resolveModelDir(id),
  };
}
