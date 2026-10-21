// 修改群头像 —— 走 highway HTTP 上传（cmdId 3000），不是 OIDB 信封。
//
// 与个人头像（cmdId 90）同一条 highway 通道，区别：
//   - 命令号 3000；
//   - extend 里带 `GroupAvatarExtra`（type=101 + groupUin + field3.field1=1 + field5=3 + field6=1）。
//
// 搬运自 SnowLuma `core/src/bridge/apis/profile.ts` 的 setGroupAvatar
// （对齐 Lagrange.Core `OperationLogic.GroupSetAvatar`）。
//
// 流程：读图 → md5 → 申请 highway 会话（`HttpConn.0x6ff_501`）→ 分块 PUT。
// 需要已登记的在线 QQ 会话；离线时报错。
//
// 签名：highway 通道不发 SSO 包、不涉及 SecSign。

import { promises as fsp } from 'node:fs';
import { encode, message } from '../../protobuf';
import { computeHashes } from '../../highway/hash-file';
import {
  BufferChunkSource,
  fetchHighwaySession,
  uploadHighwayHttp,
} from '../../highway/highway-client';
import { cleanNtLocalPath } from '../shared';
import { requireUin, requireUint32 } from '../write-validation';
import { detectImageFormat } from '../../highway/image-format';
import type { TrpcNative } from '../../transport';

/** group avatar 的 highway 命令号。 */
export const GROUP_AVATAR_HIGHWAY_CMD = 3000;
export const SELF_AVATAR_HIGHWAY_CMD = 90;
export const AVATAR_MAX_BYTES = 16 * 1024 * 1024;

/** `GroupAvatarExtra`（作为 highway 的 extend）。 */
const GROUP_AVATAR_EXTRA = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'groupUin', tag: 2, type: 'uint32' },
  {
    name: 'field3',
    tag: 3,
    type: message([{ name: 'field1', tag: 1, type: 'uint32' }]),
  },
  { name: 'field5', tag: 5, type: 'uint32' },
  { name: 'field6', tag: 6, type: 'uint32' },
]);

export interface SetGroupAvatarParams {
  /** 群号。 */
  groupId: number;
  /** 自己账号 uin（highway 帧头要带）。 */
  uin: string | number;
  /** 头像图片：本地路径，或已在内存里的字节。 */
  source: string | Uint8Array;
  /** 可选日志钩子（分块上传进度 / 服务端态度）。 */
  log?: (message: string) => void;
  /** 编排层在申请会话和开始上传前复核账号；不进入 wire。 */
  beforeSend?: () => void;
}

/** 读取头像字节（路径来源会剥掉 NT 本地路径前缀）。 */
async function readSource(source: string | Uint8Array): Promise<Uint8Array> {
  if (source instanceof Uint8Array) {
    if (source.length === 0) throw new Error('群头像图片为空');
    if (source.length > AVATAR_MAX_BYTES) throw new Error('头像图片不能超过 16 MiB');
    return source;
  }
  const path = cleanNtLocalPath(source);
  const stat = await fsp.stat(path);
  if (!stat.isFile() || stat.size > AVATAR_MAX_BYTES) throw new Error('头像文件无效或超过 16 MiB');
  const bytes = new Uint8Array(await fsp.readFile(path));
  if (bytes.length === 0) throw new Error(`群头像图片为空：${path}`);
  if (bytes.length > AVATAR_MAX_BYTES) throw new Error('头像图片不能超过 16 MiB');
  return bytes;
}

/** 编码 `GroupAvatarExtra`（独立出来方便单测逐字节核对）。 */
export function encodeGroupAvatarExtra(groupId: number): Uint8Array {
  return encode(GROUP_AVATAR_EXTRA, {
    type: 101,
    groupUin: requireUint32(groupId, 'groupId'),
    field3: { field1: 1 },
    field5: 3,
    field6: 1,
  });
}

/**
 * 上传并设置群头像。需要已登记的在线 QQ 会话（`HttpConn` + highway 都借它的凭据）。
 */
export async function setGroupAvatar(
  nt: TrpcNative,
  pid: number,
  params: SetGroupAvatarParams,
): Promise<void> {
  await uploadAvatar(
    nt,
    pid,
    params,
    GROUP_AVATAR_HIGHWAY_CMD,
    encodeGroupAvatarExtra(params.groupId),
  );
}

export type SetSelfAvatarParams = Omit<SetGroupAvatarParams, 'groupId'>;

export async function setSelfAvatar(
  nt: TrpcNative,
  pid: number,
  params: SetSelfAvatarParams,
): Promise<void> {
  await uploadAvatar(nt, pid, params, SELF_AVATAR_HIGHWAY_CMD, new Uint8Array());
}

async function uploadAvatar(
  nt: TrpcNative,
  pid: number,
  params: SetSelfAvatarParams,
  commandId: number,
  extend: Uint8Array,
): Promise<void> {
  requireUin(String(params.uin));
  const bytes = await readSource(params.source);
  const image = detectImageFormat(bytes);
  if (image.width <= 0 || image.height <= 0 || image.width > 16384 || image.height > 16384)
    throw new Error('无法识别头像图片或像素尺寸过大');
  const hashes = computeHashes(bytes);
  params.beforeSend?.();
  const session = await fetchHighwaySession(nt, pid);
  params.beforeSend?.();
  await uploadHighwayHttp({
    session,
    uin: String(params.uin),
    commandId,
    source: new BufferChunkSource(bytes),
    fileMd5: hashes.md5,
    extend,
    ...(params.log ? { log: params.log } : {}),
  });
}
