/**
 * 验证「picElement.md5 → 本地缓存图片路径」预测算法的命中率。
 *
 * 算法来源: QQDecrypt 文档站 docs/.vitepress/theme/components/QQCachePath.vue
 *   url      = `${folder}:${md5}`  (folder ∈ chatraw / chatimg / chatthumb)
 *   crc      = CRC64(url)，有符号 BigInt（反射多项式 0x95AC9329AC4BC9B5，
 *              初值 -1n，无最终异或 —— 实测 QQ 文件名带符号，与之一致）
 *   filename = `Cache_${crc.toString(16)}`
 *   subdir   = filename 最后 3 个字符
 *   相对路径 = `<folder>/<subdir>/<filename>`（挂在 chatpic 根目录下）
 *
 * 用法:  pnpm --filter @weq/db tools:chatpic-path
 *
 * 环境变量:
 *   WEQ_TEST_ANDROID_ROOT  安卓 nt_qq 数据库目录（.env 已配置）
 *   WEQ_TEST_CHATPIC_ROOT  本地 chatpic 根目录，默认 D:\estkim\chatpic
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadNative } from '@weq/native';
import { ProtoMsg, decodeElement, type Element } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { sanitizeBytes } from '@weq/codec/raw';
import { androidEnv, envOptional } from '@weq/testkit';
import { QqDb } from '../src/qq_db';

/** 仓库根目录（packages/db/test → 上 3 级）。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// ── 路径预测算法（与 QQCachePath.vue 一致）──────────────────────────────────

const CRC64_TABLE: bigint[] = (() => {
  const table = new Array<bigint>(256);
  for (let i = 0; i < 256; i++) {
    let bf = BigInt(i);
    for (let j = 0; j < 8; j++) {
      if ((bf & 1n) !== 0n) bf = (bf >> 1n) ^ -7661587058870466123n;
      else bf >>= 1n;
    }
    table[i] = bf;
  }
  return table;
})();

function crc64(s: string): bigint {
  let v = -1n;
  for (let i = 0; i < s.length; i++) {
    const idx = Number((BigInt(s.charCodeAt(i)) ^ v) & 0xffn);
    v = CRC64_TABLE[idx]! ^ (v >> 8n);
  }
  return v;
}

const FOLDERS = ['chatraw', 'chatimg', 'chatthumb'] as const;

function predictPaths(md5: string): Array<{ folder: string; relPath: string }> {
  return FOLDERS.map((folder) => {
    const filename = `Cache_${crc64(`${folder}:${md5}`).toString(16)}`;
    return { folder, relPath: `${folder}/${filename.slice(-3)}/${filename}` };
  });
}

// ── 数据库扫描 ───────────────────────────────────────────────────────────────

const BODY = new ProtoMsg(MsgBody);
const TABLES = ['c2c_msg_table', 'group_msg_table', 'dataline_msg_table'] as const;
const PAGE = 20_000;

const MD5_RE = /^[0-9A-F]{32}$/;

interface PicInfo {
  instances: number;
  imgTypes: Set<number>;
  predicted: Array<{ folder: string; relPath: string }>;
}

/** 从一条消息的 40800 里取出所有 pic element 的 md5。 */
function picMd5sFromBody(body: Uint8Array): string[] {
  const out: string[] = [];
  try {
    for (const wire of BODY.decode(sanitizeBytes(body, MsgBody)).elements ?? []) {
      const el = decodeElement(wire) as Element;
      if (el.kind !== 'pic') continue;
      const md5 =
        (el.md5 ?? '').trim().toUpperCase() ||
        Buffer.from(el.md5Bytes ?? new Uint8Array())
          .toString('hex')
          .toUpperCase();
      out.push(md5);
    }
  } catch {
    // 单条消息解析失败不影响整体统计。
  }
  return out;
}

interface ScanResult {
  rows: number;
  pics: number;
  invalidMd5: number;
  byMd5: Map<string, PicInfo>;
}

async function scanPics(db: QqDb): Promise<ScanResult> {
  const result: ScanResult = {
    rows: 0,
    pics: 0,
    invalidMd5: 0,
    byMd5: new Map(),
  };

  for (const table of TABLES) {
    let rows: Awaited<ReturnType<QqDb['query']>>;
    for (let offset = 0; ; offset += PAGE) {
      try {
        rows = await db.query(
          `SELECT "40800" FROM "${table}" ORDER BY rowid LIMIT ${PAGE} OFFSET ${offset}`,
        );
      } catch {
        if (offset === 0) console.log(`  [scan] ${table}: 不存在，跳过`);
        break;
      }
      if (rows.length === 0) break;
      result.rows += rows.length;

      for (const row of rows) {
        const body = row[0];
        if (!(body instanceof Uint8Array) || body.byteLength === 0) continue;
        for (const md5 of picMd5sFromBody(body)) {
          result.pics++;
          if (!MD5_RE.test(md5)) {
            result.invalidMd5++;
            continue;
          }
          let info = result.byMd5.get(md5);
          if (!info) {
            info = { instances: 0, imgTypes: new Set(), predicted: predictPaths(md5) };
            result.byMd5.set(md5, info);
          }
          info.instances++;
        }
      }

      if (rows.length < PAGE) break;
    }
    if (result.rows > 0) console.log(`  [scan] ${table}: 完成`);
  }
  return result;
}

