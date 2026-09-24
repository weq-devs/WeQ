/**
 * NTV2 富媒体上传编排 —— 图片 / 语音 / 视频共用一条流水线：
 *
 *   1. 发 0xE37_100（`OidbSvcTrpcTcp.0x11c4_100` 等）申请上传：带 fileInfo（尺寸 + md5 +
 *      sha1 + 类型）+ extBizInfo（场景/文案），拿回 uKey、上传节点 ipv4s、msgInfo；
 *   2. 服务端没命中 fast-upload（uKey 非空）时，对每个子文件走 highway TCP PUT
 *      （见 `./highway-client`）；视频是两个子文件（正文 + 封面）；
 *   3. `finalizeMediaMsgInfo` 把响应里的 msgInfo 编成字节 —— 这份字节就是 outgoing
 *      `commonElem.pbElem`（serviceType=48），与本包收侧解码的
 *      `PIC_COMMON_PB`/`PTT_COMMON_PB`/`VIDEO_COMMON_PB` 同构。
 *
 * 对照 SnowLuma `highway/pipeline.ts` + `oidb-services/highway/ntv2-upload-request.ts`。
 * 这里省掉了它的 trace 埋点，保留：会话复用（视频两次 PUT 只申请一次会话）、
 * fast-upload 跳过、uKey 存在但没字节时抛 fastOnlyError。
 */

import { randomBytes } from 'node:crypto';
import { decode, encode } from '../protobuf';
import { sendOidb, type OidbNative, type TrpcNative } from '../transport';
import {
  BufferChunkSource,
  buildHighwayExtend,
  type ChunkSource,
  FileChunkSource,
  fetchHighwaySession,
  type HighwaySession,
  uploadHighwayHttp,
} from './highway-client';
import {
  NTV2_UPLOAD_REQ_TOP,
  NTV2_UPLOAD_RESP_TOP,
  type Ntv2UploadMsgInfo,
  type Ntv2UploadResp,
  UPLOAD_MSG_INFO,
} from './ntv2-schemas';

/** 上传需要的 native 能力：OIDB（申请上传）+ 原始 SSO 包（highway 会话）。 */
export type MediaNative = OidbNative & TrpcNative;

/** 上传请求里的一个 fileInfo 槽（`NTV2_UPLOAD_INFO`）。 */
export interface Ntv2UploadInfoInput {
  fileInfo: {
    fileSize: number;
    fileHash: string;
    fileSha1: string;
    fileName: string;
    type: { type: number; picFormat: number; videoFormat: number; voiceFormat: number };
    width: number;
    height: number;
    time: number;
    original: number;
  };
  subFileType: number;
}

/**
 * 一个子文件的上传说明。`source` 指向响应里 uKey/ipv4s 的位置：
 * `'top'` = 主文件，数字 = `upload.subFileInfos[n]`（视频封面用 0）。
 */
export interface MediaSubFileUpload {
  source: 'top' | number;
  /** highway 命令号（图片 1003/1004、语音 1007/1008、视频 1001/1005、封面 1002/1006）。 */
  cmdId: number;
  /** 内存字节（与 fileSource 二选一）。 */
  bytes?: Uint8Array;
  /** 磁盘流式来源（大视频用，避免整文件进内存）。 */
  fileSource?: { filePath: string; fileSize: number };
  md5: Uint8Array;
  /** sha1；视频主文件传 1 MiB 块中间态数组，其余传单个 digest。 */
  sha1: Uint8Array | Uint8Array[];
  /** `buildHighwayExtend` 的 fileIndex（视频封面传 1）。 */
  subFileIndex?: number;
  /** uKey 存在但本地没有字节时抛的错（转发/免流量场景）。 */
  fastOnlyError?: string;
}

