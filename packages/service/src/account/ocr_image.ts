/**
 * ChatImageOcrService — 聊天图片「文字识别」（OIDB 0xe07_0，见 `@weq/protocol` 的
 * `OcrImage`）。
 *
 * 取图链路和 `media_download.ts` 是同一套（rkey + CDN 直链），只是这里不是要字节、
 * 而是把**直链本身**交给 OCR 服务：
 *
 *   1. 按会话场景取 rkey（私聊图 10 / 群图 20，OIDB 0x9067_202，TTL 约 1 小时）；
 *   2. 用元素的 `fileToken` 拼 CDN 直链（appid 私聊 1406 / 群 1407）；
 *   3. 把直链 + 元素的 md5/字节数/宽高一起发给 0xe07_0。
 *
 * 实测（2026-10-16 探针）：服务端是**拿我们给的 URL 去取图**，md5 / 字节数只是随行
 * 元数据；抓包里那条 `qqpicocr-*.vod.tencent-cloud.com/<uuid>` 是客户端上传后的产物，
 * 本地既拿不到也拼不出 —— 但换成 CDN 直链照样出结果，所以这里根本不碰 VOD。
 *
 * 回包坐标是**喂进去那张图的像素坐标**（原点左上），与 `imageWidth/Height` 同系。
 * 我们把元素里记录的宽高原样送上去，回包坐标就能直接画在原图上。
 *
 * 与 `PeerStatsService` 同构：nt 绑定与在线 pid 在账号 bootstrap 时注入，这里只负责
 * 在已 attach 的在线 pid 上发包；失败（QQ 离线 / 风控 / rkey 拿不到）原样上抛，由
 * router 统一转成用户提示。
 */

import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { OcrImage, type OcrBlock } from '@weq/protocol';
import {
  GROUP_IMAGE_RKEY_TYPE,
  PRIVATE_IMAGE_RKEY_TYPE,
  composeMediaDownloadUrl,
} from './media_download';
import { fetchDownloadRkeys } from './online_ticket';
import type { DownloadRkey } from './user_config';

/** 只用到发包这一项原生能力。 */
export type ChatImageOcrNt = Pick<NtHelperBinding, 'sendOidbPacket'>;

export interface ChatImageOcrParams {
  /** 会话场景：私聊图用 rkey type 10 / appid 1406，群图用 20 / 1407。 */
  peerType: 'c2c' | 'group';
  /** 图片元素的 `fileToken`（tag 45503）—— 拼 CDN 直链用。 */
  fileToken: string;
  /** 图片宽（元素的 `imgWidth`）：既是随行元数据，也是回包坐标系的基准。 */
  width: number;
  /** 图片高（元素的 `imgHeight`）。 */
  height: number;
  /** 图片 md5（32 位 hex，可选；服务端不校验，如实上报而已）。 */
  md5?: string;
  /** 图片字节数（可选）。 */
  fileSize?: number;
}

export interface ChatImageOcrResult {
  /** 回包状态串，成功是 `succ`。 */
  status: string;
  /** 识别出的源语种（如 `zh` / `en`）。 */
  srcLang: string;
  /** 逐段文本 + 文字框（坐标即 `imageWidth×imageHeight` 那张图的像素）。 */
  blocks: OcrBlock[];
  /** 被识别图片的宽（回显上行尺寸）。 */
  imageWidth: number;
  /** 被识别图片的高。 */
  imageHeight: number;
  /** 本次任务的会话 id。 */
  sessionId: string;
}

/** 服务端**取不到图**时的错误码串（0xe07_0 回包的 `2`）。 */
export const OCR_DOWNLOAD_ERROR = 'FailedOperation.DownLoadError';

/**
 * 把失败帧翻译成用户能看懂的一句话。
 *
 * 关键是别把 {@link OCR_DOWNLOAD_ERROR} 当成「识别失败」：它的含义是**服务端取不到那张
 * 图** —— 聊天图片的 CDN 链接只有 `fileTTL`（元素 45518，实测 777600 秒 = 9 天）的有效期，
 * 过期后服务端只会回一句泛泛的「服务忙，请稍后重试」。注意 URL 是**交给服务端去取**的，
 * 所以本地缓存再全也救不回来，只能换近期的图。
 */
function describeOcrFailure(result: { retCode: number; status: string; message: string }): string {
  const code = result.status || `retCode=${result.retCode}`;
  if (result.status === OCR_DOWNLOAD_ERROR) {
    return `服务端已经取不到这张图了（QQ 的图片链接约 9 天过期），换张近期的图试试（${code}）`;
  }
  return `文字识别失败：${result.message || code}`;
}

export class ChatImageOcrService {
  constructor(
    private readonly nt: ChatImageOcrNt,
    _session: AccountSession,
    private readonly resolvePid: () => number,
  ) {}

  /**
   * 识别一张聊天图片里的文字。抛错意味着「这次没成」—— 调用方（router）负责转成
   * 用户能看懂的提示。
   */
  async recognize(params: ChatImageOcrParams): Promise<ChatImageOcrResult> {
    const { peerType, fileToken, width, height } = params;
    if (!fileToken) throw new Error('这张图没有 fileToken，拿不到服务端地址。');
    if (!width || !height) throw new Error('这张图缺尺寸信息，没法定位文字框。');

    const pid = this.resolvePid();
    if (!pid) throw new Error('QQ 未在线，无法识别文字。');

    const rkeyType = peerType === 'group' ? GROUP_IMAGE_RKEY_TYPE : PRIVATE_IMAGE_RKEY_TYPE;
    const rkeys = await fetchDownloadRkeys(this.nt, pid, [rkeyType]);
    const rkey: DownloadRkey | undefined = rkeys.find((item) => item.type === rkeyType) ?? rkeys[0];
    if (!rkey) throw new Error('没拿到图片下载凭据（rkey），确认 QQ 在线后重试。');

    const result = await OcrImage.invoke(this.nt, pid, {
      url: composeMediaDownloadUrl(fileToken, rkey),
      fileMd5: params.md5,
      fileSize: params.fileSize,
      width,
      height,
    });

    if (result.retCode !== 0 || (result.status && result.status !== 'succ')) {
      throw new Error(describeOcrFailure(result));
    }
    return {
      status: result.status,
      srcLang: result.srcLang,
      blocks: result.blocks,
      // 服务端会原样回显我们送的宽高；真回了个 0 就退回入参，别让上层拿 0 去算比例。
      imageWidth: result.imageWidth || width,
      imageHeight: result.imageHeight || height,
      sessionId: result.sessionId,
    };
  }
}
