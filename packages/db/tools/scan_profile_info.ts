/**
 * profile_info.db 全库普查。
 *
 * 目的：找出 WeQ 还没解析的列/字段 —— 尤其是「昵称颜色 / VIP 等级 / QQ 等级」
 * 这类肉眼确定应该存在、但一直没定位到的数据。
 *
 * 做三件事：
 *   1) 列出库里所有表，每张表的行数 + 列。
 *   2) 对 profile_info_v6 每一列做填充率统计 + 标量列的取值分布(top N)。
 *   3) 对每个 BLOB 列做「递归 tag 普查」：统计每条 tag 路径出现次数、
 *      wire 类型、以及几个真实样例值 —— 无 schema 也能看出藏了什么。
 *
 * Run:  pnpm tsx ./packages/db/tools/scan_profile_info.ts [table] [--limit N]
 */

import { loadNative } from '@weq/native';
import { decode } from '@weq/codec/raw';
import type { Guess, RawField } from '@weq/codec/raw';
import { testEnv } from '@weq/testkit';
import { QqDb } from '../src/qq_db';

const TABLE =
  process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'profile_info_v6';
const LIMIT = Number(process.env.WEQ_SCAN_LIMIT ?? 4000);
/** 标量列取值分布的展示上限。 */
const TOP_N = 8;
/** 每条 tag 路径保留的样例数。 */
const SAMPLES = 4;

function log(msg = ''): void {
  console.log(msg);
}

// ───────────────────────────── 标量统计 ─────────────────────────────

interface ColStat {
  name: string;
  declared: string;
  nonNull: number;
  classes: Map<string, number>;
  values: Map<string, number>;
  /** 值域太大(如 uid/昵称)就停止收集分布。 */
  tooMany: boolean;
  blobSizes: number[];
}

function classOf(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Uint8Array) return 'blob';
  if (typeof v === 'bigint') return 'int';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'real';
  if (typeof v === 'string') return 'text';
  return typeof v;
}

function shortValue(v: unknown): string {
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  return String(v);
}

// ───────────────────────────── BLOB tag 普查 ─────────────────────────────

interface TagStat {
  path: string;
  wire: Set<string>;
  count: number;
  /** 出现在多少行里(去重后)。 */
  rows: number;
  samples: string[];
  /** 数值型字段的取值集合(小基数才有意义)。 */
  numeric: Map<string, number>;
  numericOverflow: boolean;
}

function bestGuess(f: RawField): Guess | undefined {
  return f.guesses[0];
}

function renderGuess(g: Guess): string {
  switch (g.kind) {
    case 'len-utf8':
      return g.value.length > 60 ? `"${g.value.slice(0, 60)}…"` : `"${g.value}"`;
    case 'len-bytes':
      return `<${g.value.byteLength}b ${Buffer.from(g.value).toString('hex').slice(0, 40)}>`;
    case 'len-nested':
      return `{${g.value.length} fields}`;
    case 'varint-bool':
      return String(g.value);
    case 'varint-timestamp-sec':
    case 'varint-timestamp-ms':
      return g.value.toISOString();
    default:
      return String((g as { value: unknown }).value);
  }
}

/** 数值型 guess → 归一化的数字字符串(用于取值分布)；非数值返回 undefined。 */
function numericOf(g: Guess): string | undefined {
  switch (g.kind) {
    case 'varint-uint64':
    case 'i64-fixed':
      return String(g.value);
    case 'i32-fixed':
      return String(g.value);
    case 'varint-bool':
      return g.value ? '1' : '0';
    case 'varint-timestamp-sec':
      return String(Math.floor(g.value.getTime() / 1000));
    case 'varint-timestamp-ms':
      return String(g.value.getTime());
    default:
      return undefined;
  }
}

