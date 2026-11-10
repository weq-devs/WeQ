/** 仅刷新自有媒体桥的浏览器缓存，不改写 CDN 签名或 Blob/Data 地址。 */
export function mediaRetryUrl(source: string, attempt: number): string {
  if (!attempt) return source;
  const url = new URL(source, 'http://weq.invalid');
  if (url.protocol !== 'weq-media:' && !url.pathname.startsWith('/_media/')) return source;
  url.searchParams.set('_weq_retry', String(attempt));
  return source.startsWith('/') ? `${url.pathname}${url.search}${url.hash}` : url.href;
}
