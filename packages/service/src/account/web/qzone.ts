/**
 * QQ 空间读接口 — 说说列表 (`taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6`，经
 * `user.qzone.qq.com` 代理网关) 与好友动态 (`ic2.qzone.qq.com/cgi-bin/feeds/
 * feeds3_html_more`，经 `h5.qzone.qq.com` 代理网关) —— 与群相册列表同一套
 * cookie/g_tk 通路。两条走不同网关/目标域:说说走 user+taotao.qq.com 以避开
 * `-10000 使用人数过多` 风控(真机验证),动态仍走 h5+taotao.qzone。
 *
 * Auth: cookie jar + `g_tk = bkn(p_skey || skey)`。`uin` 在 query 里裸传(不带
 * 'o' 前缀),cookie 里的 uin 仍带 'o'(见 {@link cookieHeader})。
 *
 * 响应形态:说说列表用 `format=json` 回裸 JSON;好友动态是 JS 对象字面量(见
 * {@link parseQzoneCallback})。两者都走 {@link webRequestText} 取文本 —— 说说用
 * {@link parseQzoneJson} 容错切片,动态用非执行解析器,均不走严格 JSON.parse。
 *
 * 读路径采用 throw-on-auth-failure 约定:传输失败、非零 `code`、或缺失数据数组
 * (过期 cookie 产出的 body)都抛错,而 NOT 吞成空列表 —— 否则坏 cookie 会和
 * 真正的空空间无法区分。真正的空空间返回空数组,映射为空列表。
 */

import { computeBkn, cookieHeader, type WebCredential } from './credential';
import { webRequestText } from './http';

/**
 * 解析可能是裸 JSON 或 JSONP 回调包裹(`_Callback({...});`)的 qzone cgi body。
 * 从第一个 `{` 切到最后一个 `}` 再 JSON.parse —— 不绑定回调名(qzone 会变),
 * 两种形态都能扛。没有对象 body(如 HTML 错误页)时抛错,交由调用方转成失败。
 */
export function parseQzoneJson<T>(text: string): T {
  const s = text.trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('invalid response from qzone api');
  }
  return JSON.parse(s.slice(start, end + 1)) as T;
}

/**
 * 非执行地解析 qzone feeds 的 JS **对象字面量** body(不是 JSON)。
 * `feeds3_html_more` 返回 `_preloadCallback({ … })`,其中 `data` 用无引号键、
 * 单引号字符串、`\xNN` 转义、数组里还夹 `undefined` —— 本意是给浏览器回调 eval 的,
 * 所以 {@link parseQzoneJson} 的 JSON.parse 会直接噎住。
 *
 * 绝不 eval 远程内容(`vm` 沙箱不是安全边界,被篡改的响应能逃逸成 RCE)。这里用
 * 递归下降把字面量当**数据**解析:它只可能产出一个值,永远不会执行代码。
 * 只认对象/数组/字符串/数字/`true|false|null|undefined`;丢弃 `__proto__` 键防
 * 原型污染。数组尾部的 `undefined` 空洞由 {@link mapFeeds} 过滤。
 */
