import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestText } from './http';
import { parseQzoneCallback } from './qzone';

export interface SpecialCareResult {
  items: Array<{ uin: string; name: string }>;
  fansCount: number | null;
}

export function parseSpecialCare(text: string): SpecialCareResult {
  const response = parseQzoneCallback<{
    code?: number;
    subcode?: number;
    data?: {
      items_special?: Array<{ uin?: unknown; name?: unknown }>;
      fans_count?: Array<{ fans_count?: unknown }>;
    };
  }>(text);
  if (response.code === -3000 || response.code === -10000) {
    throw new WebAuthError('特别关心票据已失效。', response.code);
  }
  if (response.code !== 0 || (response.subcode !== undefined && response.subcode !== 0)) {
    throw new Error('暂时无法读取特别关心。');
  }
  if (!Array.isArray(response.data?.items_special)) {
    throw new Error('特别关心响应结构异常。');
  }
  const items: SpecialCareResult['items'] = [];
  const seen = new Set<string>();
  for (const item of response.data.items_special) {
    const uin = String(item?.uin ?? '');
    if (
      !/^[1-9]\d{4,19}$/.test(uin) ||
      (typeof item.uin === 'number' && !Number.isSafeInteger(item.uin))
    ) {
      throw new Error('特别关心名单结构异常。');
    }
    if (seen.has(uin)) continue;
    seen.add(uin);
    items.push({ uin, name: typeof item.name === 'string' ? item.name : '' });
  }
  const count = response.data.fans_count?.[0]?.fans_count;
  return {
    items,
    fansCount:
      typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null,
  };
}

export async function getSpecialCare(cred: WebCredential): Promise<SpecialCareResult> {
  const params = new URLSearchParams({
    uin: cred.uin,
    do: '3',
    fupdate: '1',
    rd: String(Math.random()),
    g_tk: String(computeBkn(cred.pskey || cred.skey)),
  });
  const text = await webRequestText(
    `https://r.qzone.qq.com/cgi-bin/tfriend/specialcare_get.cgi?${params}`,
    {
      cookie: cookieHeader(cred),
      headers: { Referer: 'https://user.qzone.qq.com/' },
      maxResponseBytes: 512 * 1024,
      retry: WEB_READ_RETRY,
    },
  );
  return parseSpecialCare(text);
}
