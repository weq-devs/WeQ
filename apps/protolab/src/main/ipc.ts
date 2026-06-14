/**
 * Main-process IPC handlers. The protocol is intentionally schema-free at
 * this layer: the renderer asks for tables/columns/cells, the main process
 * runs straight SQL via nt_helper and ships the bytes back.
 */

import { ipcMain } from 'electron';
import { QqDb } from '@weq/db';
import { loadNative } from '@weq/native';
import { IPC_CHANNELS, type CellSample, type ColumnRow, type SampleReq, type TableRow } from '../shared/ipc';

const dbCache = new Map<string, QqDb>();

async function getDb(dbPath: string, key: string): Promise<QqDb> {
  const cached = dbCache.get(dbPath);
  if (cached) return cached;

  const { ntHelper } = loadNative();
  
  // 1. Probe for algorithms first
  const probe = await ntHelper.testDatabaseKey(dbPath, key);
  if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
    throw new Error('Database key is incorrect or algorithm probing failed.');
  }

  const algo = {
    pageHmacAlgorithm: probe.pageHmacAlgorithm,
    kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
  };

  // 2. Instantiate with probed algorithms
  const db = new QqDb(ntHelper, { dbPath, key, algo });
  dbCache.set(dbPath, db);
  return db;
}

function bytesToHex(buf: Buffer | Uint8Array): string {
  return Buffer.isBuffer(buf) ? buf.toString('hex') : Buffer.from(buf).toString('hex');
}

export function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.openDb, async (_e, req: { dbPath: string; key: string }) => {
    // getDb already performs probing and validation now.
    await getDb(req.dbPath, req.key);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.listTables, async (_e, req: { dbPath: string; key: string }): Promise<TableRow[]> => {
    const db = await getDb(req.dbPath, req.key);
    const rows = await db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    return rows.map((r) => ({ name: String(r[0]) }));
  });

  ipcMain.handle(
    IPC_CHANNELS.listColumns,
    async (_e, req: { dbPath: string; key: string; table: string }): Promise<ColumnRow[]> => {
      const db = await getDb(req.dbPath, req.key);
      // PRAGMA table_info doesn't take ? — escape the identifier instead.
      const safe = req.table.replace(/[^A-Za-z0-9_]/g, '');
      const rows = await db.query(`PRAGMA table_info("${safe}")`);
      // cid | name | type | notnull | dflt_value | pk
      return rows.map((r) => ({ name: String(r[1]), type: String(r[2] ?? '') }));
    },
  );

  ipcMain.handle(IPC_CHANNELS.sampleColumn, async (_e, req: SampleReq): Promise<CellSample[]> => {
    const db = await getDb(req.dbPath, req.key);
    const safeTable = req.table.replace(/[^A-Za-z0-9_]/g, '');
    const safeCol = req.column.replace(/[^A-Za-z0-9_]/g, '');
    const safeRowid = (req.rowidColumn ?? 'rowid').replace(/[^A-Za-z0-9_]/g, '');
    const limit = Math.min(Math.max(req.limit ?? 20, 1), 200);
    const offset = Math.max(req.offset ?? 0, 0);
    const order = req.order === 'ASC' ? 'ASC' : 'DESC';

    // rowid lookup: fetch exactly one row by its rowid column, ignoring
    // pagination/order. rowid columns are integers in QQ NT tables, so we
    // bind a bigint param rather than splicing it into the SQL.
    const rows =
      req.rowid != null && req.rowid !== ''
        ? await db.query(
            `SELECT "${safeRowid}", "${safeCol}" FROM "${safeTable}" WHERE "${safeRowid}" = ? AND "${safeCol}" IS NOT NULL`,
            [BigInt(req.rowid)],
          )
        : await db.query(
            `SELECT "${safeRowid}", "${safeCol}" FROM "${safeTable}" WHERE "${safeCol}" IS NOT NULL ORDER BY "${safeRowid}" ${order} LIMIT ${limit} OFFSET ${offset}`,
          );

    const out: CellSample[] = [];
    for (const r of rows) {
      const id = r[0];
      const val = r[1];
      if (val == null) continue;
      const buf = Buffer.isBuffer(val) ? val : typeof val === 'string' ? Buffer.from(val, 'utf-8') : null;
      if (!buf) continue;
      out.push({
        rowid: String(id),
        bytesHex: bytesToHex(buf),
        byteLength: buf.length,
      });
    }
    return out;
  });

  ipcMain.handle(IPC_CHANNELS.closeDb, async (_e, dbPath: string) => {
    const db = dbCache.get(dbPath);
    if (db) {
      db.close();
      dbCache.delete(dbPath);
    }
  });
}
