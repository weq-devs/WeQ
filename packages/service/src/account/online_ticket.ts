/**
 * Online ticket / key fetchers.
 *
 * clientKey / skey / p_skey / 邮箱会话的换取都收进了 nt_helper；这里只保留
 * 仍由 TS 维护 OIDB schema 的 rkey / dbkey 请求，以及给调用方做轻量封装的
 * `fetchClientKey`（内部直接调用 native）。
 */

import { openSync, readSync, closeSync } from 'node:fs';
import type { NtHelperBinding } from '@weq/native';
import {
  FetchDownloadRkeys,
  RequestDecryptKey,
  type ClientKeyInfo,
  type DownloadRkey,
} from '@weq/protocol';

/** OIDB 请求只需要通用发包能力。 */
export type OnlineTicketOidbNt = Pick<NtHelperBinding, 'sendOidbPacket'>;

/** clientKey 已整体收进 native，调用方不需要再自己发 OIDB。 */
export type OnlineTicketClientKeyNt = Pick<NtHelperBinding, 'ptFetchClientKey'>;

/** 兼容旧的组合类型：同时具备 OIDB 与 clientKey 能力的 native 绑定。 */
export type OnlineTicketNt = OnlineTicketOidbNt & OnlineTicketClientKeyNt;

/** Fetch the account clientKey via native (ptlogin2 first, OIDB fallback). */
export async function fetchClientKey(
  nt: OnlineTicketClientKeyNt,
  pid: number,
  uin: string,
): Promise<ClientKeyInfo> {
  const result = await nt.ptFetchClientKey(pid, uin);
  if (!result.success || !result.clientKey) {
    throw new Error(result.msg || 'clientKey 获取失败');
  }
  return {
    clientKey: result.clientKey,
    keyIndex: result.keyIndex,
    ttlSeconds: result.ttlSeconds,
  };
}

/**
 * Fetch rich-media download rkeys via OIDB 0x9067_202 (mirrors nt_helper).
 *
 * `types` 缺省只取图片那三档（10/20/2）；要语音 / 视频的 rkey 得显式传
 * 14/24、12/22 —— 它们各自绑场景，服务端不会顺带下发。
 */
export function fetchDownloadRkeys(
  nt: OnlineTicketOidbNt,
  pid: number,
  types?: number[],
): Promise<DownloadRkey[]> {
  return FetchDownloadRkeys.invoke(nt, pid, types ? { types } : {});
}

/**
 * Ask the hooked QQ process for a database decryption key. Mirrors nt_helper's
 * `request_decrypt_key`: reads the 128-char hex salt from the file header at
 * offset 0x2f..0xaf, validates it, sends OIDB 0xCDE_2 and maps the well-known
 * "account mismatch" error to a human-readable message.
 */
export async function requestDecryptKeyFromInstance(
  nt: OnlineTicketOidbNt,
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
