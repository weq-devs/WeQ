// 收藏表情（custom face / Faceroam）。
//
// 三条通道，别混：
//   - **Faceroam.OpReq**（trpc）：列表 / 删除
//   - **OIDB**：0x902E_1（详情、改备注、排序上传）、0x902F_1（移动指令）
//   - **ImgStore.BDHExpressionRoam + highway**：新增
//
// 搬运自 SnowLuma `oidb-services/custom-face/*`。
//
// 签名：
//   - `Faceroam.OpReq` / `ImgStore.BDHExpressionRoam` 不在 LagrangeV2 白名单 → 不签
//   - 0x902e_1 在名单 → 签
//   - 0x902f_1 不在名单 → 不签
//
// emojiId 形如 `<uin>_0_0_0_<MD5 大写 hex>_0_0`，来自列表接口；不要自己拼。

import { createHash } from 'node:crypto';
import { decode, encode, message } from '../../protobuf';
import { invokeOidb, invokeTrpc, type OidbSpec, type TrpcSpec } from '../invoke';
import { bytesToHex, toInt } from '../shared';
import {
  fetchHighwaySession,
  packHighwayFrame,
  unpackHighwayFrame,
  type HighwaySession,
} from '../../highway/highway-client';
import { RESP_DATA_HIGHWAY_HEAD } from '../../highway/ntv2-schemas';
import type { OidbNative, TrpcNative } from '../../transport';

/** Faceroam 客户端环境常量（抓包值；服务端对版本号不敏感）。 */
const FACEROAM_OS_VERSION = '10.0.26200';
const FACEROAM_QQ_VERSION = '9.9.28-46928';
const FACEROAM_CMD = 'Faceroam.OpReq';

function selfUinText(uin: number | string): string {
  const text = String(uin ?? '').trim();
  if (!/^\d+$/.test(text) || text === '0') {
    throw new Error(`selfUin 必须是正整数字符串，收到 ${text}`);
  }
  return text;
}

// ───────────────────────── Faceroam：列表 / 删除 ─────────────────────────

const FACEROAM_INNER = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'osVersion', tag: 2, type: 'string' },
  { name: 'qqVersion', tag: 3, type: 'string' },
]);
const FACEROAM_BODY = message([{ name: 'emojiId', tag: 1, type: 'string' }]);
const FACEROAM_REQ = message([
  { name: 'inner', tag: 1, type: FACEROAM_INNER },
  { name: 'uin', tag: 2, type: 'uint64' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'body', tag: 5, type: FACEROAM_BODY },
  { name: 'field6', tag: 6, type: 'uint32' },
]);
const FACEROAM_ITEM = message([
  { name: 'faceIds', tag: 1, type: 'string', repeated: true },
  { name: 'category', tag: 3, type: 'string' },
  { name: 'totalCount', tag: 4, type: 'uint32' },
]);
const FACEROAM_RESP = message([
  { name: 'retCode', tag: 1, type: 'uint32' },
  { name: 'message', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'item', tag: 4, type: FACEROAM_ITEM },
]);

function faceroamInner(withQqVersion: boolean): Record<string, unknown> {
  return {
    field1: 1,
    osVersion: FACEROAM_OS_VERSION,
    ...(withQqVersion ? { qqVersion: FACEROAM_QQ_VERSION } : {}),
  };
}

function assertFaceRetCode(what: string, body: Record<string, unknown>): void {
  const retCode = toInt(body.retCode);
  if (retCode !== 0) {
    const msg = typeof body.message === 'string' ? body.message : '';
    throw new Error(`${what}失败：code=${retCode}${msg ? ` ${msg}` : ''}`);
  }
}

export interface FetchCustomFaceListParams {
  selfUin: number | string;
}

export namespace FetchCustomFaceList {
  export const cmd = FACEROAM_CMD;
  export const reqSchema = FACEROAM_REQ;
  export const respSchema = FACEROAM_RESP;

  export type Params = FetchCustomFaceListParams;

  export const serialize = (p: Params): Record<string, unknown> => ({
    inner: faceroamInner(true),
    uin: BigInt(selfUinText(p.selfUin)),
    field3: 1,
    field6: 1,
  });

  export const deserialize = (body: Record<string, unknown>): string[] => {
    assertFaceRetCode('拉取收藏表情', body);
    const item = (body.item ?? {}) as Record<string, unknown>;
    return (item.faceIds as string[] | undefined) ?? [];
  };

  export const invoke = (nt: TrpcNative, pid: number, params: Params): Promise<string[]> =>
    invokeTrpc(nt, pid, FetchCustomFaceList as TrpcSpec<Params, string[]>, params);
}