function walk(
  fields: RawField[],
  prefix: string,
  stats: Map<string, TagStat>,
  seenThisRow: Set<string>,
  depth: number,
): void {
  if (depth > 8) return;
  for (const f of fields) {
    const path = prefix ? `${prefix}.${f.tag}` : String(f.tag);
    let st = stats.get(path);
    if (!st) {
      st = {
        path,
        wire: new Set(),
        count: 0,
        rows: 0,
        samples: [],
        numeric: new Map(),
        numericOverflow: false,
      };
      stats.set(path, st);
    }
    st.count++;
    if (!seenThisRow.has(path)) {
      seenThisRow.add(path);
      st.rows++;
    }
    st.wire.add(String(f.wireType));

    const g = bestGuess(f);
    if (!g) continue;

    if (g.kind === 'len-nested' && g.consumedAll) {
      walk(g.value, path, stats, seenThisRow, depth + 1);
      continue;
    }

    if (st.samples.length < SAMPLES) {
      const rendered = renderGuess(g);
      if (!st.samples.includes(rendered)) st.samples.push(rendered);
    }
    const num = numericOf(g);
    if (num !== undefined && !st.numericOverflow) {
      st.numeric.set(num, (st.numeric.get(num) ?? 0) + 1);
      if (st.numeric.size > 40) st.numericOverflow = true;
    }
  }
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: testEnv.profileDbPath,
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  log(`# profile_info.db 普查  (table=${TABLE}, 采样上限=${LIMIT})\n`);

  // ── 1) 全库表清单 ──
  log('## 1. 库内表清单\n');
  const tables = await db.query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
  for (const t of tables) {
    const name = String(t[0]);
    try {
      const count = String((await db.query(`SELECT COUNT(*) FROM "${name}"`))[0]?.[0] ?? '?');
      const info = await db.query(`PRAGMA table_info("${name}")`);
      const cols = info.map((r) => String(r[1])).join(' ');
      log(`- **${name}**  rows=${count}  cols(${info.length}): ${cols}`);
    } catch (e) {
      log(`- **${name}**  (打不开: ${(e as Error).message})`);
    }
  }

  // ── 2) 列统计 ──
  log(`\n## 2. ${TABLE} 每列填充率 / 取值分布\n`);
  const info = await db.query(`PRAGMA table_info("${TABLE}")`);
  const cols = info.map((r) => String(r[1]));
  const declared = new Map(info.map((r) => [String(r[1]), String(r[2] || '')]));

  const total = Number((await db.query(`SELECT COUNT(*) FROM "${TABLE}"`))[0]?.[0] ?? 0);
  const quoted = cols.map((c) => `"${c}"`).join(',');
  const rows = await db.query(`SELECT ${quoted} FROM "${TABLE}" LIMIT ?`, [LIMIT]);
  log(`表总行数=${total}，本次采样=${rows.length}\n`);

  const stats: ColStat[] = cols.map((name) => ({
    name,
    declared: declared.get(name) ?? '',
    nonNull: 0,
    classes: new Map(),
    values: new Map(),
    tooMany: false,
    blobSizes: [],
  }));

  for (const row of rows) {
    for (let i = 0; i < cols.length; i++) {
      const v = row[i];
      const st = stats[i]!;
      const cls = classOf(v);
      st.classes.set(cls, (st.classes.get(cls) ?? 0) + 1);
      if (cls === 'null') continue;
      st.nonNull++;
      if (v instanceof Uint8Array) {
        st.blobSizes.push(v.byteLength);
        continue;
      }
      if (st.tooMany) continue;
      const key = shortValue(v);
      st.values.set(key, (st.values.get(key) ?? 0) + 1);
      if (st.values.size > 300) {
        st.tooMany = true;
        st.values.clear();
      }
    }
  }

  for (const st of stats) {
    const pct = rows.length ? ((st.nonNull / rows.length) * 100).toFixed(1) : '0.0';
    const clsStr = [...st.classes.entries()]
      .filter(([k]) => k !== 'null')
      .map(([k, n]) => `${k}×${n}`)
      .join(' ');
    log(`### ${st.name}  (${st.declared})  非空 ${st.nonNull}/${rows.length} = ${pct}%  ${clsStr}`);
    if (st.blobSizes.length) {
      const sorted = [...st.blobSizes].sort((a, b) => a - b);
      const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
      log(`  BLOB 大小: min=${sorted[0]} p50=${p(0.5)} p90=${p(0.9)} max=${sorted.at(-1)}`);
    }
    if (st.tooMany) {
      log('  取值: (高基数，略)');
    } else if (st.values.size) {
      const top = [...st.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
      log(`  取值(${st.values.size} 种): ${top.map(([v, n]) => `${v}×${n}`).join('  ')}`);
    }
    log();
  }

  // ── 3) BLOB 列 tag 普查 ──
  log(`\n## 3. ${TABLE} BLOB 列 protobuf tag 普查\n`);
  for (let i = 0; i < cols.length; i++) {
    const name = cols[i]!;
    if (!stats[i]!.blobSizes.length) continue;
    log(`\n### BLOB 列 ${name}\n`);
    const tagStats = new Map<string, TagStat>();
    let parsed = 0;
    let failed = 0;
    for (const row of rows) {
      const v = row[i];
      if (!(v instanceof Uint8Array) || v.byteLength === 0) continue;
      try {
        const fields = decode(v);
        walk(fields, '', tagStats, new Set(), 0);
        parsed++;
      } catch {
        failed++;
      }
    }
    log(`解析成功 ${parsed} 行，失败 ${failed} 行，共 ${tagStats.size} 条 tag 路径\n`);
    const sorted = [...tagStats.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const st of sorted) {
      const pct = parsed ? ((st.rows / parsed) * 100).toFixed(1) : '0';
      log(
        `  ${st.path.padEnd(34)} rows=${st.rows}(${pct}%) n=${st.count} wire=${[...st.wire].join('/')}`,
      );
      if (st.samples.length) log(`      样例: ${st.samples.join(' | ')}`);
      if (!st.numericOverflow && st.numeric.size > 1 && st.numeric.size <= 24) {
        const top = [...st.numeric.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([v, n]) => `${v}×${n}`)
          .join(' ');
        log(`      取值(${st.numeric.size}): ${top}`);
      }
    }
  }

  db.close();
}

main().catch((e) => {
  console.error('[scan-profile-info] failed:', e);
  process.exit(1);
});