export interface Ntv2UploadParams {
  /** 自己账号的 uin —— highway 帧头要带，调用方（service 层）手里有。 */
  uin: string | number;
  isGroup: boolean;
  /** 群聊传群号，私聊传对方 uid。 */
  targetIdOrUid: string | number;
  /** OIDB 命令号：图片 0x11C4(群)/0x11C5(私)、语音 0x126E/0x126D、视频 0x11EA/0x11E9。 */
  oidbCmd: number;
  /** `reqHead.common.requestId`：图片 1、视频 3、语音 群 1 / 私聊 4。 */
  requestId: number;
  /** `scene.businessType`：1 图片 / 2 视频 / 3 语音。 */
  businessType: number;
  uploadInfo: Ntv2UploadInfoInput[];
  /** 旧客户端兼容场景：群 2 / 私聊 1（视频固定 2）。 */
  compatQmsgSceneType: number;
  extBizInfo: Record<string, unknown>;
  uploads: MediaSubFileUpload[];
  label?: string;
  log?: (message: string) => void;
  /**
   * 覆盖 `upload.clientRandomId`。
   *
   * 私聊语音的 `ptt.bytesReserve` 里要嵌同一个随机数（安卓真机抓包：reserve 第 04 项 =
   * clientRandomId = 消息 random），所以调用方得先把随机数定下来、两边共用。
   */
  clientRandomId?: bigint;
}

/** 8 字节随机数掩成正 int64（signed int64 编码不会翻号）。 */
export function makeClientRandomId(): bigint {
  return randomBytes(8).readBigUInt64BE() & 0x7fffffffffffn;
}

/** 发一次 0xE37_100 上传申请，返回响应里的 `upload` 段。 */
async function requestUpload(
  nt: MediaNative,
  pid: number,
  params: Ntv2UploadParams,
): Promise<Ntv2UploadResp> {
  const label = params.label ?? 'media';
  const body = encode(NTV2_UPLOAD_REQ_TOP, {
    reqHead: {
      common: { requestId: params.requestId, command: 100 },
      scene: {
        requestType: 2,
        businessType: params.businessType,
        sceneType: params.isGroup ? 2 : 1,
        ...(params.isGroup
          ? { group: { groupUin: Number(params.targetIdOrUid) } }
          : { c2c: { accountType: 2, targetUid: String(params.targetIdOrUid) } }),
      },
      client: { agentType: 2 },
    },
    upload: {
      uploadInfo: params.uploadInfo,
      // true = 允许服务端走 fast-upload（资源已在服务器上时跳过字节上传）。
      tryFastUploadCompleted: true,
      clientRandomId: params.clientRandomId ?? makeClientRandomId(),
      compatQmsgSceneType: params.compatQmsgSceneType,
      extBizInfo: params.extBizInfo,
    },
  });

  const respBytes = await sendOidb(nt, pid, {
    command: params.oidbCmd,
    subCommand: 100,
    body,
    isUid: true,
  });
  const resp = decode(NTV2_UPLOAD_RESP_TOP, respBytes) as {
    respHead?: { retCode?: number; message?: string };
    upload?: Ntv2UploadResp;
  };
  const retCode = resp.respHead?.retCode ?? 0;
  if (retCode !== 0) {
    throw new Error(`${label} 上传被拒: retCode=${retCode} ${resp.respHead?.message ?? ''}`.trim());
  }
  const upload = resp.upload;
  if (!upload) throw new Error(`${label} 上传响应缺少 upload`);
  if (!upload.msgInfo) throw new Error(`${label} 上传响应缺少 msgInfo`);
  return upload;
}

/**
 * 申请上传 + 按需跑 highway PUT，返回响应 `upload` 段。
 * 会话在多个子文件之间复用（视频两次 PUT 只申请一次）。
 */
