// 修改个人头像 —— 走 highway HTTP 上传（cmdId 90），不是 OIDB 信封。
//
// 与群头像（cmdId 3000 + `GroupAvatarExtra`）同一条 highway 通道，区别只在
// 命令号与 extend：
//   - 个人头像 cmdId = **90**，extend 为空字节。
//
// 搬运自 SnowLuma `core/src/bridge/apis/profile.ts` 的 `setAvatar`。
//
// 签名：highway 通道不发 SSO 包、不涉及 SecSign。

import { promises as fsp } from 'node:fs';
import { computeHashes } from '../../highway/hash-file';
import {
  BufferChunkSource,
  fetchHighwaySession,
  uploadHighwayHttp,
} from '../../highway/highway-client';
import { cleanNtLocalPath } from '../shared';
import type { TrpcNative } from '../../transport';

/** 个人头像的 highway 命令号。 */
export const SELF_AVATAR_HIGHWAY_CMD = 90;

export interface SetSelfAvatarParams {
  /** 自己账号 uin（highway 帧头要带）。 */
  uin: string | number;
  /** 头像图片：本地路径，或已在内存里的字节。 */
  source: string | Uint8Array;
  /** 可选日志钩子（分块上传进度）。 */
  log?: (message: string) => void;
}

async function readSource(source: string | Uint8Array): Promise<Uint8Array> {
  if (source instanceof Uint8Array) {
    if (source.length === 0) throw new Error('头像图片为空');
    return source;
  }
  const path = cleanNtLocalPath(source);
  const bytes = new Uint8Array(await fsp.readFile(path));
  if (bytes.length === 0) throw new Error(`头像图片为空：${path}`);
  return bytes;
}

/** 上传并设置个人头像。需要已登记的在线 QQ 会话。 */
export async function setSelfAvatar(
  nt: TrpcNative,
  pid: number,
  params: SetSelfAvatarParams,
): Promise<void> {
  const uin = String(params.uin ?? '').trim();
  if (!/^\d+$/.test(uin) || uin === '0') {
    throw new Error(`uin 必须是正整数字符串，收到 ${uin}`);
  }
  const bytes = await readSource(params.source);
  const hashes = computeHashes(bytes);
  const session = await fetchHighwaySession(nt, pid);
  await uploadHighwayHttp({
    session,
    uin,
    commandId: SELF_AVATAR_HIGHWAY_CMD,
    source: new BufferChunkSource(bytes),
    fileMd5: hashes.md5,
    // 个人头像不带 extend。
    extend: new Uint8Array(0),
    ...(params.log ? { log: params.log } : {}),
  });
}
