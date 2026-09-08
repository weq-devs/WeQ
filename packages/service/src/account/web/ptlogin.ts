/**
 * ptlogin2 cookie 引导 —— 用 clientKey 换一整套 qq.com 子域 cookie jar。
 *
 * QQ web cgi 的风控(尤其 QZone 查别人空间)不只看 skey/p_skey,还看
 * `pt4_token`/`RK`/`ptcz` 等只有走正常登录跳转才会下发的 cookie。手拼
 * `uin/skey/p_uin/p_skey` 四个字段会被甩 `-10000 使用人数过多`。
 *
 * 正确做法(对齐 SnowLuma `core/bridge/apis/web.ts` 的 getCookies):拿 clientKey
 * 拼一个 `ssl.ptlogin2.qq.com/jump` 跳转,请求它并**跟着 302 重定向把每一跳的
 * `Set-Cookie` 全收下来**,得到与浏览器等价的完整 jar。
 */

import http from 'node:http';
import https from 'node:https';

/** clientKey 二元组 — ptlogin2 jump 只需要这两个字段。 */
export interface ClientKeyInfo {
  clientKey: string;
  keyIndex: string;
}

/**
 * GET `url`,跟随 301/302 重定向,把沿途每个响应的 `Set-Cookie` 累积进 jar。
 * 只取 `k=v` 的 k 与 v(丢掉 Path/Domain/Expires 等属性)。这是 ptlogin2 跳转
 * 下发 cookie 的标准收集方式(等价 SnowLuma 的 `RequestUtil.HttpsGetCookies`)。
 */
export function httpsGetCookies(
  url: string,
  jar: Record<string, string> = {},
  maxRedirects = 5,
): Promise<Record<string, string>> {
  const client = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url, (res) => {
      const setCookies = res.headers['set-cookie'];
      if (setCookies) {
        for (const cookie of setCookies) {
          const pair = cookie.split(';')[0]?.split('=');
          const key = pair?.[0];
          const value = pair?.[1];
          if (key && value) jar[key] = value;
        }
      }

      // 必须消耗响应流,否则连接挂起。
      res.on('data', () => {});
      res.on('end', () => {
        const loc = res.headers.location;
        if ((res.statusCode === 301 || res.statusCode === 302) && loc && maxRedirects > 0) {
          const next = new URL(loc, url).href;
          httpsGetCookies(next, jar, maxRedirects - 1)
            .then(resolve)
            .catch(reject);
        } else {
          resolve(jar);
        }
      });
    });
    req.on('error', reject);
  });
}

/**
 * GET `url` WITHOUT following redirects and return only the first response's
 * `Set-Cookie` jar. ptlogin2 issues `skey` / `p_skey` on its 302; the landing
 * page frequently 503s and never carries cookies, so the Rust hook services
 * deliberately stopped at the redirect and so do we.
 */
export function httpGetSetCookiesOnce(url: string): Promise<Record<string, string>> {
  const client = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url, (res) => {
      const jar: Record<string, string> = {};
      for (const cookie of res.headers['set-cookie'] ?? []) {
        const [pair] = cookie.split(';');
        const [key, value] = pair?.split('=') ?? [];
        if (key && value) jar[key] = value;
      }
      res.on('data', () => {});
      res.on('end', () => resolve(jar));
    });
    req.on('error', reject);
  });
}

/**
 * ptlogin2 jump URL —— 用 clientKey 换「登录后落到 `landingUrl`」的一次性跳转地址。
 *
 * 跟着这个 URL 走一遍 302 链,沿途每一跳都会下发 qq.com 子域的 cookie。服务端用它
 * 收 jar(见 {@link fetchPtlogin2Jar});网页版则把它直接交给浏览器开新标签 ——
 * 302 链在浏览器里跑完,cookie 落进浏览器自己的 jar,等价于用户手动登录了一次。
 *
 * 参数与 SnowLuma 的 jump URL 逐个对齐。
 */
export function buildPtlogin2JumpUrl(ck: ClientKeyInfo, uin: string, landingUrl: string): string {
  const u1 = encodeURIComponent(landingUrl);
  return (
    `https://ssl.ptlogin2.qq.com/jump?ptlang=1033&clientuin=${uin}` +
    `&clientkey=${ck.clientKey}&u1=${u1}&keyindex=${ck.keyIndex}`
  );
}

/**
 * ptlogin2 jump → 某个 qq.com 子域的完整 cookie jar。
 *
 * `u1` 落地页指向目标域的个人页,跳转链会在该域下补齐 p_skey/风控 cookie。
 */
export async function fetchPtlogin2Jar(
  ck: ClientKeyInfo,
  uin: string,
  domain: string,
): Promise<Record<string, string>> {
  return httpsGetCookies(buildPtlogin2JumpUrl(ck, uin, `https://${domain}/${uin}/infocenter`));
}