function parseJsLiteral(src: string): unknown {
  let i = 0;
  const n = src.length;
  const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
  const skipWs = (): void => {
    while (i < n && isWs(src[i]!)) i++;
  };

  function parseString(quote: string): string {
    i++; // 开引号
    let out = '';
    while (i < n) {
      const c = src[i]!;
      if (c === '\\') {
        const e = src[i + 1];
        if (e === 'x') {
          out += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
          i += 4;
          continue;
        }
        if (e === 'u') {
          out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
        out += e !== undefined ? (simple[e] ?? e) : ''; // \/ → /, \' → ', 未知转义 → 原字符
        i += 2;
        continue;
      }
      if (c === quote) {
        i++;
        return out;
      }
      out += c;
      i++;
    }
    throw new Error('unterminated string in qzone feeds payload');
  }

  function parseKey(): string {
    skipWs();
    const c = src[i];
    if (c === '"' || c === "'") return parseString(c);
    let s = '';
    while (i < n && /[A-Za-z0-9_$]/.test(src[i]!)) {
      s += src[i];
      i++;
    }
    if (!s) throw new Error('expected object key in qzone feeds payload');
    return s;
  }

  function parseObject(): Record<string, unknown> {
    i++; // {
    const obj: Record<string, unknown> = {};
    skipWs();
    if (src[i] === '}') {
      i++;
      return obj;
    }
    for (;;) {
      const key = parseKey();
      skipWs();
      if (src[i] !== ':') throw new Error('expected ":" in qzone feeds payload');
      i++;
      const value = parseValue();
      if (key !== '__proto__') obj[key] = value;
      skipWs();
      const ch = src[i];
      if (ch === ',') {
        i++;
        skipWs();
        if (src[i] === '}') {
          i++;
          return obj;
        }
        continue;
      }
      if (ch === '}') {
        i++;
        return obj;
      }
      throw new Error('expected "," or "}" in qzone feeds payload');
    }
  }

  function parseArray(): unknown[] {
    i++; // [
    const arr: unknown[] = [];
    skipWs();
    if (src[i] === ']') {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      const ch = src[i];
      if (ch === ',') {
        i++;
        skipWs();
        if (src[i] === ']') {
          i++;
          return arr;
        }
        continue;
      }
      if (ch === ']') {
        i++;
        return arr;
      }
      throw new Error('expected "," or "]" in qzone feeds payload');
    }
  }

  function parseValue(): unknown {
    skipWs();
    const c = src[i];
    if (c === undefined) throw new Error('unexpected end of qzone feeds payload');
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"' || c === "'") return parseString(c);
    let token = '';
    while (i < n && !/[,}\]:\s]/.test(src[i]!)) {
      token += src[i];
      i++;
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (token === 'undefined') return undefined;
    if (token !== '') {
      const num = Number(token);
      if (!Number.isNaN(num)) return num;
    }
    throw new Error('unexpected token in qzone feeds payload: ' + token.slice(0, 20));
  }

  return parseValue();
}

/**
 * 从 qzone feeds JSONP body 里取出回调实参那个对象,作为**数据**解析(永不执行,
 * 见 {@link parseJsLiteral})。从第一个 `{`(回调实参)切起,解析一个平衡值;
 * 尾部的 `);` 直接忽略。body 不是对象时抛错。
 */
export function parseQzoneCallback<T>(text: string): T {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('invalid feeds response from qzone api');
  const value = parseJsLiteral(text.slice(start));
  if (value === null || typeof value !== 'object') {
    throw new Error('invalid feeds response from qzone api');
  }
  return value as T;
}

// ─────────────── 说说列表 (说说 / emotion) — emotion_cgi_msglist_v6 ───────────────

interface RawPic {
  url1?: string;
  url2?: string;
  url3?: string;
  smallurl?: string;
}

interface RawEmotion {
  tid?: string;
  content?: string;
  created_time?: number;
  cmtnum?: number;
  secret?: number;
  pic?: RawPic[];
}

interface RawMsgListRet {
  code?: number;
  subcode?: number;
  message?: string;
  total?: number;
  msglist?: RawEmotion[] | null;
}

/** 一条说说(归一化形态)。 */
export interface QzoneEmotion {
  /** Feed id —— 后续 删/评/赞 的句柄。 */
  tid: string;
  content: string;
  /** 发表时间,unix 秒。 */
  time: number;
  /** 评论数。 */
  commentNum: number;
  /** 是否仅自己可见(private)。 */
  isPrivate: boolean;
  /** 图片 URL(每张图取可得的最大变体)。 */
  images: string[];
}

export interface QzoneMsgListResult {
  /** 账号说说总数(不是本页条数)。 */
  total: number;
  list: QzoneEmotion[];
}

/** 取一张图可得的最大 URL 变体。 */
function pickPicUrl(pic: RawPic): string | undefined {
  return pic.url3 || pic.url2 || pic.url1 || pic.smallurl || undefined;
}