export interface DeleteCustomFaceParams {
  selfUin: number | string;
  emojiId: string;
}

export namespace DeleteCustomFace {
  export const cmd = FACEROAM_CMD;
  export const reqSchema = FACEROAM_REQ;
  export const respSchema = FACEROAM_RESP;

  export type Params = DeleteCustomFaceParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const emojiId = String(p.emojiId ?? '').trim();
    if (!emojiId) throw new Error('emojiId 不能为空');
    return {
      // 删除的 inner 不带 qqVersion（抓包里少 14 字节）。
      inner: faceroamInner(false),
      uin: BigInt(selfUinText(p.selfUin)),
      field3: 2,
      body: { emojiId },
    };
  };

  export const deserialize = (body: Record<string, unknown>): void =>
    assertFaceRetCode('删除收藏表情', body);

  export const invoke = (nt: TrpcNative, pid: number, params: Params): Promise<void> =>
    invokeTrpc(nt, pid, DeleteCustomFace as TrpcSpec<Params, void>, params);
}

// ───────────────────────── 0x902E_1：详情 / 改备注 / 排序上传 ─────────────────────────

const FACE_EMOJI = message([
  { name: 'emojiId', tag: 1, type: 'string' },
  { name: 'md5', tag: 2, type: 'string' },
]);

const DETAIL_REQ = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'osVersion', tag: 2, type: 'string' },
  { name: 'opType', tag: 3, type: 'uint32' },
  { name: 'emojis', tag: 4, type: FACE_EMOJI, repeated: true },
]);

const MODIFY_ENTRY = message([
  { name: 'emoji', tag: 1, type: FACE_EMOJI },
  { name: 'desc', tag: 2, type: 'string', force: true },
]);
const MODIFY_REQ = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'osVersion', tag: 2, type: 'string' },
  { name: 'opType', tag: 3, type: 'uint32' },
  { name: 'entry', tag: 5, type: MODIFY_ENTRY },
  { name: 'field12', tag: 12, type: 'uint32' },
]);

const MOVE_REQ = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'osVersion', tag: 2, type: 'string' },
  { name: 'opType', tag: 3, type: 'uint32' },
  { name: 'emojis', tag: 4, type: FACE_EMOJI, repeated: true },
]);

const CUSTOM_FACE_RESP_ENTRY = message([
  { name: 'emoji', tag: 1, type: FACE_EMOJI },
  { name: 'legacyDesc', tag: 2, type: 'string' },
  { name: 'desc', tag: 3, type: 'string' },
]);
const CUSTOM_FACE_RESP = message([
  { name: 'retCode', tag: 1, type: 'uint32' },
  { name: 'errMsg', tag: 2, type: 'string' },
  { name: 'opType', tag: 3, type: 'uint32' },
  { name: 'entries', tag: 4, type: CUSTOM_FACE_RESP_ENTRY, repeated: true },
]);

const ORDER_ENV = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'osVersion', tag: 2, type: 'string' },
  { name: 'buildVersion', tag: 3, type: 'string' },
]);
const ORDER_REQ = message([
  { name: 'env', tag: 1, type: ORDER_ENV },
  { name: 'emojiId', tag: 2, type: 'string' },
  { name: 'position', tag: 3, type: 'uint32' },
]);

export interface CustomFaceRef {
  emojiId: string;
  /** emojiId 中段的大写 hex md5。 */
  md5: string;
}

export interface FetchCustomFaceDetailParams {
  emojis: CustomFaceRef[];
}

export interface CustomFaceDetail {
  emojiId: string;
  desc: string;
}

function assertOidbRetCode(what: string, body: Record<string, unknown>): void {
  const retCode = toInt(body.retCode);
  if (retCode !== 0) {
    const msg = typeof body.errMsg === 'string' ? body.errMsg : '';
    throw new Error(`${what}失败：code=${retCode}${msg ? ` ${msg}` : ''}`);
  }
}

export namespace FetchCustomFaceDetail {
  export const command = 0x902e;
  export const subCommand = 1;
  export const uinForm = true;
  export const reqSchema = DETAIL_REQ;
  export const respSchema = CUSTOM_FACE_RESP;

  export type Params = FetchCustomFaceDetailParams;

  export const serialize = (p: Params): Record<string, unknown> => ({
    field1: 1,
    osVersion: FACEROAM_OS_VERSION,
    opType: 2,
    emojis: p.emojis.map((e) => ({ emojiId: e.emojiId, md5: e.md5 })),
  });

