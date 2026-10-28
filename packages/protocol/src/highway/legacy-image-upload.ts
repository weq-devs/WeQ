/**
 * 老式图片上传（闪照用的通道）—— 两跳：
 *
 *   1. `LongConn.OffPicUp`（SSO 原始命令，body 是**纯 protobuf**，SSO 帧由 native 组）申请上传：
 *      回 `serviceTicket` 与**服务端签发的** `downloadPath`（`/uin-<编号>-<MD5 大写>`）；
 *   2. `PicUp.DataUp`（highway，appId=16 / cmdId=1）把整张图 PUT 上去；
 *   3. 把两跳结果拼成构造 `flashPhoto` 元素所需的图片记录。
 *
 * 与 `./media-upload` 的 NTV2 管线**完全不是一回事**：
 *
 * | | NTV2（普通图/语音/视频） | 老式（本文件） |
 * | --- | --- | --- |
 * | 申请 | `0xE37_100` OIDB，回 uKey / msgInfo | `LongConn.OffPicUp`，回 ticket / downloadPath |
 * | highway appId | 1600001604 | **16** |
 * | highway commandId | 1003/1004… | **1** |
 * | `bytesReqExtendInfo` | NTV2RichMediaHighwayExt | **空** |
 * | 产物 | `commonElem{48}.pbElem` | 老式 `NotOnlineImage` 记录 |
 *
 * 抓包：`qqhook-20261028-051613.txt` + `v6.htdata.qq.com_2026_10_28_05_14_53.har`
 * （2026-10-28，私聊发一张 1080×505 的闪照）。帧头逐字段解出来是：
 *
 *   msgBaseHead { version:1, uin, command:'PicUp.DataUp', seq:1, retryTimes:0,
 *                 appId:16, dataFlag:16, commandId:1 }
 *   msgSegHead  { serviceId:0, filesize:61296, dataOffset:0, dataLength:61296,
 *                 serviceTicket:<336B，即 OffPicUp 响应 field9>, md5:<整个文件>,
 *                 fileMd5:<整个文件>, cacheAddr:0, cachePort:0 }
 *   bytesReqExtendInfo: 空
 *   msgLoginSigHead { loginSigType:8, appId:16 }
 *
 * 响应 `errorCode=0` 即成功（body 为空）。
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { cleanNtLocalPath } from '../oidb/shared';
import { decode, encode } from '../protobuf';
import { sendPacket } from '../transport';
import { computeHashes } from './hash-file';
import { BufferChunkSource, fetchHighwaySession, uploadHighwayHttp } from './highway-client';
import { detectImageFormat } from './image-format';
import type { MediaNative } from './ntv2-upload';
import { OFF_PIC_UP_CMD, OFF_PIC_UP_REQ, OFF_PIC_UP_RESP } from './offpic-schemas';

/** 老式图片通道的 highway appId（抓包实测，与 NTV2 的 1600001604 不同）。 */
export const LEGACY_IMAGE_HIGHWAY_APP_ID = 16;
/** 老式图片通道的 highway commandId。 */
export const LEGACY_IMAGE_HIGHWAY_CMD = 1;

/** 老式图片上传的来源：本地路径或内存字节。 */
export type LegacyImageSource = string | Uint8Array;

export interface LegacyImageUploadParams {
  /** 自己账号的 uin（OffPicUp 请求与 highway 帧头都要带）。 */
  uin: string | number;
  /** 自己 uid（OffPicUp 请求 field 25；抓包是发信人自己的 uid）。 */
  selfUid: string;
  source: LegacyImageSource;
  /** 日志钩子（上传链路排查用）。 */
  log?: (message: string) => void;
}

/** 老式图片上传的产物 —— 恰好是 `SendFlashPhotoPic` 需要的那些字段。 */
export interface LegacyImageUploadResult {
  fileName: string;
  fileSize: number;
  /** 32 位小写 hex md5。 */
  md5Hex: string;
  /**
   * 秒传命中：`OffPicUp` 回了服务端签发的路径，但**没有 serviceTicket**。
   *
   * 语义与 NTV2 那边「响应里没有 uKey」完全一致 —— 服务端已经按 md5 持有这张图，
   * 不必再走 `PicUp.DataUp` 传一遍字节。此时 `uploadLegacyImage` 会跳过第二跳，
   * 但产物（downloadPath / 元素字节）与真传一次**完全一样**。
   */
  fastUpload: boolean;
  /** 服务端签发的路径（`NotOnlineImage.downloadPath` / `resId`）。 */
  downloadPath: string;
  /**
   * `pbRes.md5Str`(31)。
   *
   * ⚠️ 这个值**两跳响应里都没有**，本地也推不出来（不是文件 md5、不是它的各种再哈希、
   * 也不是响应里的 field27）。抓包（2026-10-28）里它既不在 OffPicUp 响应、也不在
   * highway 回帧里，只出现在最终的 `PbSendMsg` 元素上 —— 所以目前只能先退回文件 md5
   * 大写；它能不能被收端忽略未验证。
   */
  md5Str: string;
  /** 图片格式码（1000 jpg / 1001 png …）。 */
  imgType: number;
  /** 像素宽。 */
  width: number;
  /** 像素高。 */
  height: number;
}

