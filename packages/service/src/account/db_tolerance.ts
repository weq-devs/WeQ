/** 日常读取固定使用无损重试；跳过区间与表由任务按次决定。 */
import type { SalvageBindingOptions, SalvageLedgerEntry } from '@weq/db';
import { getLogger } from '../common/logger';

export interface DbToleranceConfig {
  level: 1;
}

export class DbToleranceService {
  private readonly log = getLogger().child({ scope: 'db-tolerance' });

  get level(): 1 {
    return 1;
  }

  getConfig(): DbToleranceConfig {
    return { level: 1 };
  }

  binding(): SalvageBindingOptions {
    return { level: () => this.level, onEntry: (entry) => this.recordLedgerEntry(entry) };
  }

  recordLedgerEntry(entry: SalvageLedgerEntry): void {
    this.log.debug('database read fallback', { event: 'database-read-fallback', ...entry });
  }
}