// ── 命中统计与报告 ───────────────────────────────────────────────────────────

interface FolderStat {
  hits: number;
  misses: number;
}

async function main(): Promise<void> {
  const chatpicRoot =
    envOptional('WEQ_TEST_CHATPIC_ROOT', 'D:/estkim/chatpic').replace(/[\\/]+$/, '') ||
    'D:/estkim/chatpic';
  if (!existsSync(chatpicRoot)) throw new Error(`chatpic 根目录不存在: ${chatpicRoot}`);

  const nt = loadNative().ntHelper;
  const probe = await nt.testDatabaseKey(androidEnv.msgDbPath, androidEnv.key);
  if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
    throw new Error(`密钥不正确: ${androidEnv.msgDbPath}`);
  }
  const db = new QqDb(nt, {
    dbPath: androidEnv.msgDbPath,
    key: androidEnv.key,
    algo: { pageHmacAlgorithm: probe.pageHmacAlgorithm, kdfHmacAlgorithm: probe.kdfHmacAlgorithm },
  });

  console.log(`扫描 ${androidEnv.msgDbPath}`);
  console.log(`chatpic 根目录: ${chatpicRoot}\n`);
  const scan = await scanPics(db);
  db.close();

  const uniqueMd5s = [...scan.byMd5.keys()];
  const folderStats = new Map<string, FolderStat>(FOLDERS.map((f) => [f, { hits: 0, misses: 0 }]));
  let anyHit = 0;
  let noHit = 0;

  const csvRows: string[] = [
    'md5,instances,chatraw_hit,chatimg_hit,chatthumb_hit,any_hit,chatraw_path,chatimg_path,chatthumb_path',
  ];
  for (const md5 of uniqueMd5s) {
    const info = scan.byMd5.get(md5)!;
    const hit = { chatraw: false, chatimg: false, chatthumb: false };
    for (const p of info.predicted) {
      const ok = existsSync(path.join(chatpicRoot, p.relPath));
      (hit as Record<string, boolean>)[p.folder] = ok;
    }
    const any = hit.chatraw || hit.chatimg || hit.chatthumb;
    if (any) anyHit++;
    else noHit++;

    for (const f of FOLDERS) {
      const st = folderStats.get(f)!;
      if (hit[f]) st.hits++;
      else st.misses++;
    }

    const paths = Object.fromEntries(info.predicted.map((p) => [p.folder, p.relPath])) as Record<
      string,
      string
    >;
    csvRows.push(
      [
        md5,
        info.instances,
        hit.chatraw ? 1 : 0,
        hit.chatimg ? 1 : 0,
        hit.chatthumb ? 1 : 0,
        any ? 1 : 0,
        paths.chatraw,
        paths.chatimg,
        paths.chatthumb,
      ].join(','),
    );
  }

  const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(2)}%`);

  console.log('═'.repeat(66));
  console.log(`消息行        : ${scan.rows}`);
  console.log(`pic element   : ${scan.pics} 个（去重后 ${uniqueMd5s.length} 个 md5）`);
  console.log(`非法 md5      : ${scan.invalidMd5}`);
  console.log('─'.repeat(66));
  for (const f of FOLDERS) {
    const st = folderStats.get(f)!;
    const d = st.hits + st.misses;
    console.log(`${f.padEnd(10)} 命中 ${st.hits}/${d}  ${pct(st.hits, d)}`);
  }
  console.log('─'.repeat(66));
  console.log(`任一目录命中   : ${anyHit}/${uniqueMd5s.length}  ${pct(anyHit, uniqueMd5s.length)}`);
  console.log(`全部未命中     : ${noHit}/${uniqueMd5s.length}  ${pct(noHit, uniqueMd5s.length)}`);

  const outFile = path.join(REPO_ROOT, 'tmp', `chatpic_path_report_${Date.now()}.csv`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, csvRows.join('\n'), 'utf8');
  console.log(`\n明细已写入   : ${outFile}`);
  console.log('═'.repeat(66));
}

main().catch((e) => {
  console.error('[chatpic-path] failed:', e);
  process.exit(1);
});
