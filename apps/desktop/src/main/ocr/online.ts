/**
 * 在线图片文字识别（导出阶段注入的那条腿）—— 把一张图交给 QQ 服务端的图片 OCR
 * （OIDB 0xe07_0，见 `@weq/service` 的 `ChatImageOcrService`）。
 *
 * 与语音那条「在线转写」不同，这里**不需要抓包**：0xe07_0 是普通的请求 / 应答，文本
 * 就在回包里（同步返回），所以没有 arm / disarm 那一套。
 *
 * 这里只负责「一张图 → 一份结果」，并发、从新到旧的顺序、连续失败 10 张就放弃在线
 * 这些策略都在导出阶段（`@weq/service` 的 `ocr_export`）里，那才是能被单测钉住的地方。
 *
 * 唯一自己做的是 **rkey 缓存**：媒体下载凭据（约 1 小时有效）批量识别时取一次复用
 * 整批 —— 上千张图每张都重新签一次纯属浪费。失败时按错误文案判断要不要丢掉缓存
 * （凭据类错误重取，图过期这类错误留着）。
 */

import {
  getLogger,
  type ChatImageOcrService,
  type OcrImageOutcome,
  type OcrOnlineImageFn,
  type OcrOnlineRequest,
} from '@weq/service';

const logger = getLogger().child({ scope: 'online-ocr' });

/** 凭据缓存有效期（毫秒）：rkey 官方 TTL 约 1 小时，留点余量提前重取。 */
const RKEY_TTL_MS = 45 * 60 * 1000;

/** 一个会话场景的凭据（存 in-flight 的 promise，避免并发首包各自去签一条）。 */
interface CachedRkey {
  promise: ReturnType<ChatImageOcrService['fetchRkey']>;
  at: number;
}

export class OnlineImageOcr {
  private readonly rkeys = new Map<'c2c' | 'group', CachedRkey>();

  constructor(private readonly service: ChatImageOcrService) {}

  /** 取（或复用）该会话场景的图片下载凭据。 */
  private async rkey(peerType: 'c2c' | 'group') {
    const hit = this.rkeys.get(peerType);
    if (hit && Date.now() - hit.at < RKEY_TTL_MS) return hit.promise;
    // 并发第一批会同时走到这里：存 promise（而不是结果）保证只签一条。
    const promise = this.service.fetchRkey(peerType).catch((e: unknown) => {
      // 签失败不留下坏缓存，下一张图重新试。
      this.rkeys.delete(peerType);
      throw e;
    });
    this.rkeys.set(peerType, { promise, at: Date.now() });
    return promise;
  }

  /** 凭据类失败（拿不到 / 已失效）才丢掉缓存，别的错误留着 Next 继续用。 */
  private dropRkeyIfCredentialError(peerType: 'c2c' | 'group', message: string): void {
    if (/rkey|凭据|未在线/i.test(message)) this.rkeys.delete(peerType);
  }

  /**
   * 识别一张图（导出阶段注入 `OcrOnlineImageFn`）。**不抛错**：QQ 离线 / 图过期 /
   * 风控都从 `ok: false` 里说人话，由导出阶段决定回退本地还是记失败。
   */
  readonly recognize: OcrOnlineImageFn = async (
    req: OcrOnlineRequest,
  ): Promise<OcrImageOutcome> => {
    const started = Date.now();
    try {
      const credential = await this.rkey(req.peerType);
      const result = await this.service.recognize(
        {
          peerType: req.peerType,
          fileToken: req.fileToken,
          width: req.width,
          height: req.height,
          ...(req.md5 ? { md5: req.md5 } : {}),
          ...(req.fileSize ? { fileSize: req.fileSize } : {}),
        },
        credential,
      );
      const blocks = result.blocks.filter((block) => block.text.trim() !== '');
      return {
        ok: true,
        text: blocks.map((block) => block.text).join('\n'),
        blocks,
        width: result.imageWidth,
        height: result.imageHeight,
        elapsedMs: Date.now() - started,
      };
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : '在线识别失败';
      this.dropRkeyIfCredentialError(req.peerType, message);
      return { ok: false, error: message };
    }
  };

  /** 清空凭据缓存（账号切换 / 导出结束时调用；纯内存，无副作用）。 */
  reset(): void {
    this.rkeys.clear();
    logger.debug('online ocr rkey cache cleared');
  }
}
