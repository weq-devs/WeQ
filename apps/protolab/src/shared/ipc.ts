/**
 * Wire-level contract between protolab's main and renderer processes.
 *
 * Kept in this file so both sides see the exact same channel names and
 * payload shapes. The preload exposes `window.protolab` which mirrors this
 * surface with Promise-returning methods.
 */

export interface OpenDbReq {
  dbPath: string;
  key: string;
}

export interface TableRow {
  name: string;
}

export interface ColumnRow {
  name: string;
  type: string;
}

/**
 * One sampled row's worth of one BLOB column. `bytesHex` is hex because IPC
 * doesn't carry Buffers cleanly across structured clone with arbitrary
 * binary safety; we hex-encode on the main side and decode in the renderer.
 */
export interface CellSample {
  rowid: string; // bigint as string for IPC
  bytesHex: string;
  byteLength: number;
}

export interface SampleReq {
  dbPath: string;
  key: string;
  table: string;
  column: string;
  rowidColumn?: string; // default: "40050" (QQ NT msg tables) or "rowid"
  limit?: number; // default: 20
  offset?: number; // default: 0
  order?: 'ASC' | 'DESC'; // default: 'DESC'
  /**
   * When set, locate this exact row by its rowid column instead of
   * ordering/paginating. `limit`/`offset`/`order` are ignored.
   */
  rowid?: string;
}

export const IPC_CHANNELS = {
  openDb: 'protolab:openDb',
  listTables: 'protolab:listTables',
  listColumns: 'protolab:listColumns',
  sampleColumn: 'protolab:sampleColumn',
  closeDb: 'protolab:closeDb',
} as const;
