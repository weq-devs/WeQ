/**
 * OIDB 0x102A_1 — fetch the account `clientKey` used to mint ptlogin2
 * credentials (skey / p_skey / full cookie jar).
 *
 * Ported verbatim from nt_helper `src/protocol/service/fetch_client_key.rs`
 * so the wire shape and the zero-default fallbacks stay identical.
 */

import { message } from '../protobuf';
import { toInt } from './shared';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

const CLIENT_KEY_RESP = message([
  { name: 'keyIndex', tag: 2, type: 'uint32' },
  { name: 'clientKey', tag: 3, type: 'string' },
  { name: 'expireTime', tag: 4, type: 'uint32' },
]);

export interface ClientKeyInfo {
  /** Raw clientKey string (empty means the response was unusable). */
  clientKey: string;
  /** keyIndex as a decimal string — QQ's ptlogin2 jump expects a string. */
  keyIndex: string;
  /** Server-reported TTL in seconds; `1800` when the server omits it. */
  ttlSeconds: number;
}

export namespace FetchClientKey {
  export const command = 0x102a;
  export const subCommand = 1;
  export const reqSchema = message([]);
  export const respSchema = CLIENT_KEY_RESP;

  export interface Params {
    /** No request fields — the account is implicit in the hooked process. */
    _?: never;
  }

  export const serialize = (): Record<string, unknown> => ({});

  export const deserialize = (body: Record<string, unknown>): ClientKeyInfo => {
    const clientKey = typeof body.clientKey === 'string' ? body.clientKey : '';
    if (!clientKey) throw new Error('clientKey response missing client_key');
    return {
      clientKey,
      // Mirrors nt_helper: server 0 / absent → 19.
      keyIndex: String(toInt(body.keyIndex) || 19),
      // Mirrors nt_helper: server 0 / absent → 1800.
      ttlSeconds: toInt(body.expireTime) || 1800,
    };
  };

  export const invoke = (nt: OidbNative, pid: number): Promise<ClientKeyInfo> =>
    invokeOidb(nt, pid, FetchClientKey as OidbSpec<Params, ClientKeyInfo>, {});
}
