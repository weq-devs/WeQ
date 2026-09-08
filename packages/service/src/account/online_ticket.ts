/**
 * Online ticket / key fetchers formerly implemented inside nt_helper
 * (`src/protocol/service/*`). They are pure protocol + HTTP flows on top of the
 * generic native `sendOidbPacket`, so they now live in TS where the OIDB specs
 * are maintained.
 *
 * What stays native is only the hook transport itself (`sendOidbPacket` /
 * `sendPacket`) and the ptlogin2 **local** quick-login fallback (`ptFetchSkey`
 * / `ptFetchPskey`) — the latter deliberately untouched.
 */

import { openSync, readSync, closeSync } from 'node:fs';
import type { NtHelperBinding } from '@weq/native';
import {
  FetchClientKey,
  FetchDownloadRkeys,
  FetchPskeyOidb,
  RequestDecryptKey,
  type ClientKeyInfo,
  type DownloadRkey,
} from '@weq/protocol';
import { buildPtlogin2JumpUrl, httpGetSetCookiesOnce } from './web/ptlogin';

/** Minimal native surface: only the generic packet sender is needed. */
export type OnlineTicketNt = Pick<NtHelperBinding, 'sendOidbPacket'>;

/** Fetch the account clientKey via OIDB 0x102A_1 (mirrors nt_helper). */
export function fetchClientKey(nt: OnlineTicketNt, pid: number): Promise<ClientKeyInfo> {
  return FetchClientKey.invoke(nt, pid);
}

/** Fetch rich-media download rkeys via OIDB 0x9067_202 (mirrors nt_helper). */
export function fetchDownloadRkeys(nt: OnlineTicketNt, pid: number): Promise<DownloadRkey[]> {
  return FetchDownloadRkeys.invoke(nt, pid);
}

/**
 * ptlogin2 jump with redirect-following disabled — the same 302 cookie grab the
 * Rust `fetch_skey` / `fetch_pskey` services did. QQ sets `skey` / `p_skey` on
 * the 302 itself; the landing page is not fetched (it frequently 503s and never
 * carries cookies).
 */
async function fetchPtloginCookie(
  nt: OnlineTicketNt,
  pid: number,
  uin: string,
  landingUrl: string,
): Promise<Record<string, string>> {
  const ck = await fetchClientKey(nt, pid);
  return httpGetSetCookiesOnce(buildPtlogin2JumpUrl(ck, uin, landingUrl));
}

/** Fetch the domain-independent `skey` via a hooked process (mirrors Rust). */
export async function fetchSkeyFromHook(
  nt: OnlineTicketNt,
  pid: number,
  uin: string,
): Promise<string> {
  const landing =
    'https://h5.qzone.qq.com/qqnt/qzoneinpcqq/friend?refresh=0&clientuin=0&darkMode=0';
  const jar = await fetchPtloginCookie(nt, pid, uin, landing);
  const skey = jar.skey;
  if (!skey) throw new Error('skey not found in ptlogin2 cookies');
  return skey;
}

/**
 * Fetch the `p_skey` for `domain` via a hooked process. Tries the ptlogin2 jump
 * first and falls back to OIDB 0x102A_0 — exactly the ordering nt_helper used.
 */
export async function fetchPskeyFromHook(
  nt: OnlineTicketNt,
  pid: number,
  uin: string,
  domain: string,
): Promise<string> {
  const landing = `https://${domain}/${uin}/infocenter`;
  const jar = await fetchPtloginCookie(nt, pid, uin, landing);
  const web = jar.p_skey;
  if (web) return web;
  return FetchPskeyOidb.invoke(nt, pid, domain);
}

/**
 * Ask the hooked QQ process for a database decryption key. Mirrors nt_helper's
 * `request_decrypt_key`: reads the 128-char hex salt from the file header at
 * offset 0x2f..0xaf, validates it, sends OIDB 0xCDE_2 and maps the well-known
 * "account mismatch" error to a human-readable message.
 */
export async function requestDecryptKeyFromInstance(
  nt: OnlineTicketNt,
  pid: number,
  dbPath: string,
): Promise<string> {
  const SALT_START = 0x2f;
  const SALT_LEN = 128;
  const HEADER_LEN = SALT_START + SALT_LEN; // 0xaf
  const buf = Buffer.alloc(HEADER_LEN);

  const fd = openSync(dbPath, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < HEADER_LEN) {
      const n = readSync(fd, buf, bytesRead, HEADER_LEN - bytesRead, bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
  } finally {
    closeSync(fd);
  }
  if (bytesRead < HEADER_LEN) throw new Error(`Failed to read db: ${dbPath}`);

  const dbSalt = buf.toString('latin1', SALT_START, HEADER_LEN);
  if (!/^[0-9a-fA-F]{128}$/.test(dbSalt)) {
    throw new Error('Invalid db_salt: not a valid 128-character hex string');
  }

  try {
    return await RequestDecryptKey.invoke(nt, pid, dbSalt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('OIDB error 1006')) {
      throw new Error('数据库不匹配！检查数据库是否属于当前帐号');
    }
    throw error;
  }
}
