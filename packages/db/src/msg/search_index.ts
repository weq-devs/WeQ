/**
 * `MsgSearchIndexDb` — a local trigram FTS5 index over QQ's FTS content tables.
 *
 * The encrypted `buddy_msg_fts.db` / `group_msg_fts.db` content tables have NO
 * index that helps `LIKE '%kw%'` — a substring scan of the 1.49M-row group
 * table costs seconds and the `GROUP BY 40027` ranking is far worse. Instead of
 * touching native, this class reuses existing primitives:
 *
 *   1. `fastDecryptDatabase`  — one-shot native bulk decrypt of the source into
 *      a writable plain SQLite file (~1.3s for the 518MB group DB).
 *   2. `executeSqlWrite`      — the native SQLite build ships FTS5 with the
 *      `trigram` tokenizer, so we create a virtual table right inside the plain
 *      file and populate it with a single `INSERT INTO ... SELECT`.
 *   3. `executeSql`           — subsequent MATCH queries are millisecond-fast.
 *
 * The plain file ends up as a pure search index (the source content table is
 * dropped after the build to keep disk usage down). New messages are synced
 * incrementally by `40001` (msgId) > last indexed id, read from the ENCRYPTED
 * source in JS and inserted in small batches — no re-decrypt needed.
 *
 * If anything fails (QQ running with a locked DB, decrypt error, ...) the
 * caller falls back to the original LIKE scans — search never breaks.
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import type { BuddyMsgFtsHit } from './types';
import { toBigint, toStr } from './util';

const INDEX_TABLE = 'weq_fts_idx';
const META_TABLE = 'weq_fts_meta';
const META_VERSION = '4';

export interface MsgSearchIndexPage {
  items: BuddyMsgFtsHit[];
  total: number;
}

export interface MsgSearchIndexOptions {
  /** Native helper binding (bulk decrypt + plain-SQLite read/write). */
  nt: NtHelperBinding;
  /** Encrypted source database (e.g. `.../nt_db/group_msg_fts.db`). */
  sourcePath: string;
  /** Writable plain SQLite file holding the decrypted source + trigram index. */
  indexDbPath: string;
  /** SQLCipher key for the source database. */
  key?: string;
  /** SQLCipher algorithms for the source database. */
  algo?: DatabaseAlgorithms;
  /** Source content table name (`buddy_msg_fts` / `group_msg_fts`). */
  tableName: string;
}

const INSERT_COLUMNS =
  'partition, sendTime, msgSeq, targetUid, senderUid, msgId, chatType, srcRowid, body, fileName';

export class MsgSearchIndexDb {
  private readonly nt: NtHelperBinding;
  private readonly sourcePath: string;
  private readonly indexDbPath: string;
  private readonly key?: string;
  private readonly algo?: DatabaseAlgorithms;
  private readonly tableName: string;

  /** In-flight build/sync promise — concurrent callers coalesce onto it. */
  private syncing: Promise<void> | null = null;
  /** True once the local index is complete and usable. */
  ready = false;
  /** Human-readable failure reason (for logging only). */
  lastError: string | null = null;