/** 图片格式码 → 文件扩展名。 */
const LEGACY_EXT_BY_FORMAT: Record<number, string> = {
  1000: '.jpg',
  1001: '.png',
  1002: '.webp',
  1005: '.bmp',
  2000: '.gif',
};

/**
 * 去掉 4 字节长度前缀（读回包时的防御）。
 *
 * ⚠️ **发包时不要自己加这个前缀**：原生层 `send_packet` 会自己组 SSO 帧
 * （`nt_helper` 的 `sso/client.rs: build_outgoing`），body 交纯 protobuf 就行。
 *
 * 抓包里看到的 `00 00 00 80 | body` 是 native **组好之后**的完整包 —— 钩子挂在
 * Socket 层，所以录到的是带帧的形态。早先误以为应用层要自己补，于是在 body 前面
 * 多写了 4 字节；服务端把它当成畸形 protobuf，直接不回包，30s 后报
 * `sso_request_outcome_unknown_timeout`。真机实测（2026-10-28）：
 * 带前缀 100% 超时，去掉后稳定 500~600ms 回 515 字节。
 *
 * 这个函数只用来兼容「有人把抓包整帧贴进来」的场景。
 */
export function stripLengthPrefix(reply: Uint8Array): Uint8Array {
  if (reply.length < 4) return reply;
  const declared = new DataView(reply.buffer, reply.byteOffset, 4).getUint32(0, false);
  if (declared === reply.length) return reply.subarray(4);
  return reply;
}

async function readSource(source: LegacyImageSource): Promise<Uint8Array> {
  if (typeof source === 'string') {
    const filePath = cleanNtLocalPath(source);
    if (!filePath) throw new Error('闪照图片来源不能是空路径');
    const bytes = new Uint8Array(await fsp.readFile(filePath));
    if (bytes.length === 0) throw new Error(`闪照图片文件是空的: ${filePath}`);
    return bytes;
  }
  if (!(source instanceof Uint8Array)) throw new Error('闪照图片来源必须是文件路径或 Uint8Array');
  if (source.length === 0) throw new Error('闪照图片字节是空的');
  return source;
}

/**
 * 第一跳：`LongConn.OffPicUp` —— 申请上传，拿 ticket 与服务端签发的路径。
 *
 * 请求体的常量（1 / 3 / 2 / 8 / 0 / 8 / 0 / 1000 / 0）全部照抄抓包，
 * 没有改动余量 —— 它们是客户端版本/终端类型这类「服务端会校验」的标记。
 *
 * **秒传**：响应里可能**没有** `serviceTicket`（实测 `field1=1 field4=1`，body 里只有
 * `downloadPath` / `resId`）。那说明服务端已按 md5 持有这张图，第二跳可以整段跳过 ——
 * 与 NTV2 用「响应里没有 uKey」判定秒传是同一个语义。此时 `serviceTicket` 返回空数组。
 */
