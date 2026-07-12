/**
 * 验证 typed decode 路径能否解出 walletDesignatedUin(48420) 与 walletRedbagType(48412)。
 * Run:  pnpm --filter @weq/db exec tsx test/verify_wallet_decode.ts
 */

import { loadNative } from '@weq/native';
import { ProtoMsg } from '@weq/codec';
import { decodeElement } from '@weq/codec/element';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { sanitizeBytes } from '@weq/codec/raw';
import { GroupMsgDb } from '../src/msg/group';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

const MSG_IDS = [7661607490431795174n, 7661606365443025303n];

async function main(): Promise<void> {
  const native = loadNative();
  const db = new GroupMsgDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });
  const codec = new ProtoMsg(MsgBody);

  for (const msgId of MSG_IDS) {
    const blob = await db.getMsgBody(msgId);
    console.log('\n== msgId', msgId.toString(), '==');
    if (!blob) {
      console.log('  no body');
      continue;
    }
    const decoded = codec.decode(sanitizeBytes(blob, MsgBody));
    for (const w of decoded.elements ?? []) {
      const el = decodeElement(w) as Record<string, unknown>;
      if (el.kind !== 'wallet') continue;
      console.log('  walletRedbagType(48412) =', el.walletRedbagType);
      console.log('  walletDesignatedUin(48420) =', el.walletDesignatedUin);
      console.log('  walletTargetUin(48401) =', el.walletTargetUin);
    }
  }
  db.close();
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
