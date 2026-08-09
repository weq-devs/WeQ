/**
 * Dump 一个 elementType 的原始 protobuf tag 树（schema-free），
 * 用来分析 codec 里还没建模的元素。
 *
 * Run: pnpm --filter @weq/db tools:dump-element-raw <elementType> [安卓目录]
 */

import { loadNative } from '@weq/native';
import { ProtoMsg } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { decode, sanitizeBytes, type Guess, type RawField } from '@weq/codec/raw';
import { androidBackup, testEnv } from '@weq/testkit';
import { QqDb } from '../src/qq_db';

const BODY = new ProtoMsg(MsgBody);
const TABLES = ['c2c_msg_table', 'group_msg_table'];
const PAGE = 20_000;
/** 每种类型 dump 几条就够看结构了。 */
const MAX_SAMPLES = 3;

/** 挑最可信的那个解释；nested 优先于 utf8 优先于 bytes。 */
function best(guesses: Guess[]): Guess | undefined {
  return guesses[0];
}

function render(g: Guess): string {
  switch (g.kind) {
    case 'len-utf8': {
      const s = g.value.replace(/\s+/g, ' ');
      return `"${s.length > 200 ? `${s.slice(0, 200)}…(${g.value.length} 字符)` : s}"`;
    }
    case 'len-bytes': {
      const hex = Buffer.from(g.value).toString('hex');
      return `<${g.value.length}b ${hex.length > 80 ? `${hex.slice(0, 80)}…` : hex}>`;
    }
    case 'len-nested':
      return `{ ${g.value.length} 个子字段 }`;
    case 'varint-bool':
      return String(g.value);
    default:
      return String((g as { value: unknown }).value);
  }
}

function printTree(fields: RawField[], indent: string): void {
  for (const f of fields) {
    const g = best(f.guesses);
    if (!g) continue;
    console.log(`${indent}${f.tag} = ${render(g)}`);
    if (g.kind === 'len-nested') printTree(g.value, `${indent}    `);
  }
}

async function main(): Promise<void> {
  const want = Number(process.argv[2]);
  if (!Number.isFinite(want)) throw new Error('用法: tools:dump-element-raw <elementType> [安卓目录]');
  const dir = process.argv[3];

  const nt = loadNative().ntHelper;
  const src = dir
    ? (() => {
        const b = androidBackup(dir);
        return { path: b.msgDbPath, key: b.key };
      })()
    : { path: testEnv.msgDbPath, key: testEnv.key };

  const probe = await nt.testDatabaseKey(src.path, src.key);
  if (!probe.success) throw new Error(`密钥不正确: ${src.path}`);
  const db = new QqDb(nt, {
    dbPath: src.path,
    key: src.key,
    algo: {
      pageHmacAlgorithm: probe.pageHmacAlgorithm!,
      kdfHmacAlgorithm: probe.kdfHmacAlgorithm!,
    },
  });

  console.log(`在 ${src.path} 里找 elementType=${want}\n`);
  let found = 0;

  for (const table of TABLES) {
    for (let offset = 0; found < MAX_SAMPLES; offset += PAGE) {
      let rows: Awaited<ReturnType<QqDb['query']>>;
      try {
        rows = await db.query(
          `SELECT "40001","40011","40012","40027","40800" FROM "${table}" ORDER BY rowid LIMIT ${PAGE} OFFSET ${offset}`,
        );
      } catch {
        break;
      }
      if (rows.length === 0) break;

      for (const row of rows) {
        const body = row[4];
        if (!(body instanceof Uint8Array) || body.byteLength === 0) continue;

        let hit = false;
        try {
          for (const el of BODY.decode(sanitizeBytes(body, MsgBody)).elements ?? []) {
            if (el.elementType === want) hit = true;
          }
        } catch {
          continue;
        }
        if (!hit) continue;

        console.log('═'.repeat(70));
        console.log(
          `[${table}] msgId=${String(row[0])}  40011=${String(row[1])}  40012=${String(row[2])}  peer=${String(row[3])}`,
        );
        console.log('═'.repeat(70));

        // 整条 40800 的原始树：45001 是 elements 的重复字段。
        for (const top of decode(body)) {
          const g = best(top.guesses);
          if (g?.kind !== 'len-nested') continue;
          const typeField = g.value.find((f) => f.tag === 45002);
          const typeGuess = typeField && best(typeField.guesses);
          const typeVal = typeGuess && 'value' in typeGuess ? Number(typeGuess.value) : undefined;
          console.log(`\n  --- element (45002=${typeVal}) ---`);
          printTree(g.value, '  ');
        }
        console.log();

        if (++found >= MAX_SAMPLES) break;
      }
      if (rows.length < PAGE) break;
    }
    if (found >= MAX_SAMPLES) break;
  }

  if (found === 0) console.log('没找到。');
  db.close();
}

main().catch((e) => {
  console.error('[dump-element-raw] failed:', e);
  process.exit(1);
});
