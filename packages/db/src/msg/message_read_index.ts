import type { DatabaseAlgorithms, NtHelperBinding } from '@weq/native';
import { QqDb } from '../qq_db';

export const MESSAGE_READ_INDEXES = [
  { name: 'weq_read_uid_seq_c2c', table: 'c2c_msg_table' },
  { name: 'weq_read_uid_seq_dataline', table: 'dataline_msg_table' },
] as const;
export const MESSAGE_READ_INDEX_COLUMNS = ['40021', '40003', '40050', '40001'] as const;

/** 与年度报告索引相同的 SQLite 派生索引；QQ 写入时由 SQLite 自动维护。 */
export class MessageReadIndexDb {
  private readonly qq: QqDb;

  constructor(
    nt: NtHelperBinding,
    options: { dbPath: string; key?: string; algo?: DatabaseAlgorithms },
  ) {
    this.qq = new QqDb(nt, options);
  }

  async ensure(options: { beforeCreate?: () => Promise<boolean> } = {}): Promise<string[]> {
    const installed: string[] = [];
    for (const index of MESSAGE_READ_INDEXES) {
      if (!(await this.qq.hasTable(index.table))) continue;
      if (!(await this.qq.hasIndexPrefix(index.table, MESSAGE_READ_INDEX_COLUMNS))) {
        if (options.beforeCreate && !(await options.beforeCreate())) return installed;
        await this.qq.write(
          `CREATE INDEX IF NOT EXISTS ${index.name} ON ${index.table}("40021","40003","40050","40001")`,
        );
        if (!(await this.qq.hasIndexPrefix(index.table, MESSAGE_READ_INDEX_COLUMNS)))
          throw new Error('消息读取索引名称已被其他定义占用');
      }
      installed.push(index.table);
    }
    return installed;
  }
}
