import { detectImageFormat } from '@weq/protocol';
import { toProtocolAssetUrl } from '../../protocol_asset_url';
import { readResponseBytes } from '../../bounded_response';

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
    const bytes = await readResponseBytes(response, MAX_BYTES, signal, current);
    current();
    const format = detectImageFormat(bytes);
    if (!bytes.length || !format.width || !format.height) throw new Error('表情文件不是有效图片');
    return bytes;
  } finally {
    if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}
