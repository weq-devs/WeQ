/**
 * `t_GPro_CommonUserProfile_v2` (in guild1.db) - cached common profiles of
 * QQ 频道 users, keyed by guild tiny id.
 *
 * Column map (subset we read):
 *   tiny_id_      (INTEGER, PRIMARY KEY)
 *   nick_name_    (TEXT)
 *   avatar_meta_  (TEXT - avatar handle; URL composition lives one layer up)
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow } from '@weq/native';
import type { GuildCommonProfile } from './types';
import { QqDb } from '../qq_db';

export interface GuildCommonProfileDbOptions {
  /** Absolute path to guild1.db. */
  dbPath: string;
  /** SQLCipher key (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

/** Common profile accessor (guild1.db). */
export class GuildCommonProfileDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GuildCommonProfileDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * Batch-fetch profiles by tiny id. Missing ids are simply absent from the
   * result (never a partial throw), so a stale profile cache degrades to
   * "no profile" instead of failing the whole DM list.
   */
  async listByTinyIds(tinyIds: readonly bigint[]): Promise<GuildCommonProfile[]> {
    const unique = [...new Set(tinyIds.filter((id) => id !== 0n))];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT "tiny_id_","nick_name_","avatar_meta_" FROM t_GPro_CommonUserProfile_v2
        WHERE "tiny_id_" IN (${placeholders})`,
      unique,
    );
    return rows.map(rowToGuildCommonProfile);
  }

  /** Drop the cached native connection. */
  close(): void {
    this.qq.close();
  }
}

function rowToGuildCommonProfile(row: SqlRow): GuildCommonProfile {
  return {
    tinyId: toBigint(row[0]),
    nick: toText(row[1]),
    avatarMeta: toText(row[2]),
  };
}

function toBigint(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

function toText(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}
