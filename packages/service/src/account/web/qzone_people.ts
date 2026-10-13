/** Public nickname data, independent of the viewing account's friend remarks. */
import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { webRequestBytes, WEB_READ_RETRY } from './http';
import { parseQzoneCallback } from './qzone';

export async function fetchQzoneNicknames(
  cred: WebCredential,
  uins: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const unique = [...new Set(uins)].filter((uin) => /^[1-9]\d{4,19}$/.test(uin));
  for (let offset = 0; offset < unique.length; offset += 40) {
    signal?.throwIfAborted();
    const batch = unique.slice(offset, offset + 40);
    const params = new URLSearchParams({
      uins: batch.join(','),
      g_tk: String(computeBkn(cred.pskey || cred.skey)),
    });
    const bytes = await webRequestBytes(
      `https://r.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg?${params}`,
      {
        method: 'GET',
        cookie: cookieHeader(cred),
        signal,
        headers: { Referer: 'https://user.qzone.qq.com/' },
        maxResponseBytes: 512 * 1024,
        retry: WEB_READ_RETRY,
      },
    );
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('gb18030').decode(bytes);
    }
    const data = parseQzoneCallback<Record<string, unknown>>(text);
    const error = data.error as { type?: string } | undefined;
    if (error?.type === 'need login') throw new WebAuthError('空间昵称票据已失效。', -3000);
    if (error) throw new Error('暂时无法读取空间昵称。');
    for (const uin of batch) {
      const row = data[uin];
      if (!Array.isArray(row) || row.length < 7 || typeof row[6] !== 'string') continue;
      const name = row[6].trim();
      if (name && name !== uin) names[uin] = name;
    }
  }
  return names;
}
