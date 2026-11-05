import { IS_WEB } from './target';
import { client } from '../trpc/client';

/** 浏览器链接在点击栈里打开；不请求远端电脑启动浏览器。 */
export function openExternalLink(url: string): Promise<{ ok: boolean; error?: string }> {
  if (!IS_WEB) return client.help.openExternal.mutate({ url });
  try {
    const parsed = new URL(url);
    if (
      !['http:', 'https:', 'mailto:', 'tel:', 'tencent:', 'mqqapi:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error('不允许打开的链接协议或地址');
    window.open(parsed.href, '_blank', 'noopener,noreferrer');
    return Promise.resolve({ ok: true });
  } catch (error) {
    return Promise.resolve({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
