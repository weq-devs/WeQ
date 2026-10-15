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

import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestText } from './http';

/**
 * 判定「票据不对」的错误码 —— 与群相册同一套判据(见 group_album 的 AUTH_CODES)。
 * 抛 WebAuthError 而不是普通 Error,好让 withRetry 换票重试一次;其余错码(无权限、
 * 空间不存在)换票也没用,照常抛普通 Error。
 */
const AUTH_CODES = new Set([-3000, -10000]);

function qzoneCodeError(what: string, code: number, message?: string): Error {
  const msg = `${what} failed: code=${code} ${message ?? ''}`.trim();
  return AUTH_CODES.has(code) ? new WebAuthError(msg, code) : new Error(msg);
}

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
  const isWs = (c: string): boolean =>
    c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
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
        const simple: Record<string, string> = {
          n: '\n',
          t: '\t',
          r: '\r',
          b: '\b',
          f: '\f',
          v: '\v',
          '0': '\0',
        };
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
    throw new Error(`unexpected token in qzone feeds payload: ${token.slice(0, 20)}`);
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
  /** 1 = 视频条目（图文混排时视频作为 pic 元素出现，本体在 video_info 里）。 */
  is_video?: boolean | number;
  video_info?: {
    pic_url?: string;
    url1?: string;
    url2?: string;
    url3?: string;
    video_id?: string | number;
    video_time?: string | number;
  };
}

/** 纯视频帖（形态 B）：视频挂在顶层 `video[]` 数组，而非 pic[].video_info。 */
interface RawTopVideo {
  pic_url?: string;
  url1?: string;
  url2?: string;
  url3?: string;
  video_id?: string | number;
  video_time?: string | number;
}

interface RawEmotion {
  uin?: string | number;
  tid?: string;
  content?: string;
  has_more_con?: boolean | number | string;
  rt_has_more_con?: boolean | number | string;
  pictotal?: number | string;
  created_time?: number;
  cmtnum?: number;
  fwdnum?: number | string;
  rt_sum?: number | string;
  rt_tid?: string;
  rt_uin?: string | number;
  rt_uinname?: string;
  rt_con?: string | { content?: string };
  rt_pic?: RawPic[];
  rt_video?: RawTopVideo[];
  secret?: number;
  pic?: RawPic[];
  video?: RawTopVideo[];
  voice?: Record<string, unknown>[];
  audio?: Record<string, unknown>[];
  custom_voices?: Record<string, unknown>[];
  custom_audios?: Record<string, unknown>[];
}

interface RawMsgListRet {
  code?: number;
  subcode?: number;
  message?: string;
  total?: number;
  msglist?: RawEmotion[] | null;
  logininfo?: { uin?: string | number };
  usrinfo?: { uin?: string | number; name?: string; nickname?: string; nick?: string };
}

/** 说说里的一个视频(归一化形态)。 */
export interface QzoneEmotionVideo {
  /** 封面 URL(纯视频帖常为空)。 */
  coverUrl: string;
  /** 视频本体 mp4 URL(带签名、会过期,导出时需即时下载)。 */
  videoUrl: string;
  /** 视频 id。 */
  videoId: string;
  /** 时长 ms。 */
  duration: number;
}

/** 一条说说(归一化形态)。 */
export interface QzoneEmotion {
  /** Feed id —— 后续 删/评/赞 的句柄。 */
  tid: string;
  content: string;
  contentTruncated?: boolean;
  imageTotal?: number | null;
  /** Number of returned pic entries; top-level videos are a separate collection. */
  imageReturned?: number;
  /** 发表时间,unix 秒。 */
  time: number;
  /** 评论数；接口未提供时为 null。 */
  commentNum: number | null;
  /** 转发数；接口未提供时不推断为零。 */
  forwardNum?: number;
  /** 是否仅自己可见(private)。 */
  isPrivate: boolean;
  /** 图片 URL(每张图取可得的最大变体)。 */
  images: string[];
  /** 视频(封面 + 本体 mp4;图文混排与纯视频帖两种形态都归一化到这里)。 */
  videos: QzoneEmotionVideo[];
  /** Original post carried by a repost; separate from the forwarder's text. */
  repost?: {
    tid: string;
    uin: string;
    nickname: string;
    content: string;
    images: string[];
    videos: QzoneEmotionVideo[];
    contentTruncated?: boolean;
  };
  /** 原生媒体字段用于增量版本检测；含无本体 URL 的视频与语音未知字段。 */
  nativeMedia?: {
    pic: RawPic[];
    video: RawTopVideo[];
    voice: Record<string, unknown>[];
    audio: Record<string, unknown>[];
    custom_voices: Record<string, unknown>[];
    custom_audios: Record<string, unknown>[];
  };
}

