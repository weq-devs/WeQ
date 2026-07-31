/**
 * Scan every message table for CALL elements (elementType=21) and tally the
 * distinct (callMethod, subType/answerType) combinations, flagging the ones
 * missing from CallType / CallSubType in packages/codec/src/element/types.ts.
 *
 * For each unknown combination we print the conversation key and send time of
 * up to a few sample messages so they can be located in QQ itself.
 *
 * Run: pnpm tsx packages/db/tools/scan_call_types.ts
 */

import { loadNative } from '@weq/native';
import { testEnv } from '@weq/testkit';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';

const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

const KNOWN_METHOD: Record<number, string> = {
  1: 'VOICE',
  2: 'VIDEO',
  3: 'SCREEN_SHARE',
  5: 'REMOTE_ASSIST',
};

const KNOWN_SUBTYPE: Record<number, string> = {
  2: 'VIDEO_ACCEPTED',
  3: 'VIDEO_REJECTED_BY_US',
  6: 'VIDEO_REJECTED_BY_PEER',
  7: 'VOICE_ACCEPTED',
  8: 'VOICE_REJECTED_BY_US',
  11: 'VOICE_REJECTED_BY_PEER',
  12: 'VIDEO_HANDLED_OTHER_DEVICE',
  13: 'VOICE_HANDLED_OTHER_DEVICE',
  19: 'SCREEN_SHARE_ACCEPTED',
  22: 'SCREEN_SHARE_REJECTED',
  33: 'REMOTE_ASSIST_ACCEPTED',
  34: 'REMOTE_ASSIST_FAILED',
};

interface Sample {
  table: string;
  msgId: string;
  conv: string;
  senderUin: string;
  time: string;
  duration: number;
  summary: string;
  answerType: number;
  unknownType: number | undefined;
  flag48153: string | undefined;
  flag48156: number | undefined;
}

interface Bucket {
  count: number;
  samples: Sample[];
}

