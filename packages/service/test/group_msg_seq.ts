/**
 * Test group message ordering and msgSeq.
 */

import { loadNative } from '@weq/native';
import { GroupMsgDb } from '@weq/db';
import { MsgService } from '../src/account/msg';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const GROUP_CODE = '1090396070';
const DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\nt_msg.db`;

async function main() {
  const native = loadNative();
  
  const groupMsgsDb = new GroupMsgDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const mockSession = {
    groupMsgs: groupMsgsDb,
    lastMsgIdMaps: { groupMsgId: 0n },
  } as any;

  const service = new MsgService(mockSession);

  try {
    console.log(`[test:group-msg-seq] Fetching messages for group: ${GROUP_CODE}`);
    
    const messages = await service.getGroupMessages(GROUP_CODE, 5);
    console.log(`[test:group-msg-seq] Found ${messages.length} messages:`);
    
    messages.forEach((m, i) => {
        console.log(`${i+1}. [Seq: ${m.msgSeq}] [Time: ${m.sendTime}] ID: ${m.msgId}`);
    });

    if (messages.length >= 2) {
        const m0 = messages[0];
        const m1 = messages[1];
        if (m0 && m1) {
            const isCorrectOrder = m0.msgSeq >= m1.msgSeq;
            console.log(`[test:group-msg-seq] Order by Seq correct: ${isCorrectOrder}`);
        }
    }

  } catch (err) {
    console.error('[test:group-msg-seq] Failed:', err);
  } finally {
    groupMsgsDb.close();
  }
}

main().catch((e) => {
  console.error('[test:group-msg-seq] failed:', e);
  process.exit(1);
});