export interface QzoneMsgListResult {
  /** Space owner metadata supplied alongside the post list. */
  owner?: { uin: string; nickname: string };
  /** 账号说说总数(不是本页条数)。 */
  total: number;
  list: QzoneEmotion[];
}

/** 取一张图可得的最大 URL 变体。 */
function pickPicUrl(pic: RawPic): string | undefined {
  return pic.url3 || pic.url2 || pic.url1 || pic.smallurl || undefined;
}

/**
 * 从一条说说的原始字段里提取视频(两种形态):
 *   - 形态 A(图文混排):`pic[].is_video=1` + `pic[].video_info`,本体在
 *     `video_info.url3`(photovideo.photo.qq.com 带签名 mp4),封面 `pic_url` /
 *     `url1` 可能为空。
 *   - 形态 B(纯视频帖):顶层 `e.video[]` 数组,封面 `pic_url` 常为空,本体 `url3`。
 * 拿不到本体 url3 的条目直接丢弃(只剩封面没有意义)。
 */
function mapVideos(pic: RawPic[], topVideo: RawTopVideo[] | undefined): QzoneEmotionVideo[] {
  const out: QzoneEmotionVideo[] = [];
  for (const p of pic) {
    const vi = p.video_info;
    if (!p.is_video || !vi) continue;
    const videoUrl = vi.url3 || '';
    if (!videoUrl) continue;
    out.push({
      coverUrl: vi.pic_url || vi.url1 || pickPicUrl(p) || '',
      videoUrl,
      videoId: String(vi.video_id ?? ''),
      duration: Number(vi.video_time ?? 0),
    });
  }
  for (const v of topVideo ?? []) {
    const videoUrl = v.url3 || '';
    if (!videoUrl) continue;
    out.push({
      coverUrl: v.pic_url || v.url1 || '',
      videoUrl,
      videoId: String(v.video_id ?? ''),
      duration: Number(v.video_time ?? 0),
    });
  }
  return out;
}