  constructor(opts: MsgSearchIndexOptions) {
    this.nt = opts.nt;
    this.sourcePath = opts.sourcePath;
    this.indexDbPath = opts.indexDbPath;
    this.key = opts.key;
    this.algo = opts.algo;
    this.tableName = opts.tableName;
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Ensure the local index matches the source. Full rebuild on first use or
   * when the source changed beyond an append (fingerprint mismatch); otherwise
   * incremental sync by msgId. Coalesces concurrent calls.
   */
  sync(): Promise<void> {
    if (!this.syncing) {
      this.syncing = this.runSync()
        .then(() => {
          this.ready = true;
          this.lastError = null;
        })
        .catch((e) => {
          this.ready = false;
          this.lastError = e instanceof Error ? e.message : String(e);
          throw e;
        })
        .finally(() => {
          this.syncing = null;
        });
    }
    return this.syncing;
  }

  private async runSync(): Promise<void> {
    if (!this.key || !this.algo) return; // plain source — not supported yet
    let fingerprint = '';
    try {
      // QQ keeps the live DB in WAL mode: new messages land in the -wal file
      // while the main .db size/mtime stay frozen. Fingerprint both so the
      // incremental sync actually fires on appends.
      const st = statSync(this.sourcePath);
      fingerprint = `${st.size}:${st.mtimeMs}`;
      const wal = statSync(`${this.sourcePath}-wal`);
      fingerprint += `:wal-${wal.size}:${wal.mtimeMs}`;
    } catch {
      return; // source missing — leave index as-is
    }
    mkdirSync(dirname(this.indexDbPath), { recursive: true });

    const meta = await this.readMeta();
    if (meta.version !== META_VERSION || meta.fingerprint === '' || !(await this.hasIndex())) {
      await this.fullRebuild(fingerprint);
      return;
    }
    if (meta.fingerprint === fingerprint) return; // unchanged — nothing to do
    await this.incrementalSync(fingerprint, meta.lastRowid);
  }

  /** Drop cached native handles + local files (account switch / shutdown). */
  dispose(): void {
    try {
      this.nt.closeDb(this.indexDbPath);
    } catch {
      /* ignore */
    }
  }

  // --------------------------------------------------------------- queries

  /**
   * Top `limit` partitions by number of matching rows (text column only), most
   * matches first. Requires `keyword` to be ≥ 3 chars (trigram constraint) and
   * the index to be ready.
   */
  async topPartitions(
    keyword: string,
    limit: number,
  ): Promise<Array<{ partition: bigint; count: number }>> {
    const needle = keyword.trim();
    if (!this.ready || [...needle].length < 3) return [];
    const rows = await this.nt.executeSql(
      this.indexDbPath,
      `SELECT partition, COUNT(*) FROM ${INDEX_TABLE}
        WHERE ${INDEX_TABLE} MATCH ?
        GROUP BY partition
        ORDER BY COUNT(*) DESC
        LIMIT ?`,
      [trigramPhrase(needle), BigInt(limit)],
    );
    return rows.map((row) => ({
      partition: toBigint(row[0]),
      count: Number(row[1] ?? 0),
    }));
  }

  /** Paginated rows of ONE partition matching `keyword` (text column), newest first. */
  async searchPartition(
    partition: bigint,
    keyword: string,
    limit = 20,
    offset = 0,
  ): Promise<{ items: BuddyMsgFtsHit[]; total: number }> {
    const needle = keyword.trim();
    if (!this.ready || [...needle].length < 3) {
      return { items: [], total: 0 };
    }
    const phrase = trigramPhrase(needle);
    const [countRows, rows] = await Promise.all([
      this.nt.executeSql(
        this.indexDbPath,
        `SELECT COUNT(*) FROM ${INDEX_TABLE} WHERE ${INDEX_TABLE} MATCH ? AND partition = ?`,
        [phrase, String(partition)],
      ),
      this.nt.executeSql(
        this.indexDbPath,
        `SELECT msgId, chatType, targetUid, senderUid, body, sendTime, fileName, msgSeq
          FROM ${INDEX_TABLE}
          WHERE ${INDEX_TABLE} MATCH ? AND partition = ?
          ORDER BY sendTime DESC
          LIMIT ? OFFSET ?`,
        [phrase, String(partition), BigInt(limit), BigInt(offset)],
      ),
    ]);
    return {
      items: rows.map(rowToHit),
      total: Number(countRows[0]?.[0] ?? 0),
    };
  }

  /** Paginated rows whose FILE NAME (41702) matches `keyword`, newest first. */
  async searchFiles(
    keyword: string,
    limit = 20,
    offset = 0,
  ): Promise<{ items: BuddyMsgFtsHit[]; total: number }> {
    const needle = keyword.trim();
    if (!this.ready || [...needle].length < 3) {
      return { items: [], total: 0 };
    }
    const phrase = `fileName:${trigramPhrase(needle)}`;
    const [countRows, rows] = await Promise.all([
      this.nt.executeSql(
        this.indexDbPath,
        `SELECT COUNT(*) FROM ${INDEX_TABLE} WHERE ${INDEX_TABLE} MATCH ?`,
        [phrase],
      ),
      this.nt.executeSql(
        this.indexDbPath,
        `SELECT msgId, chatType, targetUid, senderUid, body, sendTime, fileName, msgSeq
          FROM ${INDEX_TABLE}
          WHERE ${INDEX_TABLE} MATCH ?
          ORDER BY sendTime DESC
          LIMIT ? OFFSET ?`,
        [phrase, BigInt(limit), BigInt(offset)],
      ),
    ]);
    return {
      items: rows.map(rowToHit),
      total: Number(countRows[0]?.[0] ?? 0),
    };
  }

  // -------------------------------------------------------------- internals

  private async hasIndex(): Promise<boolean> {
    try {
      const rows = await this.nt.executeSql(
        this.indexDbPath,
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [INDEX_TABLE],
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  private async readMeta(): Promise<{ version: string; fingerprint: string; lastRowid: bigint }> {
    try {
      const rows = await this.nt.executeSql(
        this.indexDbPath,
        `SELECT key, value FROM ${META_TABLE}`,
        null,
      );
      const map = new Map(rows.map((r) => [String(r[0]), String(r[1] ?? '')]));
      return {
        version: map.get('version') ?? '',
        fingerprint: map.get('fingerprint') ?? '',
        lastRowid: BigInt(map.get('lastRowid') || '0'),
      };
    } catch {
      return { version: '', fingerprint: '', lastRowid: 0n };
    }
  }

  private async fullRebuild(fingerprint: string): Promise<void> {
    const path = this.indexDbPath;
    try {
      this.nt.closeDb(path);
    } catch {
      /* ignore */
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(path + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
    writeFileSync(path, '');

    // 1) Bulk-decrypt the encrypted source straight into the index file, then
    //    drop any cached handle so the CREATE/INSERT writers are not blocked.
    this.nt.fastDecryptDatabase(this.sourcePath, path, this.key!, this.algo!);
    try {
      this.nt.closeDb(path);
    } catch {
      /* ignore */
    }
    // 2) Create the trigram virtual table inside the decrypted copy.
    await this.nt.executeSqlWrite(
      path,
      `CREATE VIRTUAL TABLE ${INDEX_TABLE} USING fts5(
        partition UNINDEXED,
        sendTime UNINDEXED,
        msgSeq UNINDEXED,
        targetUid UNINDEXED,
        senderUid UNINDEXED,
        msgId UNINDEXED,
        chatType UNINDEXED,
        srcRowid UNINDEXED,
        body,
        fileName,
        tokenize='trigram'
      )`,
      null,
    );
    // 3) Populate in one native INSERT..SELECT (C-speed, no JS marshaling).
    await this.nt.executeSqlWrite(
      path,
      `INSERT INTO ${INDEX_TABLE}(${INSERT_COLUMNS})
        SELECT CAST("40027" AS TEXT), CAST("40050" AS INTEGER), CAST("40003" AS INTEGER),
               CAST("40021" AS TEXT), CAST("40020" AS TEXT), CAST("40001" AS TEXT),
               CAST("40010" AS INTEGER), rowid, "41701", "41702"
        FROM ${this.tableName}`,
      null,
    );
    // 4) Baseline: the LAST indexed source rowid must come from the decrypted
    //    snapshot just populated (reading the live encrypted source here would
    //    race QQ's appends and permanently skip rows written during the build).
    //    closeDb first so a fresh read connection sees the committed snapshot.
    try {
      this.nt.closeDb(path);
    } catch {
      /* ignore */
    }
    const maxRowid = await this.readSnapshotMaxRowid();
    // 5) Reclaim space — the decrypted content table is no longer needed.
    await this.nt.executeSqlWrite(path, `DROP TABLE IF EXISTS ${this.tableName}`, null);
    await this.writeMeta(fingerprint, maxRowid);
    // closeDb checkpoints the WAL; an explicit wal_checkpoint here would need
    // an exclusive lock while the read connection still holds the WAL.
    try {
      this.nt.closeDb(path);
    } catch {
      /* ignore */
    }
    const check = await this.nt.executeSql(path, `SELECT COUNT(*) FROM ${INDEX_TABLE}`, null);
    if (Number(check[0]?.[0] ?? 0) === 0) {
      throw new Error('搜索索引构建后为空');
    }
    // fastDecrypt snapshots the CHECKPOINTED state only — rows still sitting in
    // the source's -wal (plus anything QQ appended during the build) are missed.
    // Catch up right away so the index matches the live source from the start.
    await this.incrementalSync(fingerprint, maxRowid);
  }

  /** Read rows with source rowid > `lastRowid` from the encrypted source and insert them. */
  private async incrementalSync(fingerprint: string, lastRowid: bigint): Promise<void> {
    const batch = 2000;
    let maxSeen = lastRowid;
    for (;;) {
      const rows = await this.nt.executeSqlWithKey(
        this.sourcePath,
        `SELECT CAST("40027" AS TEXT), CAST("40050" AS INTEGER), CAST("40003" AS INTEGER),
               CAST("40021" AS TEXT), CAST("40020" AS TEXT), CAST("40001" AS TEXT),
               CAST("40010" AS INTEGER), rowid, "41701", "41702"
          FROM ${this.tableName}
          WHERE rowid > ?
          ORDER BY rowid ASC
          LIMIT ?`,
        this.key!,
        this.algo!,
        [lastRowid, BigInt(batch)],
      );
      if (rows.length === 0) break;
      await this.batchInsert(rows);
      maxSeen = toBigint(rows[rows.length - 1]![7]);
      if (rows.length < batch) break;
    }
    if (maxSeen > lastRowid) {
      await this.writeMeta(fingerprint, maxSeen);
    }
  }

  private async batchInsert(rows: SqlRow[]): Promise<void> {
    const path = this.indexDbPath;
    const params: SqlValue[] = [];
    for (const r of rows) {
      params.push(
        String(r[0] ?? ''),
        Number(r[1] ?? 0),
        Number(r[2] ?? 0),
        String(r[3] ?? ''),
        String(r[4] ?? ''),
        String(r[5] ?? ''),
        Number(r[6] ?? 0),
        Number(r[7] ?? 0),
        String(r[8] ?? ''),
        String(r[9] ?? ''),
      );
    }
    const values = rows
      .map((_r, i) => `(${Array.from({ length: 10 }, (_c, c) => `?${i * 10 + c + 1}`).join(',')})`)
      .join(',');
    await this.nt.executeSqlWrite(
      path,
      `INSERT INTO ${INDEX_TABLE}(${INSERT_COLUMNS}) VALUES ${values}`,
      params,
    );
  }

  /** Largest rowid in the freshly-decrypted snapshot (the index baseline). */
  private async readSnapshotMaxRowid(): Promise<bigint> {
    try {
      const rows = await this.nt.executeSql(
        this.indexDbPath,
        `SELECT MAX(rowid) FROM ${this.tableName}`,
        null,
      );
      return toBigint(rows[0]?.[0]);
    } catch {
      return 0n;
    }
  }

  private async writeMeta(fingerprint: string, lastRowid: bigint): Promise<void> {
    const path = this.indexDbPath;
    await this.nt.executeSqlWrite(
      path,
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT)`,
      null,
    );
    const upsert = `INSERT INTO ${META_TABLE}(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
    await this.nt.executeSqlWrite(path, upsert, ['version', META_VERSION]);
    await this.nt.executeSqlWrite(path, upsert, ['fingerprint', fingerprint]);
    await this.nt.executeSqlWrite(path, upsert, ['lastRowid', lastRowid.toString()]);
  }
}

/** FTS5 phrase literal — quotes the keyword so operators inside are literal. */
function trigramPhrase(keyword: string): string {
  return `"${keyword.replace(/"/g, '""')}"`;
}

function rowToHit(row: SqlRow): BuddyMsgFtsHit {
  return {
    msgId: toBigint(row[0]),
    chatType: Number(toBigint(row[1])),
    targetUid: toStr(row[2]),
    senderUid: toStr(row[3]),
    content: toStr(row[4]),
    sendTime: toBigint(row[5]),
    fileName: toStr(row[6]) || undefined,
    msgSeq: toBigint(row[7]),
  };
}
