import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { QqDb } from '../qq_db';
import { withDatabasePriority } from '../query_schedule';
import {
  SENDER_NAME_COLUMNS,
  readSenderNames,
  type GroupSenderNameFilter,
} from './group_sender_history';

const BATCH = 8192;
const RECONCILE_MS = 24 * 60 * 60 * 1000;
const CHECK_MS = 10_000;
const READER_IDLE_MS = 5000;

type Checkpoint = {
  source: string;
  generation: number;
  floor: string | null;
  next: string | null;
  high: string | null;
  completedAt: number;
  rebuilding: boolean;
};

export class GroupSenderNameIndex {
  private db?: DatabaseSync;
  private running?: Promise<void>;
  private checkAfter = 0;
  private readerUntil = 0;
  private readonly searchReaders = new Map<AbortSignal, number>();
  private error?: unknown;
  private readonly stop = new AbortController();
  pending = false;

  constructor(
    private readonly source: QqDb,
    private readonly path: string,
  ) {}

  close() {
    this.stop.abort();
    this.db?.close();
    this.db = undefined;
  }

  private database() {
    if (this.db) return this.db;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = createRequire(import.meta.url)(
      'node:sqlite',
    ) as typeof import('node:sqlite');
    const db = new DatabaseSync(this.path);
    db.exec(`
      PRAGMA busy_timeout=1000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, checkpoint TEXT);
      CREATE TABLE IF NOT EXISTS names (
        groupCode TEXT, uid TEXT, uin TEXT, name TEXT, kind TEXT,
        first TEXT, last TEXT, generation INTEGER,
        PRIMARY KEY (uid,groupCode,kind,name)
      );
    `);
    this.db = db;
    return db;
  }

  private checkpoint(db: DatabaseSync) {
    return db.prepare('SELECT checkpoint FROM state WHERE id=1').get()?.checkpoint as
      | string
      | undefined;
  }

  private commit(db: DatabaseSync, current: string | undefined, write: () => void) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (this.checkpoint(db) === current) write();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private save(db: DatabaseSync, state: Checkpoint) {
    db.prepare(
      `INSERT INTO state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET checkpoint=excluded.checkpoint`,
    ).run(JSON.stringify(state));
  }

  private sourceIdentity() {
    const sourceFile = statSync(this.source.dbPath);
    return JSON.stringify([1, sourceFile.dev, sourceFile.ino, sourceFile.birthtimeMs]);
  }

  private hasReader() {
    const now = Date.now();
    for (const [signal, until] of this.searchReaders)
      if (signal.aborted || until <= now) this.searchReaders.delete(signal);
    return this.readerUntil > now || this.searchReaders.size > 0;
  }

