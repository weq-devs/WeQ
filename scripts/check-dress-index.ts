/** 联网冒烟：仅下载公开索引并查询指定原生模块，不访问 QQ 或替换应用文件。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NtHelperBinding } from '@weq/native';
import {
  DRESS_INDEX_KINDS,
  DressIndexStore,
  parseDressIndexManifest,
  type DressIndexKind,
} from '../packages/service/src/account/dress_index';
import { downloadUrlToFile } from '../packages/service/src/account/media_url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
const addonPath = option('--addon');
assert(
  addonPath,
  '使用 pnpm exec tsx scripts/check-dress-index.ts --addon /absolute/nt_helper.node',
);
const manifestPath = resolve(
  option('--manifest') ?? join(root, 'resources/dress/index-manifest.json'),
);
const manifest = parseDressIndexManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
const native = createRequire(import.meta.url)(resolve(addonPath)) as NtHelperBinding;
assert.equal(native.getBuildInfo().isDev, false, '必须使用与清单兼容的正式 native');
assert.equal(native.getInitStatus(), 0, 'native 初始化失败或已过期');

async function querySamples(directory: string) {
  process.env.NT_HELPER_DRESS_DIR = directory;
  const parts: Record<DressIndexKind, string[]> = {
    bubble: ['config.json', 'static.zip', 'other.zip'],
    font: ['main', 'fzfont'],
    widget: ['aio_50.png', 'xydata.js', 'other.zip'],
  };
  const hits: Partial<Record<DressIndexKind, { itemId: string; part: string }>> = {};
  for (const kind of DRESS_INDEX_KINDS) {
    const ranking = JSON.parse(
      await readFile(join(root, `resources/dress/ranking-${kind}.json`), 'utf8'),
    ) as {
      response: { items: Array<{ item: { itemId: string | number } }> };
    };
    for (const { item } of ranking.response.items.slice(0, 20)) {
      const itemId = String(item.itemId);
      for (const part of parts[kind]) {
        const found = native.queryDressResourceUrl(kind, itemId, part);
        if (found && /^https:\/\//.test(found.url) && found.size >= 0) {
          hits[kind] = { itemId, part };
          break;
        }
      }
      if (hits[kind]) break;
    }
    assert(hits[kind], `${kind} 前20个排行榜条目均未在真实索引中命中`);
  }
  return hits;
}

if (argv.includes('--read-only')) {
  const directory = option('--directory');
  assert(directory);
  globalThis.fetch = async () => {
    throw new Error('离线验收禁止联网');
  };
  console.log(JSON.stringify({ restartedNativeHits: await querySamples(resolve(directory)) }));
} else {
  await mkdir(join(root, '.cache'), { recursive: true });
  const temporary = await mkdtemp(join(root, '.cache/dress-runtime-smoke-'));
  const requests = { bubble: 0, font: 0, widget: 0 };
  const downloads = { bubble: 0, font: 0, widget: 0 };
  const startedAt = Date.now();
  try {
    const store = new DressIndexStore(temporary, manifest, {
      download: async (url, target, options) => {
        const kind = DRESS_INDEX_KINDS.find((kind) => url.endsWith(`dress-${kind}.dat`));
        assert(kind);
        downloads[kind]++;
        return downloadUrlToFile(url, target, {
          ...options,
          fetcher: (source, request) => {
            requests[kind]++;
            return fetch(source, request);
          },
        });
      },
    });
    for (const kind of DRESS_INDEX_KINDS) {
      const results = await Promise.all(Array.from({ length: 4 }, () => store.ensure(kind)));
      assert(results.every(Boolean), `${kind} 下载或校验失败：${JSON.stringify(store.snapshot())}`);
      assert.equal(downloads[kind], 1, `${kind} 并发没有合并`);
      console.log(
        JSON.stringify({
          stage: 'downloaded',
          kind,
          bytes: manifest.parts[kind].size,
          requests: requests[kind],
        }),
      );
    }
    const firstHits = await querySamples(store.directory);
    let offlineRequests = 0;
    const offline = new DressIndexStore(temporary, manifest, {
      download: async () => {
        offlineRequests++;
        throw new Error('离线验收禁止下载');
      },
    });
    for (const kind of DRESS_INDEX_KINDS) assert.equal(await offline.ensure(kind), true);
    assert.equal(offlineRequests, 0);
    const child = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(import.meta.url),
        '--addon',
        resolve(addonPath),
        '--manifest',
        manifestPath,
        '--read-only',
        '--directory',
        store.directory,
      ],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );
    console.log(
      JSON.stringify(
        {
          manifest: manifest.tag,
          downloads,
          requests,
          offlineRequests,
          firstNativeHits: firstHits,
          ...JSON.parse(child),
          elapsedMs: Date.now() - startedAt,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
    console.log('本轮临时索引缓存已清理');
  }
}
