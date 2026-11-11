import { detectImageFormat } from '@weq/protocol';
import { toProtocolAssetUrl } from '../../protocol_asset_url';

const MAX_BYTES = 20 * 1024 * 1024;

/** 只读取聊天图片／商城表情协议，沿用缓存、在线下载及 rkey 回退。 */
export async function readFavoriteEmojiMedia(raw: string, current: () => void): Promise<Buffer> {
  const local = toProtocolAssetUrl(raw);
  if (!local) throw new Error('请选择聊天中的图片或表情');
  const url = new URL(local);
  if (
    url.protocol !== 'weq-media:' ||
    !['pic', 'mface'].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname && url.pathname !== '/')
  )
    throw new Error('请选择聊天中的图片或表情');
  url.searchParams.set('v', 'original');
  const { handleMediaRequest } = await import('../../media_protocol');
  current();
  const signal = AbortSignal.timeout(120_000);
  const response = await handleMediaRequest(new Request(url, { signal }), current);
  try {
    current();
    if (!response.ok || response.status === 206 || !response.body)
      throw new Error('未能取得表情原文件，请稍后重试');
    if (Number(response.headers.get('content-length')) > MAX_BYTES)
      throw new Error('表情不能超过 20 MB');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        current();
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > MAX_BYTES) throw new Error('表情不能超过 20 MB');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    current();
    const bytes = Buffer.concat(chunks, size);
    const format = detectImageFormat(bytes);
    if (!size || !format.width || !format.height) throw new Error('表情文件不是有效图片');
    return bytes;
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}