  export const deserialize = (body: Record<string, unknown>): CustomFaceDetail[] => {
    assertOidbRetCode('拉取收藏表情详情', body);
    const seen = new Set<string>();
    return ((body.entries as Record<string, unknown>[] | undefined) ?? []).map((entry, index) => {
      const emoji = (entry.emoji ?? {}) as Record<string, unknown>;
      const emojiId = typeof emoji.emojiId === 'string' ? emoji.emojiId : '';
      if (!emojiId) throw new Error(`收藏表情详情第 ${index} 项缺少 emojiId`);
      if (seen.has(emojiId)) throw new Error(`收藏表情详情出现重复 emojiId：${emojiId}`);
      seen.add(emojiId);
      // 新版本在 tag 3，老版本在 tag 2。
      const desc =
        (typeof entry.desc === 'string' && entry.desc) ||
        (typeof entry.legacyDesc === 'string' ? entry.legacyDesc : '');
      return { emojiId, desc };
    });
  };

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: Params,
  ): Promise<CustomFaceDetail[]> =>
    invokeOidb(nt, pid, FetchCustomFaceDetail as OidbSpec<Params, CustomFaceDetail[]>, params);
}

export interface ModifyCustomFaceParams extends CustomFaceRef {
  /** 新备注；空串 = 清空备注。 */
  desc: string;
}

export namespace ModifyCustomFace {
  export const command = 0x902e;
  export const subCommand = 1;
  export const reqSchema = MODIFY_REQ;
  export const respSchema = CUSTOM_FACE_RESP;

  export type Params = ModifyCustomFaceParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!p.emojiId.trim()) throw new Error('emojiId 不能为空');
    return {
      field1: 1,
      osVersion: FACEROAM_OS_VERSION,
      opType: 3,
      entry: { emoji: { emojiId: p.emojiId, md5: p.md5 }, desc: p.desc },
      field12: 1,
    };
  };

  export const deserialize = (body: Record<string, unknown>): void =>
    assertOidbRetCode('修改收藏表情备注', body);

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, ModifyCustomFace as OidbSpec<Params, void>, params);
}

export interface MoveCustomFaceParams {
  /** 完整且有序的列表，整表上传。 */
  emojis: CustomFaceRef[];
}

/** move 第 2 步：上传新顺序。必须先发 {@link OrderCustomFace}。 */
export namespace MoveCustomFace {
  export const command = 0x902e;
  export const subCommand = 1;
  export const uinForm = true;
  export const reqSchema = MOVE_REQ;
  export const respSchema = CUSTOM_FACE_RESP;

  export type Params = MoveCustomFaceParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!p.emojis.length) throw new Error('emojis 不能为空');
    return {
      field1: 1,
      osVersion: FACEROAM_OS_VERSION,
      opType: 2,
      emojis: p.emojis.map((e) => ({ emojiId: e.emojiId, md5: e.md5 })),
    };
  };

  export const deserialize = (body: Record<string, unknown>): void =>
    assertOidbRetCode('收藏表情排序上传', body);

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, MoveCustomFace as OidbSpec<Params, void>, params);
}

export interface OrderCustomFaceParams {
  emojiId: string;
  /** 目标位置，从 1 开始；1 = 最前。 */
  position: number;
}

/** move 第 1 步：移动指令。单发不生效，必须再发 {@link MoveCustomFace}。 */
export namespace OrderCustomFace {
  export const command = 0x902f;
  export const subCommand = 1;
  export const uinForm = true;
  export const reqSchema = ORDER_REQ;
  export const respSchema = CUSTOM_FACE_RESP;

  export type Params = OrderCustomFaceParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!p.emojiId.trim()) throw new Error('emojiId 不能为空');
    if (!Number.isSafeInteger(p.position) || p.position <= 0) {
      throw new Error(`position 必须是正整数，收到 ${String(p.position)}`);
    }
    return {
      env: { field1: 1024, osVersion: FACEROAM_OS_VERSION, buildVersion: '9.9.26' },
      emojiId: p.emojiId,
      position: p.position,
    };
  };

  export const deserialize = (body: Record<string, unknown>): void =>
    assertOidbRetCode('收藏表情移动', body);

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, OrderCustomFace as OidbSpec<Params, void>, params);
}

// ───────────────────────── 新增收藏表情：BDHExpressionRoam + highway ─────────────────────────

const BDH_CMD = 'ImgStore.BDHExpressionRoam';

