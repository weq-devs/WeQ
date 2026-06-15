/**
 * `category_list_v2` — Buddy categories (groups).
 *
 * This table usually contains only one row with the full list in column 25011.
 */

import { ProtoMsg } from '@weq/codec';
import { CategoryListBody } from '@weq/codec/proto/profile/25011';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

const categoryCodec = new ProtoMsg(CategoryListBody);

export interface Category {
  id: number;
  name: string;
  buddyCount: number;
}

export interface CategoryDbOptions {
  dbPath: string;
  key: string;
  /** Database algorithms. */
  algo: DatabaseAlgorithms;
}

export class CategoryDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: CategoryDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * List all categories. Parses the first row found.
   */
  async listCategories(): Promise<Category[]> {
    const rows = await this.qq.query(
      `SELECT "25011" FROM category_list_v2 LIMIT 1`,
      [],
    );
    if (rows.length === 0) return [];
    
    const blob = rows[0]![0];
    if (!(blob instanceof Uint8Array)) return [];

    try {
      const decoded = categoryCodec.decode(blob);
      return (decoded.items ?? []).map(item => ({
        id: item.id ?? 0,
        name: item.name ?? '',
        buddyCount: item.buddyCount ?? 0,
      }));
    } catch {
      return [];
    }
  }

  close(): void {
    this.qq.close();
  }
}
