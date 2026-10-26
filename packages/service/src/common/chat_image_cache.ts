/** 预览保留预算，不是浏览器进程或动画全部帧的内存硬上限。 */
export const DEFAULT_CHAT_IMAGE_CACHE_MIB = 128;
export const MAX_CHAT_IMAGE_CACHE_MIB = 1024;

export function normalizeChatImageCacheMiB(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_CHAT_IMAGE_CACHE_MIB, Math.max(0, Math.floor(value)))
    : DEFAULT_CHAT_IMAGE_CACHE_MIB;
}
