/**
 * Ad-hoc inspection: dump the raw structure of a GUILD (KCHATTYPEGUILDMETA=16)
 * row in recent_contact_v3_table, and diff its populated columns against a
 * normal GROUP row — to understand why guild rows lack displayText / nick.
 *
 * Run:  pnpm --filter @weq/db exec tsx test/inspect_guild_row.ts
 */

import { loadNative } from '@weq/native';
import { decode, type RawField, type Guess } from '@weq/codec/raw';
import { QqDb } from '../src/qq_db';
import type { SqlValue } from '@weq/native';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

function fmtGuess(g: Guess): string {
  switch (g.kind) {
    case 'varint-uint64':
    case 'varint-int64-zigzag':
    case 'i64-fixed':
      return g.value.toString();
    case 'varint-bool':
      return String(g.value);
    case 'i32-fixed':
    case 'i32-float':
    case 'i64-double':
      return String(g.value);
    case 'len-utf8':
      return JSON.stringify(g.value);
    case 'len-bytes':
      return `<${g.value.length}B>`;
    default:
      return '';
  }
}

function printTree(fields: RawField[], indent: string): void {
  for (const f of fields) {
    const nested = f.guesses.find((g) => g.kind === 'len-nested') as
      | Extract<Guess, { kind: 'len-nested' }>
      | undefined;
    const utf8 = f.guesses.find((g) => g.kind === 'len-utf8') as
      | Extract<Guess, { kind: 'len-utf8' }>
      | undefined;

    if (nested && nested.consumedAll) {
      const hint = utf8 ? `  (or str ${JSON.stringify(utf8.value)})` : '';
      console.log(`${indent}#${f.tag} {${hint}`);
      printTree(nested.value, indent + '  ');
      console.log(`${indent}}`);
    } else {
      console.log(`${indent}#${f.tag} = ${fmtGuess(f.guesses[0]!)}`);
    }
  }
}

function present(row: SqlValue[], colNames: string[]): Set<string> {
  const s = new Set<string>();
  row.forEach((v, i) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string' && v === '') return;
    s.add(colNames[i]!);
  });
  return s;
}

async function main(): Promise<void> {
  const native = loadNative();
  const qq = new QqDb(native.ntHelper, { dbPath: DB_PATH, key: KEY });

  const colInfo = await qq.query(`PRAGMA table_info("recent_contact_v3_table")`);
  const colNames = colInfo.map((r) => String(r[1]));
  console.log(`[inspect] table has ${colNames.length} columns`);

  const guildRows = await qq.query(
    `SELECT * FROM recent_contact_v3_table WHERE "40010" = 16 ORDER BY "40050" DESC LIMIT 1`,
  );
  const groupRows = await qq.query(
    `SELECT * FROM recent_contact_v3_table WHERE "40010" = 2 ORDER BY "40050" DESC LIMIT 1`,
  );

  if (!guildRows.length) {
    console.log('[inspect] no guild (40010=16) rows found');
    qq.close();
    return;
  }

  const guild = guildRows[0]!;
  console.log('\n===== GUILD row — all non-null columns =====');
  guild.forEach((v, i) => {
    const name = colNames[i]!;
    if (v === null || v === undefined) return;
    if (v instanceof Uint8Array) {
      console.log(`\n[${name}] <BLOB ${v.length}B>`);
      try {
        printTree(decode(v), '  ');
      } catch (e) {
        console.log(`  (decode failed: ${String(e)})`);
      }
    } else if (typeof v === 'string' && v === '') {
      /* skip empty string */
    } else {
      console.log(`[${name}] = ${typeof v === 'bigint' ? v.toString() : String(v)}`);
    }
  });

  if (groupRows.length) {
    const group = groupRows[0]!;
    const gp = present(guild, colNames);
    const grp = present(group, colNames);
    const onlyGroup = [...grp].filter((c) => !gp.has(c)).sort();
    const onlyGuild = [...gp].filter((c) => !grp.has(c)).sort();
    console.log('\n===== column diff (populated) =====');
    console.log('columns a normal GROUP row has but this GUILD row does NOT:');
    console.log('  ', onlyGroup.join(', ') || '(none)');
    console.log('columns this GUILD row has but the GROUP row does NOT:');
    console.log('  ', onlyGuild.join(', ') || '(none)');
  }

  qq.close();
}

main().catch((e) => {
  console.error('[inspect] failed:', e);
  process.exit(1);
});