export async function requestOffPicUpload(
  nt: MediaNative,
  pid: number,
  params: {
    uin: string | number;
    selfUid: string;
    md5: Uint8Array;
    fileSize: number;
    fileName: string;
    width: number;
    height: number;
    imgType: number;
  },
): Promise<{
  /** 空数组 = 秒传命中，不需要第二跳。 */
  serviceTicket: Uint8Array;
  downloadPath: string;
  resId: string;
  fileId: number;
}> {
  const body = encode(OFF_PIC_UP_REQ, {
    field1: 1,
    body: {
      uin: Number(params.uin),
      field3: 1,
      picMd5: params.md5,
      fileSize: params.fileSize,
      fileName: params.fileName,
      field7: 2,
      field8: 8,
      field10: 0,
      field12: 8,
      field13: 0,
      width: params.width,
      height: params.height,
      imgType: params.imgType,
      field22: 0,
      selfUid: params.selfUid,
    },
    field10: 3,
  });

  // 抓包里 `LongConn.OffPicUp` 不带 tag 24（不签名）。
  // body 直接给纯 protobuf —— SSO 帧（含长度前缀）由 native 自己组，不要自己加。
  const reply = await sendPacket(nt, pid, OFF_PIC_UP_CMD, body, false);
  const resp = decode(OFF_PIC_UP_RESP, stripLengthPrefix(reply)) as {
    field1?: number;
    body?: {
      serviceTicket?: Uint8Array;
      downloadPath?: string;
      resId?: string;
      fileId?: number;
    };
    field4?: number;
  };
  const inner = resp.body;
  // 路径必须签发：没有它就拼不出闪照元素（不管是不是秒传）。
  const downloadPath = (inner?.downloadPath ?? '').trim();
  if (!downloadPath) {
    throw new Error(
      `OffPicUp 响应缺少 downloadPath（服务端未签发图片路径；field1=${resp.field1} field4=${resp.field4}）`,
    );
  }
  return {
    // 没有 ticket = 秒传命中，交给调用方跳过第二跳。
    serviceTicket: inner?.serviceTicket ?? new Uint8Array(0),
    downloadPath,
    resId: (inner?.resId ?? '').trim() || downloadPath,
    fileId: inner?.fileId ?? 0,
  };
}

/**
 * 把一张本地图片传进老式图片通道，产出构造 `flashPhoto` 元素所需的图片记录。
 *
 * 两步都是真联网：`OffPicUp` 申请 → highway `PicUp.DataUp` 传字节。
 */
export async function uploadLegacyImage(
  nt: MediaNative,
  pid: number,
  params: LegacyImageUploadParams,
): Promise<LegacyImageUploadResult> {
  const bytes = await readSource(params.source);
  const hashes = computeHashes(bytes);
  const detected = detectImageFormat(bytes);
  const imgType = detected.width > 0 ? detected.format : 1000;
  const md5Upper = hashes.md5Hex.toUpperCase();
  const fileName = `${md5Upper}${LEGACY_EXT_BY_FORMAT[imgType] ?? '.jpg'}`;

  const ticket = await requestOffPicUpload(nt, pid, {
    uin: params.uin,
    selfUid: params.selfUid,
    md5: hashes.md5,
    fileSize: bytes.length,
    fileName,
    width: detected.width,
    height: detected.height,
    imgType,
  });
  // 没有 ticket = 秒传：服务端已按 md5 持有这张图，第二跳整段跳过。
  const fastUpload = ticket.serviceTicket.length === 0;
  params.log?.(
    fastUpload
      ? `OffPicUp 秒传命中: ${ticket.downloadPath}（服务端已有同 md5 资源，未上传字节）`
      : `OffPicUp 已签发: ${ticket.downloadPath}（fileId=${ticket.fileId}，ticket=${ticket.serviceTicket.length}B）`,
  );

  if (!fastUpload) {
    // highway 会话仍然走 `HttpConn.0x6ff_501`，但 serviceTicket 用 OffPicUp 签发的那份
    // （不是会话里的 sig_session —— 抓包实测如此）。
    const session = await fetchHighwaySession(nt, pid);
    await uploadHighwayHttp({
      session: { ...session, sigSession: ticket.serviceTicket },
      uin: String(params.uin),
      commandId: LEGACY_IMAGE_HIGHWAY_CMD,
      source: new BufferChunkSource(bytes),
      fileMd5: hashes.md5,
      // 抓包里这一格是空的，不是 NTV2 那套 extend。
      extend: new Uint8Array(0),
      appId: LEGACY_IMAGE_HIGHWAY_APP_ID,
      seq: 1,
      ...(params.log ? { log: params.log } : {}),
    });

    params.log?.(
      `老式图片已上传: ${fileName} (${bytes.length}B, md5=${hashes.md5Hex}, ` +
        `cmdId=${LEGACY_IMAGE_HIGHWAY_CMD})`,
    );
  }

  return {
    fileName,
    fileSize: bytes.length,
    md5Hex: hashes.md5Hex,
    fastUpload,
    downloadPath: ticket.downloadPath,
    // 两跳响应里都没有 md5Str，先退回文件 md5 大写（见类型注释里的说明）。
    md5Str: md5Upper,
    imgType,
    width: detected.width,
    height: detected.height,
  };
}

/** 老式图片通道的常量（避免各处写死 16 / 1）。 */
export const LEGACY_IMAGE_CHANNEL = {
  appId: LEGACY_IMAGE_HIGHWAY_APP_ID,
  commandId: LEGACY_IMAGE_HIGHWAY_CMD,
} as const;

/** 供调用方复用的 md5 工具（与 highway 其它模块同一实现）。 */
export function md5OfBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('md5').update(Buffer.from(bytes)).digest());
}