/** 纯转换:原始 cgi 响应 → 归一化说说列表。 */
export function mapMsgList(data: RawMsgListRet): QzoneMsgListResult {
  const list = data.msglist ?? [];
  return {
    total: Number(data.total ?? list.length),
    list: list.map((e) => ({
      tid: String(e.tid ?? ''),
      content: e.content ?? '',
      time: Number(e.created_time ?? 0),
      commentNum: Number(e.cmtnum ?? 0),
      isPrivate: Number(e.secret ?? 0) !== 0,
      images: (e.pic ?? []).map(pickPicUrl).filter((u): u is string => !!u),
    })),
  };
}

/**
 * 拉取某个空间的说说列表。默认目标是 `targetUin` 指定的空间(任意机器人可见的
 * 空间皆可)。`pos` 偏移 + `num` 页大小可稳定深翻历史。
 *
 * 错误传播:非零 `code`(qzone 自己的鉴权/权限错误信封)或缺失 `msglist`
 * (过期 cookie 的 body)都抛错。真正的空空间返回 `msglist: []`,映射为空列表
 * 且 `total` 正确。
 */
export async function getQzoneMsgList(
  cred: WebCredential,
  targetUin: string,
  pos = 0,
  num = 20,
): Promise<QzoneMsgListResult> {
  const gtk = computeBkn(cred.pskey || cred.skey);

  // 关键路由:经 `user.qzone.qq.com` 代理网关访问目标域 `taotao.qq.com`
  // (注意 NOT `taotao.qzone.qq.com`)。这一组合经真机抓包验证**不吃**
  // `-10000 使用人数过多` 风控;而旧的 `h5.qzone.qq.com`+`taotao.qzone.qq.com`
  // 那套会被 taotao 单独甩 -10000。`format=json` 直接回裸 JSON(不再 JSONP 包裹),
  // parseQzoneJson 的容错切片照样能解。参数保持极简 —— 多余参数(loginUin/
  // callback/replynum…)对绕风控无益,去掉更贴近验证过的请求。
  const url = `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?${new URLSearchParams(
    {
      uin: targetUin,
      ftype: '0',
      sort: '0',
      pos: String(pos),
      num: String(num),
      g_tk: String(gtk),
      code_version: '1',
      format: 'json',
    },
  ).toString()}`;

  const text = await webRequestText(url, {
    method: 'GET',
    cookie: cookieHeader(cred),
    // Referer 指向目标空间;QZone 会校验 referer 是 qzone 来源。
    headers: { Referer: `https://user.qzone.qq.com/${targetUin}` },
  });
  const data = parseQzoneJson<RawMsgListRet>(text);

  if (typeof data.code === 'number' && data.code !== 0) {
    throw new Error(`qzone msglist failed: code=${data.code} ${data.message ?? ''}`.trim());
  }
  if (!Array.isArray(data.msglist)) {
    throw new Error(`无法获取空间说说列表(响应结构异常): ${text.slice(0, 200)}`);
  }

  return mapMsgList(data);
}

// ─────────────── 好友动态 (friend feeds) — feeds3_html_more ───────────────
// 好友动态 cgi 每条 feed 返回一段预渲染 HTML 加少量结构化字段。我们透出稳定的
// 结构化字段,HTML 原样带出(深度 HTML→段 解析超出范围,需要的调用方自己解)。
//
// 分页注意:该 cgi 可靠的深翻页靠时间游标(begintime/externparam/usertime,从
// 上一页带过来),这里暂未串接 —— 所以 `pageNum` 仅对首页可靠,`hasMore` 只表示
// 是否还有更多,不能稳定地翻到第二页。游标分页待真机抓包后补。

interface RawFeedItem {
  uin?: number | string;
  nickname?: string;
  abstime?: number | string;
  appid?: number | string;
  typeid?: number | string;
  key?: string;
  feedskey?: string;
  html?: string;
}

interface RawFeedsRet {
  code?: number;
  subcode?: number;
  message?: string;
  data?: {
    data?: RawFeedItem[] | null;
    hasmore?: number | string;
  };
}

