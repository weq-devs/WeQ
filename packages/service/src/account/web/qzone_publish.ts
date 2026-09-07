/**
 * QQ 空间**写**接口 — 上传图片 (`up.qzone.qq.com/cgi-bin/upload/cgi_upload_image`)
 * 与发表说说 (`taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6`，经
 * `h5.qzone.qq.com` 代理网关)。底层逻辑移植自 SnowLuma（同源协议，已确认真机可用），
 * 改造成本项目的 {@link WebCredential} / {@link webRequestText} 通路：
 * cookie 由 {@link cookieHeader} 统一拼装（ptlogin2 jar 优先），g_tk = bkn(p_skey || skey)。
 *
 * 写路径 throw-on-failure：非零 code/subcode、或成功 body 缺关键帧都抛错 —— 绝不把
 * 一次没有 tid 的发表当成成功。票据类错码（-3000/-10000）抛 {@link WebAuthError}
 * 交由 withRetry 换票重试；其余错码（内容被拒/风控）换票没用，照常抛普通 Error。
 *
 * ⚠️ 发表是主动写行为，Qzone 对高频发表风控 —— 调用方自行限流。
 */

import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { webRequestText } from './http';
import { parseQzoneJson } from './qzone';

/** 判定「票据不对」—— 与读路径同一套，好让 withRetry 换票重试。 */
const AUTH_CODES = new Set([-3000, -10000]);

function qzoneCodeError(what: string, code: number, message?: string): Error {
  const msg = `${what} failed: code=${code} ${message ?? ''}`.trim();
  return AUTH_CODES.has(code) ? new WebAuthError(msg, code) : new Error(msg);
}

/** 网页调用用的浏览器 UA（qzone cgi 缺了会拒）。 */
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

// ─────────────── 上传图片 — cgi_upload_image ───────────────
// 图片以 base64 表单字段 POST 到 up.qzone.qq.com（不走 h5 代理 —— 上传 CGI 不在
// h5.qzone.qq.com/proxy 后面）。响应是 `frameElement.callback({...});` JSONP 包裹，
// 用共享的容错切片解析。richval 格式 `,albumid,lloc,sloc,type,h,w,,h,w` —— 双份
// 宽高镜像 php-qzone 的实现（SnowLuma 同款，确认可用）。

interface RawUploadImageResponse {
  code?: number;
  subcode?: number;
  message?: string;
  data?: {
    albumid?: string;
    lloc?: string;
    url?: string;
    type?: number;
    height?: number;
    width?: number;
  };
}

/** 上传一张图的结果。 */
export interface QzoneUploadImageResult {
  /** 发表时 `richval` 参数用的字符串（多图用 `\t` 拼接）。 */
  richval: string;
  /** 上传后图片的直链。 */
  url: string;
  albumid: string;
  lloc: string;
  type: number;
  width: number;
  height: number;
}