/** 纯转换:原始 cgi 响应 → 归一化说说列表。 */
export function mapMsgList(data: RawMsgListRet): QzoneMsgListResult {
  const list = data.msglist ?? [];
  const ownerUin = String(data.usrinfo?.uin ?? '');
  const ownerName = data.usrinfo?.name ?? data.usrinfo?.nickname ?? data.usrinfo?.nick;
  return {
    ...(/^[1-9]\d{4,19}$/.test(ownerUin) && typeof ownerName === 'string' && ownerName.trim()
      ? { owner: { uin: ownerUin, nickname: ownerName.trim() } }
      : {}),
    total: Number(data.total ?? list.length),
    list: list.map((e) => {
      const pics = e.pic ?? [];
      // Official mood UI renders getRTCount() from rt_sum; fwdnum is a different counter.
      const rawForwardCount = e.rt_sum ?? e.fwdnum;
      const originalContent =
        typeof e.rt_con === 'string'
          ? e.rt_con
          : typeof e.rt_con?.content === 'string'
            ? e.rt_con.content
            : '';
      const isRepost = Boolean(
        (e.rt_tid && String(e.rt_tid) !== '0') ||
          /^[1-9]\d{4,19}$/.test(String(e.rt_uin ?? '')) ||
          originalContent,
      );
      const hasOriginalPics = Array.isArray(e.rt_pic);
      const hasOriginalVideos = Array.isArray(e.rt_video);
      const originalPics = hasOriginalPics ? e.rt_pic! : pics;
      const originalVideos = hasOriginalVideos ? e.rt_video : e.video;
      // 视频条目(形态 A)从 images 里剔除 —— 封面由 videos[].coverUrl 承载,
      // 避免 HTML / 灯箱把同一张封面渲染两遍。
      const images = pics
        .filter((p) => !(p.is_video && p.video_info?.url3))
        .map(pickPicUrl)
        .filter((u): u is string => !!u);
      return {
        tid: String(e.tid ?? ''),
        content: e.content ?? '',
        imageReturned: pics.length,
        contentTruncated: e.has_more_con === true || e.has_more_con === 1 || e.has_more_con === '1',
        imageTotal:
          e.pictotal !== undefined &&
          /^\d+$/.test(String(e.pictotal)) &&
          Number.isSafeInteger(Number(e.pictotal))
            ? Number(e.pictotal)
            : null,
        time: Number(e.created_time ?? 0),
        commentNum:
          e.cmtnum !== undefined &&
          e.cmtnum !== null &&
          String(e.cmtnum).trim() !== '' &&
          Number.isSafeInteger(Number(e.cmtnum)) &&
          Number(e.cmtnum) >= 0
            ? Number(e.cmtnum)
            : null,
        ...(rawForwardCount !== undefined &&
        rawForwardCount !== null &&
        String(rawForwardCount).trim() !== '' &&
        Number.isSafeInteger(Number(rawForwardCount)) &&
        Number(rawForwardCount) >= 0
          ? { forwardNum: Number(rawForwardCount) }
          : {}),
        isPrivate: Number(e.secret ?? 0) !== 0,
        images,
        videos: mapVideos(pics, e.video),
        ...(isRepost
          ? {
              repost: {
                tid: String(e.rt_tid ?? ''),
                uin: String(e.rt_uin ?? ''),
                nickname: typeof e.rt_uinname === 'string' ? e.rt_uinname : '',
                content: originalContent,
                contentTruncated:
                  e.rt_has_more_con === true ||
                  e.rt_has_more_con === 1 ||
                  e.rt_has_more_con === '1',
                images: originalPics
                  .filter((p) => !(p.is_video && p.video_info?.url3))
                  .map(pickPicUrl)
                  .filter((url): url is string => Boolean(url)),
                videos: mapVideos(originalPics, originalVideos),
              },
            }
          : {}),
        nativeMedia: {
          pic: pics,
          video: e.video ?? [],
          voice: e.voice ?? [],
          audio: e.audio ?? [],
          custom_voices: e.custom_voices ?? [],
          custom_audios: e.custom_audios ?? [],
        },
      };
    }),
  };
}

/**
 * 拉取某个空间的说说列表。默认目标是 `targetUin` 指定的空间(任意机器人可见的
 * 空间皆可)。`pos` 偏移 + `num` 页大小可稳定深翻历史。
 *
 * 错误传播:非零 `code`(qzone 自己的鉴权/权限错误信封)或缺失 `msglist`
 * (过期 cookie 的 body)都抛错。成功响应也可能携带 null 列表；只有登录身份与
 * 目标空间均匹配时才按当前无可见内容处理，保留服务端 total（可能大于零）。
 * 可选 captureRaw 先保存完整响应原文，成功后才解析/映射；写入失败直接传播。
 * 回调只接收响应文本，不接收请求 URL、Cookie 或凭据。
 */
export async function getQzoneMsgList(
  cred: WebCredential,
  targetUin: string,
  pos = 0,
  num = 20,
  captureRaw?: (text: string) => Promise<void>,
  signal?: AbortSignal,
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
    signal,
    retry: WEB_READ_RETRY,
  });
  if (captureRaw) await captureRaw(text);
  const data = parseQzoneJson<RawMsgListRet>(text);

  if (typeof data.code === 'number' && data.code !== 0) {
    throw qzoneCodeError('qzone msglist', data.code, data.message);
  }
  if (!Array.isArray(data.msglist)) {
    if (
      data.msglist === null &&
      data.code === 0 &&
      String(data.logininfo?.uin) === cred.uin &&
      String(data.usrinfo?.uin) === targetUin
    ) {
      return mapMsgList({ ...data, msglist: [] });
    }
    throw new Error('暂时无法读取空间动态，请稍后重试。');
  }

  return mapMsgList(data);
}

