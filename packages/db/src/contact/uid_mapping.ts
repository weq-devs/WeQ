/**
 * `nt_uid_mapping_table` — the account's uid ↔ uin ↔ sort-number directory.
 *
 * QQ NT assigns every peer the account has interacted with a small, 1-based
 * incrementing "sort number" and stores the three identities together:
 *   48901  sortNo  (INTEGER — per-account peer index, starts at 1)
 *   48902  uid     (TEXT    — the opaque peer uid used everywhere else)
 *   1002   uin     (INTEGER — the peer's QQ number)
 *
 * Why this matters: in `c2c_msg_table` the conversation-partition column is
 * `40027` (= this sortNo), and every useful composite index is built on it
 * (`(40027,40003)` etc.). The rest of the app keys conversations by uid (40021,
 * which is *unindexed*), so to query c2c messages on the fast path we must
 * translate uid → sortNo first. This table is the translation source.
 *
 * The set is small and stable, so a session loads it once into a resident
 * {@link UidMap} (see `UidMap.from`) and keeps it in memory.
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow } from '@weq/native';
import { toBigint, toStr } from '../msg/util';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"48901","48902","1002"`;

/** One row of `nt_uid_mapping_table`. */
export interface UidMappingRow {
  /** 48901 — per-account peer sort number (= c2c_msg_table.40027). */
  sortNo: bigint;
  /** 48902 — peer uid. */
  uid: string;
  /** 1002 — peer QQ uin. */
  uin: bigint;
}

export interface UidMappingDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

export class UidMappingDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: UidMappingDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** Every uid/uin/sortNo triple in the table. */
  async listAll(): Promise<UidMappingRow[]> {
    const rows = await this.qq.query(`SELECT ${SELECT_COLUMNS} FROM nt_uid_mapping_table`);
    return rows.map(rowToMapping);
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}

function rowToMapping(row: SqlRow): UidMappingRow {
  return {
    sortNo: toBigint(row[0]),
    uid: toStr(row[1]),
    uin: toBigint(row[2]),
  };
}

/**
 * Resident, in-memory uid ↔ uin ↔ sortNo directory for one account.
 *
 * Built once from {@link UidMappingDb.listAll} and held on the session. All
 * lookups are synchronous `Map` reads so the hot query path (c2c uid → sortNo)
 * never touches the database. bigint keys are stored as their decimal string.
 */
export class UidMap {
  private readonly uidToSort = new Map<string, bigint>();
  private readonly sortToUid = new Map<string, string>();
  private readonly uidToUin = new Map<string, bigint>();
  private readonly uinToUid = new Map<string, string>();

  /** Build a resident map from raw mapping rows. */
  static from(rows: readonly UidMappingRow[]): UidMap {
    const map = new UidMap();
    for (const row of rows) map.add(row);
    return map;
  }

  private add(row: UidMappingRow): void {
    if (row.uid) {
      this.uidToSort.set(row.uid, row.sortNo);
      this.uidToUin.set(row.uid, row.uin);
    }
    this.sortToUid.set(row.sortNo.toString(), row.uid);
    if (row.uin !== 0n) this.uinToUid.set(row.uin.toString(), row.uid);
  }

  /** c2c partition number (column 40027) for a peer uid, or undefined if unknown. */
  sortNoByUid(uid: string): bigint | undefined {
    return this.uidToSort.get(uid);
  }

  /** Peer uid for a sort number, or undefined if unknown. */
  uidBySortNo(sortNo: bigint): string | undefined {
    return this.sortToUid.get(sortNo.toString());
  }

  /** Peer QQ uin for a uid, or undefined if unknown. */
  uinByUid(uid: string): bigint | undefined {
    return this.uidToUin.get(uid);
  }

  /** Peer uid for a QQ uin, or undefined if unknown. */
  uidByUin(uin: bigint): string | undefined {
    return this.uinToUid.get(uin.toString());
  }

  /** Number of mapped peers. */
  get size(): number {
    return this.uidToSort.size;
  }
}
