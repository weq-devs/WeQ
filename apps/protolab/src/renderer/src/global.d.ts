// Re-declare the preload-exposed API for the renderer's type-only build,
// since tsconfig.web.json doesn't pull in the preload sources.
import type { CellSample, ColumnRow, SampleReq, TableRow } from '../../shared/ipc';

declare global {
  interface Window {
    protolab: {
      openDb(req: { dbPath: string; key: string }): Promise<{ ok: true }>;
      listTables(req: { dbPath: string; key: string }): Promise<TableRow[]>;
      listColumns(req: { dbPath: string; key: string; table: string }): Promise<ColumnRow[]>;
      sampleColumn(req: SampleReq): Promise<CellSample[]>;
      closeDb(dbPath: string): Promise<void>;
    };
  }
}
