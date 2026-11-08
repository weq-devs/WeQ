/**
 * 给 QQ 的下载地址换一个**带签名的临时 URL**。
 *
 * 为什么需要：`pcConfig.json` 给的 `qqdl.gtimg.cn/qqfile/QQNTV2/...` 路径直接
 * GET 一律 403（我们只带普通头时）。官网页面并不是直接跳这个地址，而是先调
 * 这个内部接口拿一个带 `?sign=...&t=...` 的短时链接：
 *
 *   POST https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign
 *   content-type: application/json
 *   x-oidb: {"uint32_command":"0x9b8e","uint32_service_type":1}
 *   {"url": "<原始下载地址>"}
 *
 * 返回 `data.url` 就是可用的地址。实测不需要 cookie / UA / Referer，
 * 但缺了 `x-oidb` 会回 `retcode: 1001`，缺了 `content-type` 会回 `retcode: 4001`。
 *
 * 用法：
 *   node scripts/sign-qq-download.mjs <url>        # 打印签名后的 URL
 *   node scripts/sign-qq-download.mjs --json <url> # 打印完整响应
 *
 * 签名与时间戳绑定（`t=` 是 unix 秒），**不要缓存**：每次下载前现签。
 */

const SIGN_ENDPOINT =
  'https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign';
const OIDB_HEADER = '{"uint32_command":"0x9b8e","uint32_service_type":1}';

/** 签名接口失败时的错误（带上 retcode，便于判断是不是接口变了）。 */
export class SignError extends Error {
  constructor(message, { retcode, raw } = {}) {
    super(message);
    this.name = 'SignError';
    this.retcode = retcode;
    this.raw = raw;
  }
}

/**
 * 给一个 QQ 下载地址签名，返回带 `sign`/`t` 的地址。
 *
 * 已经是签名过的地址（含 `sign=`）时原样返回，方便调用方无脑调用。
 */
export async function signQqUrl(url, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new SignError(`不是合法 URL：${url}`);
  }
  if (/[?&]sign=/.test(url)) return url;

  const res = await fetchImpl(SIGN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-oidb': OIDB_HEADER },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new SignError(`签名接口 HTTP ${res.status}`);

  const body = await res.json().catch(() => null);
  const retcode = body?.retcode;
  if (retcode !== 0) {
    // 1001 = 缺 x-oidb；4001 = 缺 content-type。两者都说明请求形态变了。
    throw new SignError(
      `签名接口拒绝（retcode=${retcode}，${body?.msg ?? body?.message ?? '无说明'}）`,
      { retcode, raw: body },
    );
  }
  const signed = body?.data?.url;
  if (typeof signed !== 'string' || !signed) {
    throw new SignError('签名接口返回里没有 data.url', { raw: body });
  }
  return signed;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    process.stderr.write('用法: node scripts/sign-qq-download.mjs [--json] <url>\n');
    process.exit(2);
  }
  try {
    const signed = await signQqUrl(url);
    process.stdout.write(asJson ? `${JSON.stringify({ url: signed })}\n` : `${signed}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
