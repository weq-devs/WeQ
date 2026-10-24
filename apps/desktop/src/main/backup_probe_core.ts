import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveAndroidDbKey, peekStaticSelfUin } from '@weq/account';
import { QqDb } from '@weq/db';
import type { NtHelperBinding } from '@weq/native';
import type { Platform } from '@weq/platform';
import type { BackupProbeInput, BackupProbeResult } from './backup_probe_protocol';

/** 只读固定长度头；不能用一次无密钥 SQL 查询来猜测加密格式。 */
export async function isPlainBackupDatabase(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(1040);
    let length = 0;
    while (length < header.length) {
      const { bytesRead } = await file.read(header, length, header.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const magic = Buffer.from('SQLite format 3\0', 'ascii');
    return (
      (length >= 16 && header.subarray(0, 16).equals(magic)) ||
      (length >= 1040 && header.subarray(1024, 1040).equals(magic))
    );
  } finally {
    await file.close();
  }
}

/** 仅由短命 worker 调用；所有原生数据库探测都留在该进程内。 */
export async function inspectBackupDatabases(
  nt: NtHelperBinding,
  input: BackupProbeInput,
): Promise<BackupProbeResult> {
  try {
    const msgPath = join(input.dirPath, 'nt_msg.db');
    let dbKey = input.dbKey;
    let mobile = false;
    if (!dbKey) {
      const plain =
        (await isPlainBackupDatabase(msgPath)) &&
        (await isPlainBackupDatabase(join(input.dirPath, 'profile_info.db')));
      if (!plain) {
        const derived = await deriveAndroidDbKey(nt, input.dirPath);
        if (!derived) return { status: 'needKey' };
        dbKey = derived.dbKey;
        mobile = true;
      }
    }
    if (dbKey) {
      const result = await nt.testDatabaseKey(msgPath, dbKey);
      if (!result.success) return { status: 'error', error: '密钥不匹配' };
    }
    const self = await peekStaticSelfUin(
      { native: { ntHelper: nt } } as Platform,
      input.dirPath,
      dbKey,
      undefined,
      input.expectedUin,
    );
    if (!dbKey) {
      const db = new QqDb(nt, { dbPath: msgPath });
      try {
        await db.query('SELECT name FROM sqlite_master LIMIT 1');
      } finally {
        db.close();
      }
    }
    return {
      status: 'ready',
      dbKey,
      mobile,
      preview: {
        uin: self.uin,
        uid: self.uid,
        displayName: self.nick,
        avatarUrl: self.avatarUrl,
      },
    };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}
