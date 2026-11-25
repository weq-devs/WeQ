import type { RecoverOptions } from '@weq/native';
import type { BadPageScanReport, DatabaseRepairMethod, DbRepairTarget } from '@weq/service';

export type DatabaseMaintenanceWorkerRequest =
  | { kind: 'scan' | 'deep'; target: DbRepairTarget }
  | {
      kind: 'locate';
      target: DbRepairTarget;
      scan: BadPageScanReport;
      references: string[];
      quickOnly?: true;
    }
  | { kind: 'clone-backup'; source: string; target: string }
  | {
      kind: 'repair';
      options: RecoverOptions;
      method?: DatabaseRepairMethod;
      streaming?: boolean;
      references?: string[];
    }
  | { kind: 'layout'; dbPath: string };