const fmtTime = (sec: number): string => {
  if (!sec) return '(no time)';
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

const TABLES: { name: string; convCol: string; label: string }[] = [
  { name: 'group_msg_table', convCol: '40027', label: '群' },
  { name: 'c2c_msg_table', convCol: '40030', label: '私聊对端QQ' },
  { name: 'dataline_msg_table', convCol: '40030', label: '数据线' },
];

const MAX_SAMPLES = 20;

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: testEnv.msgDbPath,
    key: testEnv.key,
    algo: ALGO,
  });

  const buckets = new Map<string, Bucket>();
  const methodTally = new Map<number, number>();
  const subTypeTally = new Map<number, number>();
  let totalCalls = 0;

  for (const t of TABLES) {
    let rows: Awaited<ReturnType<typeof db.query>>;
    try {
      rows = await db.query(
        `SELECT "40001","${t.convCol}","40033","40050","40800" FROM ${t.name}`,
        [],
      );
    } catch (e) {
      console.log(`skip ${t.name}: ${(e as Error).message}`);
      continue;
    }
    let calls = 0;
    for (const r of rows) {
      const blob = r[4];
      if (!(blob instanceof Uint8Array)) continue;
      let els: ReturnType<typeof decodeBody>;
      try {
        els = decodeBody(blob);
      } catch {
        continue;
      }
      for (const el of els ?? []) {
        const e = el as Record<string, unknown>;
        if (num(e.elementType) !== 21 && e.kind !== 'call') continue;
        calls++;
        totalCalls++;
        const method = num(e.callMethod);
        const sub = num(e.subType);
        methodTally.set(method, (methodTally.get(method) ?? 0) + 1);
        subTypeTally.set(sub, (subTypeTally.get(sub) ?? 0) + 1);

        const key = `${method}|${sub}`;
        let b = buckets.get(key);
        if (!b) {
          b = { count: 0, samples: [] };
          buckets.set(key, b);
        }
        b.count++;
        if (b.samples.length < MAX_SAMPLES) {
          const summary = Array.isArray(e.callSummary)
            ? (e.callSummary as unknown[]).map(String).join(' / ')
            : '';
          b.samples.push({
            table: t.name,
            msgId: str(r[0]),
            conv: `${t.label} ${str(r[1])}`,
            senderUin: str(r[2]),
            time: fmtTime(num(r[3])),
            duration: num(e.duration),
            summary,
            answerType: num(e.answerType),
            unknownType: e.callUnknownType === undefined ? undefined : num(e.callUnknownType),
            flag48153: e.callFlag48153 === undefined ? undefined : String(e.callFlag48153),
            flag48156: e.callFlag48156 === undefined ? undefined : num(e.callFlag48156),
          });
        }
      }
    }
    console.log(`${t.name}: rows=${rows.length} callElements=${calls}`);
  }

  console.log(`\n=== 总计 CALL 元素: ${totalCalls} ===`);

  console.log('\n--- callMethod (48154 / CallType) 分布 ---');
  for (const [m, c] of [...methodTally.entries()].sort((a, b) => a[0] - b[0])) {
    const tag = KNOWN_METHOD[m] ?? '*** 未枚举 ***';
    console.log(`  callMethod=${m}  count=${c}  ${tag}`);
  }

  console.log('\n--- subType (CallSubType) 分布 ---');
  for (const [s, c] of [...subTypeTally.entries()].sort((a, b) => a[0] - b[0])) {
    const tag = KNOWN_SUBTYPE[s] ?? '*** 未枚举 ***';
    console.log(`  subType=${s}  count=${c}  ${tag}`);
  }

  const entries = [...buckets.entries()]
    .map(([k, b]) => {
      const parts = k.split('|');
      return { m: Number(parts[0]), s: Number(parts[1]), b };
    })
    .sort((a, b) => a.m - b.m || a.s - b.s);

  console.log('\n--- (callMethod, subType) 组合矩阵 ---');
  for (const { m, s, b } of entries) {
    const unknownM = KNOWN_METHOD[m] === undefined;
    const unknownS = KNOWN_SUBTYPE[s] === undefined;
    const mark = unknownM || unknownS ? '  <== 未枚举' : '';
    console.log(
      `  method=${m}(${KNOWN_METHOD[m] ?? '?'}) subType=${s}(${KNOWN_SUBTYPE[s] ?? '?'}) count=${b.count}${mark}`,
    );
  }

  console.log('\n\n================ 未枚举组合的样本 ================');
  let any = false;
  for (const { m, s, b } of entries) {
    if (KNOWN_METHOD[m] !== undefined && KNOWN_SUBTYPE[s] !== undefined) continue;
    any = true;
    console.log(
      `\n### callMethod=${m} (${KNOWN_METHOD[m] ?? '未枚举'})  subType=${s} (${KNOWN_SUBTYPE[s] ?? '未枚举'})  共 ${b.count} 条`,
    );
    for (const sm of b.samples) {
      console.log(
        `  - [${sm.time}] ${sm.conv}  发送者=${sm.senderUin}  msgId=${sm.msgId}\n` +
          `      表=${sm.table} 时长=${sm.duration} answerType=${sm.answerType}` +
          ` unknownType=${sm.unknownType ?? '-'} flag48153=${sm.flag48153 ?? '-'} flag48156=${sm.flag48156 ?? '-'}\n` +
          `      摘要="${sm.summary}"`,
      );
    }
  }
  if (!any) console.log('（没有未枚举的组合）');

  console.log('\n\n================ 已枚举组合的样本（对照用） ================');
  for (const { m, s, b } of entries) {
    if (KNOWN_METHOD[m] === undefined || KNOWN_SUBTYPE[s] === undefined) continue;
    console.log(`\n### method=${m}/${KNOWN_METHOD[m]} sub=${s}/${KNOWN_SUBTYPE[s]} count=${b.count}`);
    for (const sm of b.samples) {
      console.log(
        `  - [${sm.time}] ${sm.conv} 发送者=${sm.senderUin} 时长=${sm.duration}` +
          ` u=${sm.unknownType ?? '-'} f56=${sm.flag48156 ?? '-'} 摘要="${sm.summary}"`,
      );
    }
  }

  db.close();
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