/** 剥 data-URI 前缀 / 宽松空白，校验 base64 合法性并补齐 padding。 */
function normalizeBase64(input: string): string {
  let text = input.trim();
  if (/^base64:\/\//i.test(text)) text = text.slice(9).trim();
  if (/^data:/i.test(text)) {
    const comma = text.indexOf(',');
    if (comma === -1) throw new Error('data URI 缺少 base64 载荷');
    text = text.slice(comma + 1);
  }
  const compact = text.replace(/ /g, '+').replace(/[\r\n\t]/g, '');
  if (!compact) throw new Error('图片 base64 为空');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw new Error('图片 base64 不合法');
  const firstPadding = compact.indexOf('=');
  if (firstPadding !== -1 && /[^=]/.test(compact.slice(firstPadding))) {
    throw new Error('图片 base64 不合法');
  }
  const unpadded = compact.replace(/=+$/, '');
  const remainder = unpadded.length % 4;
  if (remainder === 1) throw new Error('图片 base64 不合法');
  return unpadded + '='.repeat((4 - remainder) % 4);
}

/**
 * 上传一张图（base64）到 Qzone 图床，返回含 `richval` 的元数据。
 * 多图发表：每张调一次，把 richval 用 `\t` 拼起来传给 {@link publishQzoneMsg}。
 */
export async function uploadQzoneImage(
  cred: WebCredential,
  imageBase64: string,
): Promise<QzoneUploadImageResult> {
  if (!imageBase64) throw new Error('图片 base64 为空');
  const base64 = normalizeBase64(imageBase64);

  // jar 里直接取 skey/p_skey（cookieHeader 也这么拼）；bkn 用 p_skey 优先。
  const jar: Record<string, string> = {};
  for (const part of cookieHeader(cred).split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1) jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  const bkn = computeBkn(cred.pskey || cred.skey);

  const url = `https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${bkn}`;
  const body = new URLSearchParams({
    filename: 'filename',
    uin: cred.uin,
    skey: jar['skey'] ?? cred.skey,
    zzpaneluin: cred.uin,
    p_uin: cred.uin,
    p_skey: jar['p_skey'] ?? cred.pskey,
    uploadtype: '1',
    albumtype: '7',
    exttype: '0',
    refer: 'shuoshuo',
    output_type: 'jsonhtml',
    charset: 'utf-8',
    output_charset: 'utf-8',
    upload_hd: '1',
    hd_width: '2048',
    hd_height: '10000',
    hd_quality: '96',
    backUrls: `http://upbak.photo.qzone.qq.com/cgi-bin/upload/cgi_upload_image,http://119.147.64.75/cgi-bin/upload/cgi_upload_image&url=https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${bkn}`,
    base64: '1',
    jsonhtml_callback: 'callback',
    picfile: base64,
    qzreferrer: `https://user.qzone.qq.com/${cred.uin}/main`,
  }).toString();

  const text = await webRequestText(url, {
    method: 'POST',
    cookie: cookieHeader(cred),
    body,
    headers: {
      Referer: `https://user.qzone.qq.com/${cred.uin}/main`,
      'User-Agent': WEB_UA,
    },
  });

  // 响应是 `<script>frameElement.callback(...JSON...);</script>` —— 从 callback
  // 起切片再走容错解析（与 SnowLuma 同一手势）。
  let jsonText = text.trim();
  const callbackStart = jsonText.indexOf('callback');
  if (callbackStart !== -1) jsonText = jsonText.slice(callbackStart);
  const data = parseQzoneJson<RawUploadImageResponse>(jsonText);

  if (typeof data.code === 'number' && data.code !== 0) {
    throw qzoneCodeError('qzone upload image', data.code, data.message);
  }
  if (typeof data.subcode === 'number' && data.subcode !== 0) {
    throw qzoneCodeError('qzone upload image', data.subcode, data.message);
  }
  if (!data.data || !data.data.albumid || !data.data.lloc || !data.data.url) {
    throw new Error('上传图片失败：响应缺少必要字段');
  }

  const { albumid, lloc, url: imageUrl, type, height, width } = data.data;
  const sloc = lloc; // lloc 与 sloc 在 wire 格式里相同
  const richval = `,${albumid},${lloc},${sloc},${type ?? 0},${height ?? 0},${width ?? 0},,${height ?? 0},${width ?? 0}`;
  return {
    richval,
    url: imageUrl,
    albumid,
    lloc,
    type: type ?? 0,
    width: width ?? 0,
    height: height ?? 0,
  };
}

// ─────────────── 发说说 — emotion_cgi_publish_v6 ───────────────

interface RawPublishResponse {
  code?: number;
  subcode?: number;
  message?: string;
  // publish_v6 成功包里新 feed 的 id 叫 `t1_tid`、时间叫 `t1_time`（后者是字符串）。
  // `tid`/`now` 保留为兼容兜底 —— 只读 `tid` 会在每次成功上误判失败。
  t1_tid?: string;
  t1_time?: string;
  tid?: string;
  now?: number;
}

/** 发表一条说说的结果。 */
export interface QzonePublishResult {
  /** 新说说的 tid —— 之后删除/评论/点赞的句柄。 */
  tid: string;
  /** 发表时间 unix 秒。 */
  time: number;
}

/** 空间可见权限位。 */
export type QzoneUgcRight = 1 | 4 | 16 | 64 | 128;

const QZONE_UGC_RIGHTS = new Set<number>([1, 4, 16, 64, 128]);

/**
 * 发表一条说说（图文）。`richvals` 为每张图的 richval（来自
 * {@link uploadQzoneImage}），多图自动以 `\t` 拼接；传空数组即纯文字。
 * `ugcRight` = 可见权限（16/128 必须给 `targetUins`，用 `|` 分隔）。
 */
export async function publishQzoneMsg(
  cred: WebCredential,
  content: string,
  richvals: string[],
  ugcRight: QzoneUgcRight = 1,
  targetUins?: string[],
): Promise<QzonePublishResult> {
  if (!content) throw new Error('说说内容不能为空');
  if (!QZONE_UGC_RIGHTS.has(ugcRight)) {
    throw new Error('ugc_right 必须是 1, 4, 16, 64, 128 之一');
  }
  const needsTargets = ugcRight === 16 || ugcRight === 128;
  const targets = (targetUins ?? [])
    .map((u) => u.trim())
    .filter((u) => /^\d+$/.test(u));
  if (needsTargets && targets.length === 0) {
    throw new Error('ugc_right 为 16/128 时必须提供 targetUins');
  }

  const bkn = computeBkn(cred.pskey || cred.skey);
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${bkn}`;
  const bodyParams = new URLSearchParams({
    syn_tweet_verson: '1',
    paramstr: '1',
    pic_template: '',
    richtype: richvals.length > 0 ? '1' : '',
    richval: richvals.join('\t'),
    special_url: '',
    subrichtype: '',
    con: content,
    feedversion: '1',
    ver: '1',
    ugc_right: String(ugcRight),
    to_sign: '0',
    who: '1',
    hostuin: cred.uin,
    code_version: '1',
    format: 'json',
    qzreferrer: `https://user.qzone.qq.com/${cred.uin}`,
  });
  if (needsTargets && targets.length > 0) bodyParams.set('allow_uins', targets.join('|'));

  const text = await webRequestText(url, {
    method: 'POST',
    cookie: cookieHeader(cred),
    body: bodyParams.toString(),
    headers: {
      Referer: `https://user.qzone.qq.com/${cred.uin}`,
      'User-Agent': WEB_UA,
    },
  });
  const data = parseQzoneJson<RawPublishResponse>(text);

  if (typeof data.code === 'number' && data.code !== 0) {
    throw qzoneCodeError('qzone publish', data.code, data.message);
  }
  const tid = data.t1_tid ?? data.tid;
  if (!tid) {
    throw new Error('发表说说失败：响应缺少 tid');
  }
  return { tid: String(tid), time: Number(data.t1_time ?? data.now ?? 0) };
}