  async search(filter: GroupSenderNameFilter) {
    this.stop.signal.throwIfAborted();
    filter.signal?.throwIfAborted();
    const until = Date.now() + READER_IDLE_MS;
    if (filter.signal) this.searchReaders.set(filter.signal, until);
    else this.readerUntil = until;
    if (!this.running && Date.now() >= this.checkAfter) {
      this.error = undefined;
      this.running = this.scan()
        .catch((error: unknown) => {
          if (!this.stop.signal.aborted) this.error = error;
        })
        .finally(() => {
          this.running = undefined;
          this.pending = false;
          this.checkAfter = this.hasReader() ? Date.now() + CHECK_MS : 0;
        });
    }
    const db = this.database();
    const meta = this.checkpoint(db);
    const checkpoint = meta ? (JSON.parse(meta) as Checkpoint) : undefined;
    const sourceMatches = checkpoint?.source === this.sourceIdentity();
    this.pending = Boolean(this.running && (!sourceMatches || !checkpoint?.completedAt));
    if (!sourceMatches) {
      if (this.error) throw this.error;
      return [];
    }
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.senderUid) {
      where.push('uid=?');
      params.push(filter.senderUid);
    }
    if (filter.groupCode) {
      where.push('groupCode=?');
      params.push(filter.groupCode);
    }
    if (filter.keyword) {
      where.push('instr(lower(name),lower(?))>0');
      params.push(filter.keyword);
    }
    const subset = `SELECT * FROM names ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const order = filter.keyword ? 'length(name),last DESC,' : 'last DESC,';
    const sql = filter.distinctSenders
      ? `WITH matches AS (${subset}), ranked AS (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY uid ORDER BY ${order} groupCode,name,kind) AS rank
           FROM matches
         )
         SELECT groupCode,uid,uin,name,kind,first,last FROM ranked WHERE rank=1
           ORDER BY ${order} groupCode,uid,name,kind LIMIT ? OFFSET ?`
      : `SELECT groupCode,uid,uin,name,kind,first,last FROM (${subset})
           ORDER BY ${order} groupCode,uid,name,kind LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...params, filter.limit, filter.offset ?? 0);
    if (!rows.length && this.error) throw this.error;
    return readSenderNames(
      rows.map((row) => [
        row.groupCode == null ? null : String(row.groupCode),
        String(row.uid),
        String(row.uin),
        String(row.name),
        String(row.kind),
        String(row.first),
        String(row.last),
      ]),
    );
  }

  private async scan() {
    const db = this.database();
    const signal = this.stop.signal;
    const identity = this.sourceIdentity();
    const query = (sql: string, params?: Array<bigint | null>) =>
      withDatabasePriority('background', () => this.source.query(sql, params), signal);
    const schema = await this.source.tableColumns('group_msg_table');
    signal.throwIfAborted();
    if (!this.hasReader() || !SENDER_NAME_COLUMNS.some((column) => schema.has(column))) return;
    const nameFields = SENDER_NAME_COLUMNS.map((column, i) =>
      schema.has(column) ? `trim("${column}") AS n${i}` : `NULL AS n${i}`,
    );
    let previous = this.checkpoint(db);
    const loaded = previous ? (JSON.parse(previous) as Checkpoint) : undefined;
    const high = (await query('SELECT max(rowid) FROM group_msg_table'))[0]?.[0];
    signal.throwIfAborted();
    const highKey = high == null ? null : String(high);
    if (!loaded || loaded.source !== identity) {
      this.commit(db, previous, () => {
        db.exec('DELETE FROM names');
        this.save(db, {
          source: identity,
          generation: 1,
          high: highKey,
          next: null,
          floor: null,
          completedAt: 0,
          rebuilding: true,
        });
      });
    } else if (loaded.completedAt) {
      const rebuild =
        loaded.completedAt < Date.now() - RECONCILE_MS ||
        (highKey !== null && loaded.high !== null && BigInt(highKey) < BigInt(loaded.high));
      if (!rebuild && loaded.high === highKey) return;
      this.commit(db, previous, () =>
        this.save(db, {
          ...loaded,
          high: highKey,
          next: null,
          floor: rebuild ? null : loaded.high,
          completedAt: 0,
          rebuilding: rebuild,
          generation: loaded.generation + Number(rebuild),
        }),
      );
    }

    const collect = db.prepare(`
      INSERT INTO names VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(uid,groupCode,kind,name) DO UPDATE SET
        uin=CASE WHEN excluded.generation<>names.generation OR names.uin='0' THEN excluded.uin ELSE names.uin END,
        first=CASE WHEN excluded.generation=names.generation THEN min(names.first,excluded.first) ELSE excluded.first END,
        last=CASE WHEN excluded.generation=names.generation THEN max(names.last,excluded.last) ELSE excluded.last END,
        generation=excluded.generation
    `);
    while (this.hasReader()) {
      signal.throwIfAborted();
      previous = this.checkpoint(db);
      if (!previous) return;
      const state = JSON.parse(previous) as Checkpoint;
      if (state.completedAt || state.source !== identity) return;
      const rows =
        state.high === null
          ? []
          : await query(
              `
        WITH page AS MATERIALIZED (
          SELECT rowid AS cursor,"40027" AS grp,"40020" AS uid,"40033" AS uin,"40011" AS type,
            "40050" AS sent,${nameFields.join(',')},
            printf('%020d:%020d:%020d',"40050","40001","40003") AS evidence
          FROM group_msg_table
          WHERE ${state.next === null ? 'rowid<=?' : 'rowid<?'} ${state.floor === null ? '' : 'AND rowid>?'}
          ORDER BY rowid DESC LIMIT ${BATCH}
        ), kinds(kind) AS (VALUES ('display'),('nickname')), observations AS (
          SELECT grp,uid,uin,CASE kind WHEN 'display' THEN n0 ELSE n1 END AS name,kind,evidence
          FROM page CROSS JOIN kinds WHERE uid GLOB 'u_*' AND type>1 AND type<>5 AND sent>0
        )
        SELECT grp,uid,max(uin),name,kind,min(evidence),max(evidence)
          FROM observations WHERE name<>'' GROUP BY grp,uid,name,kind
        UNION ALL SELECT min(cursor),NULL,NULL,NULL,NULL,NULL,NULL FROM page
      `,
              [
                BigInt(state.next ?? state.high),
                ...(state.floor === null ? [] : [BigInt(state.floor)]),
              ],
            );
      signal.throwIfAborted();
      const last = rows.pop()?.[0];
      this.commit(db, previous, () => {
        if (last == null) {
          if (state.rebuilding)
            db.prepare('DELETE FROM names WHERE generation<>?').run(state.generation);
          this.save(db, { ...state, completedAt: Date.now(), next: null });
          return;
        }
        for (const row of rows)
          collect.run(...row.map((value) => String(value ?? '0')), state.generation);
        this.save(db, { ...state, next: String(last) });
      });
      if (last == null && this.checkpoint(db) !== previous) return;
      await new Promise<void>((done) => setTimeout(done, 10));
    }
  }
}
