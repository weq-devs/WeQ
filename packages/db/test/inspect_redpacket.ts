/**
 * 对比「专属红包」与「普通拼手气红包」的 wallet element 原始字段，
 * 找出指定领取群友 id 所在的字段。
 *
 * Run:  pnpm --filter @weq/db exec tsx test/inspect_redpacket.ts
 */

import { loadNative } from '@weq/native';
import { decode, type RawField, type Guess } from '@weq/codec/raw';
import { GroupMsgDb } from '../src/msg/group';
import { testEnv } from '@weq/testkit';

const DB_PATH = testEnv.msgDbPath;
const KEY = testEnv.key;

const CASES: Array<{ label: string; msgId: bigint }> = [
  { label: '专属红包 (给指定群友)', msgId: 7661607490431795174n },
  { label: '普通拼手气红包', msgId: 7661606365443025303n },
];

/** 从一个字段挑选最能代表其内容的一个 guess，输出精简描述。 */
function topGuess(g: Guess): string {
  switch (g.kind) {
    case 'varint-uint64':
      return `uint64=${g.value}`;
    case 'varint-bool':
      return `bool=${g.value}`;
    case 'varint-timestamp-ms':
    case 'varint-timestamp-sec':
      return `time=${g.value.toISOString()}`;
    case 'varint-int64-zigzag':
      return `zigzag=${g.value}`;
    case 'i64-fixed':
      return `i64=${g.value}`;
    case 'i64-double':
      return `f64=${g.value}`;
    case 'i32-fixed':
      return `i32=${g.value}`;
    case 'i32-float':
      return `f32=${g.value}`;
    case 'len-utf8':
      return `str=${JSON.stringify(g.value)}`;
    case 'len-bytes':
      return `bytes[${g.value.length}]=${Buffer.from(g.value).toString('hex').slice(0, 48)}`;
    case 'len-nested':
      return `nested(${g.value.length} fields)`;
  }
}

function printTree(fields: RawField[], indent: string): void {
  for (const f of fields) {
    // guesses 已按 confidence 降序；取最高置信一条作为主展示
    const best = f.guesses[0];
    const nested = f.guesses.find((g) => g.kind === 'len-nested');
    if (nested && nested.kind === 'len-nested') {
      console.log(`${indent}#${f.tag}  ${topGuess(nested)}`);
      printTree(nested.value, `${indent}  `);
      // 若同一 LEN 字段还能被解释成字符串，附注一下
      const asStr = f.guesses.find((g) => g.kind === 'len-utf8');
      if (asStr && asStr.kind === 'len-utf8' && asStr.value.trim()) {
        console.log(`${indent}    (也可读作 ${topGuess(asStr)})`);
      }
    } else if (best) {
      console.log(`${indent}#${f.tag}  ${topGuess(best)}`);
    }
  }
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new GroupMsgDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  for (const c of CASES) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${c.label}  msgId=${c.msgId}`);
    console.log('='.repeat(70));

    const body = await db.getMsgBody(c.msgId);
    if (!body) {
      console.log('  (未找到该 msgId 的 msgBody)');
      continue;
    }
    console.log(`msgBody ${body.length} bytes\n`);
    const fields = decode(body);
    printTree(fields, '');
  }

  db.close();
}

main().catch((e) => {
  console.error('[inspect_redpacket] failed:', e);
  process.exit(1);
});
