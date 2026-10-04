/**
 * OIDB 0x102A_0 — OIDB fallback used when the ptlogin2 web jump fails to set a
 * `p_skey` cookie for the target domain. Ported from nt_helper
 * `src/protocol/service/fetch_pskey.rs` (`fetch_pskey_oidb`).
 *
 * 真机抓包修正：客户端发 `0x102a_0` 时信封带 `reserved = 1`（`60 01`），即
 * nt_helper `OidbBase.reserved` / `is_uid=true` 的那条 UIN-form 分支。缺了它服务端
 * 拿到的是另一套校验路径（红包 `hb_pc_pre_pack` 用 tenpay.com 的 p_skey 时会被
 * 业务层判成 `66201015 数据检查失败`）。
 */

import { message } from '../protobuf';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

const PSKEY_ITEM = message([
  { name: 'domain', tag: 1, type: 'string' },
  { name: 'pskey', tag: 2, type: 'string' },
  { name: 'expireTime', tag: 3, type: 'uint64' },
]);

const GET_PSKEY_REQ = message([{ name: 'domains', tag: 1, type: 'string', repeated: true }]);

const GET_PSKEY_RESP = message([{ name: 'items', tag: 1, type: PSKEY_ITEM, repeated: true }]);

function findPskey(body: Record<string, unknown>, domain: string): string {
  const items = (body.items as Record<string, unknown>[] | undefined) ?? [];
  for (const item of items) {
    if (item.domain === domain && typeof item.pskey === 'string' && item.pskey !== '') {
      return item.pskey;
    }
  }
  throw new Error(`p_skey not found for domain: ${domain}`);
}

export namespace FetchPskeyOidb {
  export const command = 0x102a;
  export const subCommand = 0;
  /** 真机抓包 `60 01`：UIN-form 信封（`OidbBase.reserved = 1`）。 */
  export const uinForm = true;
  export const reqSchema = GET_PSKEY_REQ;
  export const respSchema = GET_PSKEY_RESP;

  export interface Params {
    domain: string;
  }

  export const serialize = (p: Params): Record<string, unknown> => ({
    domains: [p.domain],
  });

  export const deserialize = (body: Record<string, unknown>): string => findPskey(body, '');

  export const invoke = (nt: OidbNative, pid: number, domain: string): Promise<string> => {
    const spec: OidbSpec<Params, string> = {
      ...FetchPskeyOidb,
      deserialize: (body: Record<string, unknown>) => findPskey(body, domain),
    };
    return invokeOidb(nt, pid, spec, { domain });
  };
}
