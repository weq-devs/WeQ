/**
 * 收藏导出验证：codec → db → service → exportCollections。
 *
 * 用真实 collection.db 构建 CollectionDb + CollectionService，翻页拉全后把
 * `CollectionItem` 拍平成 `CollectionExportRow`（等价于 app 侧 collectionItemToWire），
 * 喂给 exportCollections 落盘四种格式，校验行数与文件非空。
 *
 * Run:  pnpm tsx ./packages/service/test/collection_export.ts
 */

import { statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNative } from '@weq/native';
import { CollectionDb, type CollectionItem } from '@weq/db';
import type { AccountSession } from '@weq/account';
import { CollectionService } from '../src/account/collection';
import { exportCollections, type CollectionExportRow, type CollectionFormat } from '../src/account/export';
import { testEnv, qqDbPath } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  qqDbPath('collection.db');

/** 把一组图片拍成 wire 形状（uri + 尺寸）。 */
function pics(list: readonly { uri?: string; width?: number; height?: number }[] | undefined) {
  return (list ?? [])
    .filter((p): p is { uri: string; width?: number; height?: number } => Boolean(p?.uri))
    .map((p) => ({ uri: p.uri, width: p.width ?? 0, height: p.height ?? 0 }));
}

/** 最小拍平（镜像 app 侧 collectionItemToWire 的关键字段）。 */
function flatten(it: CollectionItem): CollectionExportRow {
  const s = it.summary;
  const a = it.author;
  const numId = a?.numId ?? 0n;
  const fileInfo = s.fileSummary?.fileInfo ?? s.fileSummary?.srcFileInfo;
  return {
    cid: it.cid,
    kind: it.kind,
    type: it.type,
    createTime: it.createTime,
    collectTime: it.collectTime,
    authorName: a?.strId ?? '',
    authorUin: numId > 0n ? numId.toString() : '',
    groupName: a?.groupName ?? '',
    text: s.textSummary?.text ?? '',
    link: s.linkSummary
      ? {
          url: s.linkSummary.url ?? '',
          title: s.linkSummary.title ?? '',
          publisher: s.linkSummary.publisher ?? '',
          brief: s.linkSummary.brief ?? '',
          pics: pics(s.linkSummary.picList),
        }
      : null,
    gallery: s.gallerySummary ? { pics: pics(s.gallerySummary.picList) } : null,
    audio: s.audioSummary ? { duration: s.audioSummary.duration ?? 0, stt: s.audioSummary.stt ?? '' } : null,
    video: s.videoSummary
      ? {
          title: s.videoSummary.title ?? '',
          duration: s.videoSummary.duration ?? 0,
          cover: s.videoSummary.previewPicInfo?.uri
            ? {
                uri: s.videoSummary.previewPicInfo.uri,
                width: s.videoSummary.previewPicInfo.width ?? 0,
                height: s.videoSummary.previewPicInfo.height ?? 0,
              }
            : null,
          fileName: s.videoSummary.storeFileInfo?.name ?? '',
          fileSize: (s.videoSummary.storeFileInfo?.size ?? 0n).toString(),
        }
      : null,
    file: s.fileSummary
      ? {
          name: fileInfo?.name ?? '',
          size: (fileInfo?.size ?? 0n).toString(),
          ext: (fileInfo?.name ?? '').split('.').pop() ?? '',
        }
      : null,
    location: s.locationSummary
      ? {
          name: s.locationSummary.name ?? '',
          address: s.locationSummary.address ?? '',
          latitude: s.locationSummary.latitude ?? 0,
          longitude: s.locationSummary.longitude ?? 0,
        }
      : null,
    richMedia: s.richMediaSummary
      ? {
          title: s.richMediaSummary.title ?? '',
          subTitle: s.richMediaSummary.subTitle ?? '',
          brief: s.richMediaSummary.brief ?? '',
          originalUri: s.richMediaSummary.originalUri ?? '',
          pics: pics(s.richMediaSummary.picList),
        }
      : null,
  };
}

async function main() {
  const native = loadNative();
  const db = new CollectionDb(native.ntHelper, { dbPath: DB_PATH, key: KEY, algo: ALGO });
  const session = { collection: db } as unknown as AccountSession;
  const service = new CollectionService(session);
  const outDir = mkdtempSync(join(tmpdir(), 'weq-col-export-'));

  try {
    const total = await service.countCollections();
    console.log(`[export] total favorites: ${total}`);

    // deps.listCollections：翻页拉真实收藏并拍平。
    const deps = {
      listCollections: async (limit: number, offset: number): Promise<CollectionExportRow[]> => {
        const page = await service.listCollections(limit, offset);
        return page.items.map(flatten);
      },
    };

    const formats: CollectionFormat[] = ['json', 'csv', 'xlsx', 'txt'];
    for (const format of formats) {
      const outputPath = join(outDir, `收藏.${format}`);
      const result = await exportCollections({ format, outputPath }, deps);
      const size = statSync(result.filePath).size;
      console.log(`[export] ${format.padEnd(5)} → count=${result.count} size=${size}B ${result.filePath}`);
      if (result.count !== total) {
        throw new Error(`${format}: exported ${result.count} but count says ${total}`);
      }
      if (size <= 0) throw new Error(`${format}: output file is empty`);
    }

    // 类型过滤：只导 link，行数应 ≤ total 且等于 link 计数。
    const all = await deps.listCollections(10_000, 0);
    const linkCount = all.filter((r) => r.kind === 'link').length;
    const linkOut = join(outDir, '收藏_link.json');
    const linkResult = await exportCollections({ format: 'json', outputPath: linkOut, kinds: ['link'] }, deps);
    console.log(`[export] kind=link filter → count=${linkResult.count} (expected ${linkCount})`);
    if (linkResult.count !== linkCount) {
      throw new Error(`link filter: exported ${linkResult.count} but expected ${linkCount}`);
    }

    console.log('\n[export] ✅ 四格式落盘 + 行数一致 + 类型过滤 验证通过。');
  } finally {
    db.close();
    rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('[export] failed:', e);
  process.exit(1);
});
