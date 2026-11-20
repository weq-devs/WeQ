import { FLASH_PHOTO_FALLBACK_TEXT, specialFallbackKind } from '@weqbot/protocol/message-fallbacks';

export const FLASH_PHOTO_PLACEHOLDER_TEXT = FLASH_PHOTO_FALLBACK_TEXT;

export function isFlashPhotoPlaceholderText(text: string): boolean {
  return specialFallbackKind(text) === 'flashPhoto';
}

/** 凭据未就绪、QQ 离线或连接出错时允许稍后补拉。 */
export function isTransientMessageBackfillFailure(reason: string, message: string): boolean {
  // offline = 在线 QQ 没起来 / 完全离线模式；error = 其它（SSO 未登记、网络抖动等）。
  if (reason === 'offline') return true;
  // 只认 SSO 特有的措辞。别泛泛匹配「会话」—— 账号 / NT 序号不一致的报错里也有这两个
  // 字，那是永久失败，不能放进重试队列反复打。
  if (/SSO|setSsoSession/.test(message)) return true;
  return /网络|超时|timeout|连接|network|ECONN|ETIMEDOUT|EPIPE/i.test(message);
}