const BDH_INNER = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'uin', tag: 2, type: 'uint64' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'md5', tag: 4, type: 'bytes' },
  { name: 'filesize', tag: 5, type: 'uint32' },
  { name: 'field7', tag: 7, type: 'uint32' },
  { name: 'field8', tag: 8, type: 'uint32' },
  { name: 'field9', tag: 9, type: 'uint32' },
  { name: 'ver', tag: 13, type: 'string' },
  { name: 'field16', tag: 16, type: 'uint32' },
]);
const BDH_TAIL_INNER = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'string' },
]);
const BDH_TAIL = message([
  { name: 'inner', tag: 1, type: BDH_TAIL_INNER },
  { name: 'field2', tag: 2, type: 'uint32' },
]);
const BDH_REQ = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'inner', tag: 3, type: BDH_INNER },
  { name: 'field7', tag: 7, type: 'uint32' },
  { name: 'tail', tag: 1001, type: BDH_TAIL },
]);
const BDH_RESP_INNER = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'bytes' },
  { name: 'field4', tag: 4, type: 'uint32' },
  { name: 'field6', tag: 6, type: 'uint32', repeated: true },
  { name: 'field7', tag: 7, type: 'uint32', repeated: true },
  { name: 'token', tag: 8, type: 'bytes' },
  { name: 'field12', tag: 12, type: 'uint32' },
]);
const BDH_RESP = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'inner', tag: 3, type: BDH_RESP_INNER },
]);

/** 收藏表情 highway 上传用的 head（commandId=9，serviceTicket 是 BDH token）。 */
const FAV_EMOJI_BASE_HEAD = message([
  { name: 'version', tag: 1, type: 'uint32' },
  { name: 'uin', tag: 2, type: 'string' },
  { name: 'command', tag: 3, type: 'string' },
  { name: 'seq', tag: 4, type: 'uint32' },
  { name: 'retryTimes', tag: 5, type: 'uint32' },
  { name: 'filesize', tag: 6, type: 'uint64' },
  { name: 'dataFlag', tag: 7, type: 'uint32' },
  { name: 'commandId', tag: 8, type: 'uint32' },
]);
const FAV_EMOJI_SEG_HEAD = message([
  { name: 'serviceId', tag: 1, type: 'uint32' },
  { name: 'filesize', tag: 2, type: 'uint64' },
  { name: 'dataOffset', tag: 3, type: 'uint64' },
  { name: 'dataLength', tag: 4, type: 'uint64' },
  { name: 'serviceTicket', tag: 6, type: 'bytes' },
  { name: 'md5', tag: 8, type: 'bytes' },
  { name: 'fileMd5', tag: 9, type: 'bytes' },
]);
const FAV_EMOJI_ID_WRAP = message([{ name: 'emojiId', tag: 1, type: 'string' }]);
const FAV_EMOJI_HEAD = message([
  { name: 'baseHead', tag: 1, type: FAV_EMOJI_BASE_HEAD },
  { name: 'segHead', tag: 2, type: FAV_EMOJI_SEG_HEAD },
  { name: 'emojiIdWrap', tag: 3, type: FAV_EMOJI_ID_WRAP },
  { name: 'field4', tag: 4, type: 'uint32' },
  { name: 'field8', tag: 8, type: 'uint32' },
]);

/** 收藏表情的 highway 命令号。 */
const FAV_EMOJI_HIGHWAY_CMD = 9;

export interface AddCustomFaceParams {
  selfUin: number | string;
  /** 图片字节。 */
  imageBytes: Uint8Array;
  /** 可选日志钩子。 */
  log?: (message: string) => void;
  beforeSend?: () => void;
}

function createMd5(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('md5').update(Buffer.from(bytes)).digest());
}

/** emojiId 由 `<uin>_0_0_0_<MD5 大写 hex>_0_0` 构成，上传成功后返回。 */
export function customFaceId(selfUin: number | string, md5: Uint8Array): string {
  return `${selfUinText(selfUin)}_0_0_0_${bytesToHex(md5).toUpperCase()}_0_0`;
}

/**
 * 把列表接口返回的 emojiId 拆成 `{ emojiId, md5 }`，供详情 / 改备注 / 排序使用。
 *
 * 格式：`<uin>_0_0_0_<MD5 大写 hex>_0_0`。格式不符时抛错，避免把脏值发到服务端。
 */
export function parseCustomFaceId(emojiId: string): { emojiId: string; md5: string } {
  const text = String(emojiId ?? '').trim();
  const parts = text.split('_');
  if (parts.length < 5) throw new Error(`收藏表情 id 格式非法：${text}`);
  const md5 = parts[4] ?? '';
  if (!/^[0-9A-Fa-f]{32}$/.test(md5)) {
    throw new Error(`收藏表情 id 里的 md5 非法：${text}`);
  }
  return { emojiId: text, md5: md5.toUpperCase() };
}

