/**
 * OIDB 0xCDE_2 — ask the hooked QQ process for a database decryption key.
 *
 * The request body is the account database's 128-char hex salt, extracted from
 * the file header at offset 0x2f..0xaf (caller responsibility, same as the old
 * native `requestDecryptKey`).
 */

import { message } from '../protobuf';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

const DECRYPT_KEY_REQ_INFO = message([{ name: 'dbSalt', tag: 1, type: 'string' }]);

const DECRYPT_KEY_REQ = message([
  { name: 'info', tag: 2, type: DECRYPT_KEY_REQ_INFO },
  { name: 'sessionData', tag: 10, type: 'bytes' },
]);

const DECRYPT_KEY_RESP_INFO = message([{ name: 'dbKey', tag: 1, type: 'string' }]);

const DECRYPT_KEY_RESP = message([{ name: 'info', tag: 2, type: DECRYPT_KEY_RESP_INFO }]);

export namespace RequestDecryptKey {
  export const command = 0xcde;
  export const subCommand = 2;
  export const reqSchema = DECRYPT_KEY_REQ;
  export const respSchema = DECRYPT_KEY_RESP;

  export interface Params {
    /** Lowercase 128-char hex salt from the target database header. */
    dbSalt: string;
  }

  export const serialize = (p: Params): Record<string, unknown> => ({
    info: { dbSalt: p.dbSalt.toLowerCase() },
  });

  export const deserialize = (body: Record<string, unknown>): string => {
    const info = body.info as Record<string, unknown> | undefined;
    const dbKey = typeof info?.dbKey === 'string' ? info.dbKey : '';
    if (!dbKey) throw new Error('decrypt key response missing db_key');
    return dbKey;
  };

  export const invoke = (nt: OidbNative, pid: number, dbSalt: string): Promise<string> =>
    invokeOidb(nt, pid, RequestDecryptKey as OidbSpec<Params, string>, { dbSalt });
}
