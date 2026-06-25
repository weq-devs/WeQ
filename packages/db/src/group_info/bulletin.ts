/**
 * `group_bulletin` — Group announcements.
 *
 * Column map:
 *   60001  groupCode       (INTEGER)
 *   64205  content         (BLOB/Protobuf)
 */

import { ProtoMsg } from '@weq/codec';
import { GroupBulletinBody } from '@weq/codec/proto/group_info/64205';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

const bulletinCodec = new ProtoMsg(GroupBulletinBody);

export interface GroupBulletin {
  groupCode: bigint;
  publisherUid: string;
  fid: string;
  msgTime: bigint;
  ctime: bigint;
  textContent: string;
}

export interface GroupBulletinDbOptions {
  dbPath: string;
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

const SELECT_COLUMNS = `"60001","64205"`;

export class GroupBulletinDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GroupBulletinDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * List bulletins for a group.
   */
  async listBulletins(groupCode: bigint, limit = 50, offset = 0): Promise<GroupBulletin[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM group_bulletin WHERE "60001" = ? LIMIT ? OFFSET ?`,
      [groupCode, limit, offset],
    );
    return rows.map(rowToBulletin);
  }

  close(): void {
    this.qq.close();
  }
}

function rowToBulletin(row: SqlRow): GroupBulletin {
  const blob = row[1];
  let detail: any = {};
  
  if (blob instanceof Uint8Array) {
    try {
      const decoded = bulletinCodec.decode(blob);
      // Navigation: Root -> body (64205) -> detail (64202)
      detail = decoded.body?.detail ?? {};
    } catch {}
  }

  // Navigation: detail (64202) -> contentContainer (64227) -> items (64242 repeated) -> textContent (64452)
  const items = detail.contentContainer?.items ?? [];
  const textContent = items.map((i: any) => i.textContent ?? '').join('\n');

  return {
    groupCode: toBigint(row[0]),
    publisherUid: detail.publisherUid ?? '',
    fid: detail.fid ?? '',
    msgTime: detail.msgTime ?? 0n,
    ctime: detail.ctime ?? 0n,
    textContent,
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}
