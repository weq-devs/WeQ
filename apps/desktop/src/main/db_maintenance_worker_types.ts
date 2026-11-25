import type { RecoverOptions } from '@weq/native';
import type { DbRepairTarget } from '@weq/service';

export type DatabaseMaintenanceWorkerRequest =
  | { kind: 'scan' | 'deep'; target: DbRepairTarget }
  | { kind: 'repair'; options: RecoverOptions }
  | { kind: 'layout'; dbPath: string };
