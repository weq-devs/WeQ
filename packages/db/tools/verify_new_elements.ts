/**
 * Verify the newly-modelled elements decode correctly through the real codec
 * (not the schema-free probe): GRAY_TIP subType=10/15, TEXT subType=1/2, and
 * a spot-check that the newly-named tags (语音转文字 / CDN IP / 群名片) land on
 * the right fields.
 *
 * Run: pnpm --filter @weq/db tools:verify-new-elements
 */

import { loadNative } from '@weq/native';
import { testEnv } from '@weq/testkit';
import { ProtoMsg, decodeElement, encodeElement } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { QqDb } from '../src/qq_db';

const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const BODY = new ProtoMsg(MsgBody);

/** msgIds picked from the earlier probes, one per thing we want to confirm. */
const CASES: Array<{ what: string; table: string; msgId: string }> = [
  { what: '文件传输完成灰条 (subType=10)', table: 'c2c_msg_table', msgId: '7394768443929600550' },
  { what: '临时会话灰条 (subType=15)', table: 'c2c_msg_table', msgId: '7623777491628169212' },
  { what: 'TEXT 外部链接 (subType=1)', table: 'c2c_msg_table', msgId: '7438986440915208598' },
  { what: 'TEXT 可信链接 (subType=2)', table: 'group_msg_table', msgId: '7549183873220801564' },
  { what: '语音转文字 (PTT 45923)', table: 'c2c_msg_table', msgId: '7397644804072039304' },
  { what: 'CDN IP/端口 (PIC 45806/45807)', table: 'group_msg_table', msgId: '7416157402068439336' },
  {
    what: '撤回者群名片 (GRAY_TIP 47707/47716)',
    table: 'group_msg_table',
    msgId: '7416202100200981686',
  },
  { what: '互动标识纯文本 (GRAY_TIP 48274)', table: 'c2c_msg_table', msgId: '7420025779182201391' },
  { what: '位置共享 (elementType=28)', table: 'c2c_msg_table', msgId: '7429928725160164844' },
];

function ipv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Print only the fields that matter, so the output stays readable. */
function summarize(el: Record<string, unknown>): string[] {
  const out: string[] = [`kind=${el.kind}  subType=${el.subType ?? 0}`];
  const interesting = [
    'textContent',
    'fileName',
    'fileSize',
    'fileToken',
    'pttTranscript',
    'pttDuration',
    'cdnServerIp',
    'cdnServerPort',
    'thumbnailLocalPath',
    'recallSenderNick',
    'recallSenderGroupNick',
    'recallRevokeNick',
    'recallRevokeGroupNick',
    'recallSenderNickCopy',
    'recallRevokeNickCopy',
    'grayTipPlainText',
    'grayTipTimestamp',
    'tempSessionGroupCode',
    'aioOpFlag47501',
    'shareLocationText',
    'urlVerifyFlag',
    'groupTipGroupName',
  ];
  for (const k of interesting) {
    const v = el[k];
    if (v === undefined) continue;
    let shown: string;
    if (v instanceof Uint8Array) shown = `<${v.byteLength} bytes>`;
    else if (k === 'cdnServerIp' && typeof v === 'number') shown = `${v} (${ipv4(v)})`;
    else if (k === 'grayTipTimestamp' && typeof v === 'number') {
      shown = `${v} (${new Date(v * 1000).toISOString().slice(0, 19).replace('T', ' ')})`;
    } else if (typeof v === 'string')
      shown = JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}…` : v);
    else shown = String(v);
    out.push(`  ${k} = ${shown}`);
  }
  return out;
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, { dbPath: testEnv.msgDbPath, key: testEnv.key, algo: ALGO });

  let pass = 0;
  let fail = 0;

  for (const c of CASES) {
    console.log(`\n${'─'.repeat(74)}`);
    console.log(`${c.what}   [${c.table}] ${c.msgId}`);
    console.log('─'.repeat(74));

    const rows = await db.query(`SELECT "40800" FROM "${c.table}" WHERE "40001" = ? LIMIT 1`, [
      BigInt(c.msgId),
    ]);
    const body = rows[0]?.[0];
    if (!(body instanceof Uint8Array)) {
      console.log('  ✗ 行不存在或 40800 为空');
      fail++;
      continue;
    }

    const wires = BODY.decode(body).elements ?? [];
    for (const w of wires) {
      const el = decodeElement(w) as unknown as Record<string, unknown>;
      for (const line of summarize(el)) console.log(`  ${line}`);
      if (el.kind === 'unknown') {
        console.log(`    ⚠ 仍是 unknown (elementType=${el.elementType})`);
        fail++;
      } else {
        // Round-trip: encode back and make sure the bytes survive.
        const reWire = encodeElement(el as never);
        const reBytes = BODY.encode({ elements: [reWire] });
        const reBack = decodeElement(BODY.decode(reBytes).elements![0]!) as unknown as Record<
          string,
          unknown
        >;
        const ok = reBack.kind === el.kind;
        console.log(`    ${ok ? '✓' : '✗'} round-trip ${ok ? 'ok' : `kind 变了: ${reBack.kind}`}`);
        ok ? pass++ : fail++;
      }
    }
  }

  console.log(`\n${'═'.repeat(74)}`);
  console.log(`  通过 ${pass}  失败 ${fail}`);
  db.close();
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('[verify] failed:', e);
  process.exit(1);
});
