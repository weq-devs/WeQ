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

/** clientKey 三元组,来自 native `fetchClientKey` 的 JSON(client_key/key_index)。 */
export interface ClientKeyInfo {
  clientKey: string;
  keyIndex: string;
}

/**
 * 解析 native `fetchClientKey(pid)` 返回的 JSON 字符串。字段名与
 * `monitor.ts` 的 `parseClientKey` 一致(`client_key` / `key_index`)。
 * 解析失败或缺 clientKey 时返回 null。
 */
export function parseClientKeyJson(raw: string): ClientKeyInfo | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.client_key !== 'string' || !o.client_key) return null;
  return {
    clientKey: o.client_key,
    keyIndex: typeof o.key_index === 'string' ? o.key_index : '',
  };
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
          httpsGetCookies(next, jar, maxRedirects - 1).then(resolve).catch(reject);
        } else {
          resolve(jar);
        }
      });
    });
    req.on('error', reject);
  });
}

/**
 * ptlogin2 jump → 某个 qq.com 子域的完整 cookie jar。
 *
 * `u1` 落地页指向目标域的个人页,跳转链会在该域下补齐 p_skey/风控 cookie。
 * 与 SnowLuma 的 jump URL 逐参数对齐。
 */
export async function fetchPtlogin2Jar(
  ck: ClientKeyInfo,
  uin: string,
  domain: string,
): Promise<Record<string, string>> {
  const u1 = encodeURIComponent(`https://${domain}/${uin}/infocenter`);
  const url =
    `https://ssl.ptlogin2.qq.com/jump?ptlang=1033&clientuin=${uin}` +
    `&clientkey=${ck.clientKey}&u1=${u1}&keyindex=${ck.keyIndex}`;
  return httpsGetCookies(url);
}