/** 一条好友动态(归一化形态)。 */
export interface QzoneFeed {
  /** 作者 uin。 */
  uin: number;
  nickname: string;
  /** 发表时间,unix 秒。 */
  time: number;
  /** qzone app id(311 = 说说, 4 = 相册, …)。 */
  appid: number;
  /** Feed key —— qzone 用来寻址这条 feed 的句柄。 */
  key: string;
  /** 预渲染 HTML 原样带出。 */
  html: string;
}

export interface QzoneFeedsResult {
  feeds: QzoneFeed[];
  /** 服务端是否报告本页之后还有更多。 */
  hasMore: boolean;
}

/** 纯转换:原始 feeds 响应 → 归一化好友动态列表。 */
export function mapFeeds(data: RawFeedsRet): QzoneFeedsResult {
  // 该 cgi 会在数组尾部塞 `undefined`/null 空洞 —— 过滤掉。
  const list = (data.data?.data ?? []).filter((f): f is RawFeedItem => !!f);
  return {
    feeds: list.map((f) => ({
      uin: Number(f.uin ?? 0),
      nickname: f.nickname ?? '',
      time: Number(f.abstime ?? 0),
      appid: Number(f.appid ?? 0),
      // `key` 是 per-feed 句柄;`feedskey` 是部分 feed 类型上的旧别名,二者指同一个
      // per-feed 标识(NOT 列表级的下一页游标 —— 那个在 data.* 上,不在 item 上)。
      key: String(f.key ?? f.feedskey ?? ''),
      html: f.html ?? '',
    })),
    hasMore: Number(data.data?.hasmore ?? 0) !== 0,
  };
}

/**
 * 拉取好友动态列表,经 h5.qzone.qq.com 代理网关访问 ic2.qzone.qq.com 的
 * feeds3_html_more cgi(直连 ic2 会过不了 referer/同源校验,只有代理 origin 被
 * qzone.qq.com cookie jar 认证)。body 以 JSONP 请求,用共享容错解析器解。
 *
 * 与 {@link getQzoneMsgList} 同样的 throw-on-auth-failure 约定:缺失 `data.data`
 * 数组意味着 cookie/鉴权失败,抛错;真正的空动态(`data.data: []`)映射为空列表。
 */
export async function getQzoneFeeds(
  cred: WebCredential,
  selfUin: string,
  pageNum = 1,
  count = 10,
): Promise<QzoneFeedsResult> {
  const gtk = computeBkn(cred.pskey || cred.skey);

  const url = `https://h5.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?${new URLSearchParams(
    {
      uin: selfUin,
      scope: '0',
      view: '1',
      filter: 'all',
      flag: '1',
      applist: 'all',
      pagenum: String(pageNum),
      count: String(count),
      aisortEndTime: '0',
      aisortOffset: '0',
      aisortBeginTime: '0',
      begintime: '0',
      g_tk: String(gtk),
      callback: '_preloadCallback',
      format: 'jsonp',
      useutf8: '1',
      outputhtmlfeed: '1',
    },
  ).toString()}`;

  const text = await webRequestText(url, {
    method: 'GET',
    cookie: cookieHeader(cred),
    headers: { Referer: `https://user.qzone.qq.com/${selfUin}` },
  });
  // feeds3_html_more 的 body 是 JS 对象字面量而非 JSON —— 走非执行解析器
  // (见 parseQzoneCallback;永不执行),不能用 parseQzoneJson 的 JSON.parse。
  const data = parseQzoneCallback<RawFeedsRet>(text);

  if (typeof data.code === 'number' && data.code !== 0) {
    throw new Error(`qzone feeds failed: code=${data.code} ${data.message ?? ''}`.trim());
  }
  if (!Array.isArray(data.data?.data)) {
    // 带上响应头片段:cookie 失效 / 无权限 / 风控 各有不同 body,方便对症。
    throw new Error(`无法获取空间好友动态(响应结构异常): ${text.slice(0, 200)}`);
  }

  return mapFeeds(data);
}