// ─────────────── 好友动态 (friend feeds) — feeds3_html_more ───────────────
// 好友动态 cgi 每条 feed 返回一段预渲染 HTML 加少量结构化字段。我们透出稳定的
// 结构化字段,HTML 原样带出(深度 HTML→段 解析超出范围,需要的调用方自己解)。
//
// Pagination continues with data.main.externparam from the previous page;
// basetime and pagenum must also be mirrored in the top-level request.

export interface RawFeedItem {
  uin?: number | string;
  opuin?: number | string;
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
    main?: { externparam?: string; hasMoreFeeds?: boolean | number | string };
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
  /** Server-issued continuation, carried in memory only. */
  nextCursor?: string;
}

/** 纯转换:原始 feeds 响应 → 归一化好友动态列表。 */
export function mapFeeds(data: RawFeedsRet): QzoneFeedsResult {
  // 该 cgi 会在数组尾部塞 `undefined`/null 空洞 —— 过滤掉。
  const list = (data.data?.data ?? []).filter((f): f is RawFeedItem => !!f);
  const more = data.data?.main?.hasMoreFeeds;
  const hasMore =
    more === undefined
      ? Number(data.data?.hasmore ?? 0) !== 0
      : more === true || more === 1 || more === '1' || more === 'true';
  const nextCursor = data.data?.main?.externparam;
  return {
    feeds: list.map((f) => ({
      uin: Number(f.uin ?? f.opuin ?? 0),
      nickname: f.nickname ?? '',
      time: Number(f.abstime ?? 0),
      appid: Number(f.appid ?? 0),
      // `key` 是 per-feed 句柄;`feedskey` 是部分 feed 类型上的旧别名,二者指同一个
      // per-feed 标识(NOT 列表级的下一页游标 —— 那个在 data.* 上,不在 item 上)。
      key: String(f.key ?? f.feedskey ?? ''),
      html: f.html ?? '',
    })),
    hasMore,
    ...(hasMore && typeof nextCursor === 'string' && nextCursor && nextCursor.length <= 16384
      ? { nextCursor }
      : {}),
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
  signal?: AbortSignal,
  cursor?: string,
  scope: 0 | 7 = 0,
): Promise<QzoneFeedsResult> {
  const gtk = computeBkn(cred.pskey || cred.skey);
  const continuation = new URLSearchParams(cursor ?? '');
  const beginTime = cursor ? continuation.get('basetime') : '0';
  const page = cursor ? continuation.get('pagenum') : String(pageNum);
  if (cursor && (!beginTime || !/^\d+$/.test(beginTime) || !page || !/^\d+$/.test(page)))
    throw new Error('好友动态分页信息无效，请刷新后重试。');

  const url = `https://h5.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?${new URLSearchParams(
    {
      uin: selfUin,
      scope: String(scope),
      view: '1',
      filter: 'all',
      flag: '1',
      applist: 'all',
      pagenum: page!,
      count: String(count),
      refresh: cursor ? '0' : '1',
      dayspac: '5',
      sidomain: 'qzonestyle.gtimg.cn',
      ...(cursor ? { externparam: cursor } : {}),
      aisortEndTime: '0',
      aisortOffset: '0',
      aisortBeginTime: '0',
      begintime: beginTime!,
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
    signal,
    retry: WEB_READ_RETRY,
  });
  // feeds3_html_more 的 body 是 JS 对象字面量而非 JSON —— 走非执行解析器
  // (见 parseQzoneCallback;永不执行),不能用 parseQzoneJson 的 JSON.parse。
  const data = parseQzoneCallback<RawFeedsRet>(text);

  if (typeof data.code === 'number' && data.code !== 0) {
    throw qzoneCodeError('qzone feeds', data.code, data.message);
  }
  if (!Array.isArray(data.data?.data)) {
    throw new Error('暂时无法读取好友动态，请稍后重试。');
  }

  return mapFeeds(data);
}
