/**
 * QQ 空间读接口 — 说说列表 (`taotao.qzone.qq.com/cgi-bin/emotion_cgi_msglist_v6`)
 * 与好友动态 (`ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more`)，都经
 * `h5.qzone.qq.com` 代理网关访问 —— 与群相册列表同一套 cookie/g_tk 通路。
 *
 * Auth: cookie jar + `g_tk = bkn(p_skey || skey)`。`uin` 在 query 里裸传(不带
 * 'o' 前缀),cookie 里的 uin 仍带 'o'(见 {@link cookieHeader})。
 *
 * 这两个 cgi 的响应是 JSONP 包裹(`_preloadCallback({...})`),不能直接走
 * {@link webRequestJson} 的严格 JSON.parse,所以用 {@link webRequestText} 取文本,
 * 再用本文件内的 {@link parseQzoneJson} 容错切片解析。
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

  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_msglist_v6?${new URLSearchParams(
    {
      uin: targetUin,
      // 登录号(查询发起方)。跨号查别人空间时 QZone 靠它判权限,缺了会被风控
      // 甩 `-10000 使用人数过多`。`cred.uin` 是本账号裸 uin(不带 'o')。
      loginUin: cred.uin,
      ftype: '0',
      sort: '0',
      pos: String(pos),
      num: String(num),
      replynum: '100',
      g_tk: String(gtk),
      callback: '_preloadCallback',
      code_version: '1',
      format: 'jsonp',
      need_private_comment: '1',
    },
  ).toString()}`;

  const text = await webRequestText(url, {
    method: 'GET',
    cookie: cookieHeader(cred),
    // QZone 风控会校验 referer 是 qzone 来源,缺了甩 `-10000 使用人数过多`。
    headers: { Referer: `https://user.qzone.qq.com/${targetUin}` },
  });
  const data = parseQzoneJson<RawMsgListRet>(text);

  if (typeof data.code === 'number' && data.code !== 0) {
    throw new Error(`qzone msglist failed: code=${data.code} ${data.message ?? ''}`.trim());
  }
  if (!Array.isArray(data.msglist)) {
    throw new Error('无法获取空间说说列表(可能 cookie 失效或无权限)');
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
  const list = data.data?.data ?? [];
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
  const data = parseQzoneJson<RawFeedsRet>(text);

  if (typeof data.code === 'number' && data.code !== 0) {
    throw new Error(`qzone feeds failed: code=${data.code} ${data.message ?? ''}`.trim());
  }
  if (!Array.isArray(data.data?.data)) {
    throw new Error('无法获取空间好友动态(可能 cookie 失效或无权限)');
  }

  return mapFeeds(data);
}