/**
 * 收藏表情走一次性的单帧 HTTP POST（图片通常 < 1 MiB）。
 *
 * 响应是 highway 帧，`RespDataHighwayHead.errorCode` 非 0 才代表服务端拒绝。
 */
async function uploadFavEmojiFrame(
  session: HighwaySession,
  uin: string,
  head: Uint8Array,
  body: Uint8Array,
  log?: (message: string) => void,
): Promise<void> {
  const frame = packHighwayFrame(head, body);
  const url = `http://${session.host}:${session.port}/cgi-bin/httpconn?htcmd=0x6FF0087&uin=${uin}`;
  log?.(`收藏表情 highway 上传：${session.host}:${session.port}`);
  const response = await fetch(url, {
    method: 'POST',
    // 重新包一层让 TS 推断出 `Uint8Array<ArrayBuffer>`：DOM 的 BodyInit 不接受 ArrayBufferLike 泛型。
    body: new Uint8Array(frame),
    headers: {
      Accept: '*/*',
      Connection: 'Keep-Alive',
      'User-Agent': 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2)',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });
  if (!response.ok) {
    throw new Error(`收藏表情 highway 上传失败：HTTP ${response.status}`);
  }
  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw.length === 0) return;
  const { head: respHead } = unpackHighwayFrame(raw);
  const parsed = decode(RESP_DATA_HIGHWAY_HEAD, respHead);
  const errorCode = toInt(parsed.errorCode);
  if (errorCode !== 0) {
    throw new Error(`收藏表情 highway 上传被拒：errorCode=${errorCode}`);
  }
}

/**
 * 添加一张收藏表情。
 *
 * 流程：`ImgStore.BDHExpressionRoam` 申请 token → 用该 token 当 highway
 * `serviceTicket` 上传图片（`cmdId=9`）→ 返回 emojiId。
 */
export namespace AddCustomFace {
  export const cmd = BDH_CMD;

  export type Params = AddCustomFaceParams;

  export const invoke = async (nt: TrpcNative, pid: number, params: Params): Promise<string> => {
    const log = params.log;
    if (!(params.imageBytes instanceof Uint8Array) || params.imageBytes.length === 0) {
      throw new Error('图片字节不能为空');
    }
    const uin = selfUinText(params.selfUin);
    const md5 = createMd5(params.imageBytes);
    const emojiId = customFaceId(uin, md5);

    // 1. 拿 highway 节点。
    const session = await fetchHighwaySession(nt, pid);
    params.beforeSend?.();

    // 2. 申请上传 token。
    const reqBytes = encode(BDH_REQ, {
      field1: 3,
      field2: 1,
      inner: {
        field1: 0,
        uin: BigInt(uin),
        field3: 0,
        md5,
        filesize: params.imageBytes.length,
        field7: 2,
        field8: 0,
        field9: 1,
        ver: '1.0.0',
        field16: 1,
      },
      field7: 9,
      tail: { inner: { field1: 0, field2: 0, field3: '0' }, field2: 1 },
    });
    const raw = await nt.sendPacket(pid, BDH_CMD, Buffer.from(reqBytes), false);
    const resp = decode(BDH_RESP, new Uint8Array(raw));
    params.beforeSend?.();
    const inner = (resp.inner ?? {}) as Record<string, unknown>;
    const token = inner.token;
    if (!(token instanceof Uint8Array) || token.length === 0) {
      throw new Error('BDHExpressionRoam 响应缺少上传 token（f8）');
    }

    // 3. highway 上传（head 的 serviceTicket 用 BDH token，不是 sigSession）。
    const head = encode(FAV_EMOJI_HEAD, {
      baseHead: {
        version: 1,
        uin,
        command: 'PicUp.DataUp',
        seq: 1,
        retryTimes: 0,
        filesize: BigInt(params.imageBytes.length),
        dataFlag: 16,
        commandId: FAV_EMOJI_HIGHWAY_CMD,
      },
      segHead: {
        serviceId: 0,
        filesize: BigInt(params.imageBytes.length),
        dataOffset: 0n,
        dataLength: BigInt(params.imageBytes.length),
        serviceTicket: token,
        md5,
        fileMd5: md5,
      },
      emojiIdWrap: { emojiId },
      field4: 0,
      field8: 9,
    });
    await uploadFavEmojiFrame(session, uin, head, params.imageBytes, log);
    log?.(`收藏表情上传完成：${emojiId}`);
    return emojiId;
  };
}