export async function runNtv2Upload(
  nt: MediaNative,
  pid: number,
  params: Ntv2UploadParams,
): Promise<Ntv2UploadResp> {
  const label = params.label ?? 'media';
  const log = params.log;
  const upload = await requestUpload(nt, pid, params);

  let session: HighwaySession | null = null;
  let didPut = false;
  for (const sub of params.uploads) {
    const target = sub.source === 'top' ? upload : upload.subFileInfos?.[sub.source];
    const uKey = target?.uKey ?? '';
    const size = sub.fileSource ? sub.fileSource.fileSize : (sub.bytes?.length ?? 0);

    // 没 uKey = 服务端已持有该资源（fast-upload 命中），不需要传字节。
    if (!uKey) {
      if (size > 0) {
        // 顺手把响应里 msgInfoBody 的 fileExist 记下来：秒传命中时「服务端自称有没有
        // 这份资源」是排查「发出去了但收端说已过期」的唯一线索。语义（尤其在某些
        // 历史版本里为 false 是否正常）未经验证，所以只记不报错。
        const exists = (upload.msgInfo?.msgInfoBody ?? []).map((body) => body.fileExist);
        log?.(
          `${label} fast-upload 命中（sub=${String(sub.source)}，未传字节；fileExist=${exists.length > 0 ? exists.map(String).join(',') : '未知'}）`,
        );
      }
      continue;
    }
    if (size === 0) {
      if (sub.fastOnlyError) throw new Error(sub.fastOnlyError);
      continue;
    }
    if (!target) continue;

    const extend = buildHighwayExtend(
      uKey,
      upload.msgInfo as Ntv2UploadMsgInfo,
      target.ipv4s ?? [],
      sub.sha1,
      sub.subFileIndex ?? 0,
    );
    // 先拿会话再开文件句柄，避免会话失败时泄漏已打开的文件。
    session ??= await fetchHighwaySession(nt, pid);
    const source: ChunkSource = sub.fileSource
      ? await FileChunkSource.open(sub.fileSource.filePath, sub.fileSource.fileSize)
      : new BufferChunkSource(sub.bytes ?? new Uint8Array(0));

    await uploadHighwayHttp({
      session,
      uin: String(params.uin),
      commandId: sub.cmdId,
      source,
      fileMd5: sub.md5,
      extend,
      log,
    });
    didPut = true;
  }
  if (!didPut) log?.(`${label} 全部子文件命中 fast-upload，无需上传字节`);
  return upload;
}

/**
 * msgInfo → outgoing `commonElem.pbElem` 字节。
 *
 * `pic` 缺省值只在图片上传时给（服务端有时不回 pic 的 bizType/textSummary，
 * 不补的话接收端文字摘要会空）；`pttWaveform` 是本地算好的波形字节（语音专用）。
 */
export function finalizeMediaMsgInfo(
  upload: Ntv2UploadResp,
  options: {
    /**
     * 图片用：服务端不回 pic 时补的默认值。除 `bizType`/`textSummary` 外，
     * 还可以带 `bytesPbReserveTroop` / `bytesPbReserveC2c`（图片必须，见
     * `media-upload.ts` 的注释）—— 缺哪个键就补哪个，服务端已经给了的以它为准。
     */
    pic?: Record<string, unknown>;
    pttWaveform?: Uint8Array;
  } = {},
): Uint8Array {
  const msgInfo = upload.msgInfo;
  if (!msgInfo) throw new Error('上传响应缺少 msgInfo');

  const msgInfoBody = (msgInfo.msgInfoBody ?? []).map((body) => ({
    index: body.index,
    picture: body.picture,
    fileExist: body.fileExist,
    hashSum: body.hashSum,
  }));

  const source = msgInfo.extBizInfo ?? {};
  const extBizInfo: Record<string, unknown> = {};
  const pic = source.pic as Record<string, unknown> | undefined;
  if (pic) {
    extBizInfo.pic = { ...pic };
    if (options.pic) {
      const target = extBizInfo.pic as Record<string, unknown>;
      for (const [key, value] of Object.entries(options.pic)) {
        target[key] = target[key] ?? value;
      }
    }
  } else if (options.pic) {
    extBizInfo.pic = { ...options.pic };
  }
  if (source.video) extBizInfo.video = source.video;
  const ptt = source.ptt as Record<string, unknown> | undefined;
  if (ptt || options.pttWaveform) {
    extBizInfo.ptt = {
      ...(ptt ?? {}),
      ...(options.pttWaveform ? { waveform: options.pttWaveform } : {}),
    };
  }
  if (source.busiType !== undefined) extBizInfo.busiType = source.busiType;

  return encode(UPLOAD_MSG_INFO, { msgInfoBody, extBizInfo });
}
