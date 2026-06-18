import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

export interface FileAssistantRow {
  fileName: string;
  fileHash: string;
  msgId: bigint;
  fileSize: bigint;
  timestamp: bigint;
  senderUid: string;
  peerUid: string;
  localPath: string;
  sourceTable: 'file_assistant' | 'file_assistant_v2';
}

export interface FileAssistantDbOptions {
  dbPath: string;
  key: string;
  algo: DatabaseAlgorithms;
}

const SELECT_COLUMNS = `"200002", "200001", "200016", "200005", "200009", "1000", "40021", "200011"`;

export class FileAssistantDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: FileAssistantDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * List all files from both tables.
   */
  async listAll(limit = 100, offset = 0): Promise<FileAssistantRow[]> {
    const [v1, v2] = await Promise.all([
      this.listFromTable('file_assistant', limit + offset, 0),
      this.listFromTable('file_assistant_v2', limit + offset, 0),
    ]);
    return [...v1, ...v2]
      .sort((a, b) => Number(b.timestamp - a.timestamp))
      .slice(offset, offset + limit);
  }

  /**
   * Search file info by msgId.
   * Note: Observed that the column "200016" (msgId) in this DB is often target_msgId + 1.
   * We search for msgId + 1 first, then fallback to a range search.
   */
  async getByMsgId(msgId: bigint): Promise<FileAssistantRow | null> {
    const target = msgId + 1n;
    
    // 1. Try exact match with msgId + 1
    for (const table of ['file_assistant_v2', 'file_assistant']) {
      const rows = await this.qq.query(
        `SELECT ${SELECT_COLUMNS} FROM ${table} WHERE "200016" = ? LIMIT 1`,
        [target],
      );
      if (rows.length > 0) return rowToInfo(rows[0]!, table as any);
    }

    // 2. Fallback: Range search [msgId - 2, msgId + 2]
    // We want the one closest to the target msgId
    const lower = msgId - 2n;
    const upper = msgId + 2n;
    
    for (const table of ['file_assistant_v2', 'file_assistant']) {
      const rows = await this.qq.query(
        `SELECT ${SELECT_COLUMNS} FROM ${table} WHERE "200016" >= ? AND "200016" <= ? ORDER BY ABS("200016" - ?) ASC LIMIT 1`,
        [lower, upper, msgId],
      );
      if (rows.length > 0) return rowToInfo(rows[0]!, table as any);
    }

    return null;
  }

  private async listFromTable(tableName: string, limit: number, offset: number): Promise<FileAssistantRow[]> {
    try {
      const rows = await this.qq.query(
        `SELECT ${SELECT_COLUMNS} FROM ${tableName} ORDER BY "200009" DESC LIMIT ? OFFSET ?`,
        [limit, offset],
      );
      return rows.map(r => rowToInfo(r, tableName as any));
    } catch (e) {
      // Table might not exist in older versions
      return [];
    }
  }

  close(): void {
    this.qq.close();
  }
}

function rowToInfo(row: SqlRow, sourceTable: 'file_assistant' | 'file_assistant_v2'): FileAssistantRow {
  return {
    fileName: String(row[0] ?? ''),
    fileHash: String(row[1] ?? '').toLowerCase(),
    msgId: toBigint(row[2]),
    fileSize: toBigint(row[3]),
    timestamp: toBigint(row[4]),
    senderUid: String(row[5] ?? ''),
    peerUid: String(row[6] ?? ''),
    localPath: String(row[7] ?? ''),
    sourceTable,
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}
