/**
 * Script to list file assistant entries and print the newest one.
 */

import { loadNative } from '@weq/native';
import { FileAssistantDb } from '@weq/db';
import fs from 'node:fs';

// Update these with your real values
const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as any;

const DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\file_assistant.db`;

async function main() {
  const native = loadNative();
  
  if (!fs.existsSync(DB_PATH)) {
      console.error(`[test:file-assistant] Could not find file_assistant.db at ${DB_PATH}`);
      return;
  }

  const fileDb = new FileAssistantDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: ALGO,
  });

  try {
    console.log(`[test:file-assistant] Fetching files for UIN: ${UIN}`);
    
    const files = await fileDb.listAll(100);
    
    const targetMsgId = 7652484344240255125n;
    console.log(`\n--- Searching for msgId: ${targetMsgId} ---`);
    const found = await fileDb.getByMsgId(targetMsgId);
    if (found) {
        console.log('Found match:');
        console.log(JSON.stringify(found, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    } else {
        console.log('No match found for this msgId.');
    }

    if (files.length > 0) {
        console.log(`[test:file-assistant] Found ${files.length} files.`);
        
        // listAll already sorts by timestamp DESC
        const newest = files[0]!;
        console.log('\n--- Newest File ---');
        console.log(JSON.stringify(newest, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
        
        console.log('\n--- Recent 5 Files ---');
        console.table(files.slice(0, 5).map(f => ({
            name: f.fileName,
            size: (Number(f.fileSize) / 1024 / 1024).toFixed(2) + ' MB',
            time: new Date(Number(f.timestamp) * 1000).toLocaleString(),
            table: f.sourceTable
        })));

    } else {
        console.log('[test:file-assistant] No files found.');
    }

  } catch (err) {
    console.error('[test:file-assistant] Failed:', err);
  } finally {
    fileDb.close();
  }
}

main().catch((e) => {
  console.error('[test:file-assistant] failed:', e);
  process.exit(1);
});
