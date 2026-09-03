/**
 * QQ 空间说说「互动」读取 —— 评论列表 + 点赞列表。
 *
 * QQ 空间没有公开的纯 JSON 互动读取接口（PC/mobile 评论详情接口在多数环境下
 * 实测不可用），社区逆向方案（onebot-qzone）一致的做法是解析 **feeds3 预渲染
 * HTML**：每条动态的 HTML 里内嵌了评论区（`comments-item`）和点赞区
 * （`user-list` / `f-item-passive` 点赞事件）。本模块移植自 onebot-qzone 的
 * `feeds3/` 解析器，数据源与我们仓库 {@link qzone.getQzoneFeeds} 是同一条
 * `feeds3_html_more` 链路。
 *
 * 读取路径（best-effort）：
 *   1. 作者空间 feeds3（scope=1，最近 count 条）—— 主力，查指定说说；
 *   2. 未命中时翻 ic2 `feeds_html_act_all`（start/count 分页，hostuin=作者）。
 *
 * 局限（与 onebot-qzone 相同）：评论区只在「该动态出现的页面 HTML」里内嵌，
 * 深翻页能扩大覆盖但不保证全量；且不保证返回所有评论/点赞 —— 调用方按
 * best-effort 看待即可（导出时缺互动不应中断正文导出）。
 *
 * 安全：feed body 是 JS 对象字面量（非 JSON），经 {@link qzone.parseQzoneCallback}
 * 非执行解析；评论/点赞一律从**数据**正则提取，永不 eval 远程内容。
 */

import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { webRequestText } from './http';
import { parseQzoneCallback } from './qzone';

// ───────────────────────── 归一化形态 ─────────────────────────

/** 一条评论（一级或二级回复，字段对齐 feeds3 HTML 能拿到的全部信息）。 */
export interface QzoneComment {
  /** 评论 id：一级为帖子内楼层序号字符串；二级为合成的 `${root}_r_${floor}_${uin}`。 */
  id: string;
  /** 评论者 QQ。 */
  uin: string;
  nickname: string;
  content: string;
  /** unix 秒（展示文案解析，个别无时间的为 0）。 */
  time: number;
  /** 是否二级回复。 */
  isReply: boolean;
  /** 二级：所属一级评论 id。 */
  parentCommentId?: string;
  /** 二级：回复的目标用户 QQ。 */
  replyToUin?: string;
  /** 二级：回复的目标昵称。 */
  replyToNickname?: string;
  /** 二级：回复的目标评论 id。 */
  replyToCommentId?: string;
  /** 评论内图片 URL。 */
  images: string[];
}

/** 一个点赞用户。 */
export interface QzoneLike {
  uin: string;
  nickname: string;
  /** 点赞时间 unix 秒；纯 user-list 块里没有时为 0，f-item-passive 事件里才有。 */
  time: number;
  /** 个性赞图标 item id；空串 = 普通赞。 */
  customItemId: string;
}

/** 一条说说的互动。 */
export interface QzoneInteraction {
  comments: QzoneComment[];
  likes: QzoneLike[];
}

/** 导出/调用方给出的说说句柄（含时间，供 tid 别名反查）。 */
export interface QzoneInteractionTarget {
  tid: string;
  /** unix 秒。 */
  time: number;
}

// ───────────────────────── HTML 预处理 ─────────────────────────

/** feeds3 JSONP 的 html 字段里残留的 JS 转义（JSON 层双写），还原成字符。 */
function decodeFeedHtml(s: string): string {
  return s.replace(/\\x22/g, '"').replace(/\\x3C/g, '<').replace(/\\\//g, '/');
}

/** 统一清理 feeds3 HTML（实体 / 换行 / 空白），为分段正则做准备。 */
export function preprocessHtml(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/>\s+</g, '><')
    .replace(/\\\//g, '/')
    .replace(/\\x27/g, "'");
}

/** 评论正文里剩余的少量实体。 */
function htmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

/** QQ 表情 img → `[em]eXXX[/em]` 占位，然后剥掉其余标签。 */
function stripHtmlTags(html: string): string {
  const withEmoji = html.replace(
    /<img[^>]+src=["'][^"']*\/qzone\/em\/(e\d+)\.[^"']*["'][^>]*>/gi,
    (_m, code: string) => `[em]${code}[/em]`,
  );
  return withEmoji.replace(/<[^>]+>/g, '');
}

// ───────────────────────── feed_data 分段 / canonical tid ─────────────────────────

function dataAttrFromFeedData(attrs: string, name: string): string {
  const m = attrs.match(new RegExp(`data-${name}="([^"]*)"`));
  return m?.[1] ?? '';
}

/** 与说说的 fkey 对齐：纯数字 data-tid 要换成 fkey / 就近 data-key。 */
function canonicalPostTidFromFeedAttrs(
  attrs: string,
  searchBefore: string,
  searchAfterHead: string,
): string {
  const tid = dataAttrFromFeedData(attrs, 'tid') || dataAttrFromFeedData(attrs, 'origtid');
  if (!tid || tid === 'advertisement_app') return '';
  if (/^\d+$/.test(tid)) {
    const fkey = dataAttrFromFeedData(attrs, 'fkey');
    if (fkey) return fkey;
    const combined = `${searchBefore} ${attrs} ${searchAfterHead}`;
    let keyMatch = combined.match(/data-key="([a-z0-9]{6,})"/i);
    if (!keyMatch) keyMatch = combined.match(/key:\s*['"]([a-z0-9]{6,})['"]/i);
    if (keyMatch) return keyMatch[1]!;
  }
  return tid;
}

// ───────────────────────── 评论解析 ─────────────────────────

interface CommentRecord {
  commentid: string;
  uin: string;
  name: string;
  content: string;
  createtime: number;
  isReply: boolean;
  parentCommentId?: string;
  replyToUin?: string;
  replyToNickname?: string;
  replyToCommentId?: string;
  pic: string[];
}

/** 评论块内所有 t1_tid= 取值（校验评论归属，防相邻动态评论区滑入）。 */
function t1TidsInSnippet(snippet: string): string[] {
  const out: string[] = [];
  const re = /t1_tid=([^&"'<>\s]+)/gi;
  for (let m = re.exec(snippet); m !== null; m = re.exec(snippet)) {
    const v = m[1]!.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 评论块串帖防护。块里出现「像真实帖子 tid」的锚点（长 hex 或 d{uin}_{time}_…）
 * 时做归属校验，防上一条动态的评论区滑入本段：
 *  - hex 锚点必须等于本段 canonical tid（hex vs hex 直接对不上 = 串帖）；
 *  - d{uin}_{time}_… 形态锚点是说说的**别名 key**（真机常见），给出段上下文
 *    （作者 uin + 发表 abstime）时按作者/时间对上段即视为本段；无上下文时
 *    只能接受与帖 tid 全等。占位/短串不启用过滤。
 */
function commentBlockMatchesPost(
  fullBlock: string,
  fixedPostTid: string,
  ctx?: { authorUin?: string; abstime?: number },
): boolean {
  const t1s = t1TidsInSnippet(fullBlock);
  if (t1s.length === 0) return true;
  const isHexTid = (t: string): boolean => /^[a-f0-9]{16,}$/i.test(t);
  const isDForm = (t: string): boolean => /^d\d+_\d+_/i.test(t);
  const relevant = t1s.filter((t) => isHexTid(t) || isDForm(t));
  if (relevant.length === 0) return true;
  for (const t of new Set(relevant)) {
    if (t === fixedPostTid) continue;
    if (isHexTid(t)) return false; // hex 与帖 tid 不一致 = 串帖
    if (isDForm(t) && ctx) {
      const m = t.match(/^d(\d+)_(\d+)_/);
      const authorOk = !ctx.authorUin || m?.[1] === ctx.authorUin;
      const timeOk = !ctx.abstime || (m?.[2] ?? '') === String(ctx.abstime);
      if (authorOk && timeOk) continue;
    }
    return false;
  }
  return true;
}

/** 回复目标昵称：`{昵称} 回复<a class="nickname">{目标}</a> : 内容` 两种形态。 */
function extractReplyToNickname(body: string): string | null {
  const htmlPattern =
    /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>(?:&nbsp;|\s)*回复(?:&nbsp;|\s)*<a[^>]*class="[^"]*nickname[^"]*"[^>]*>([^<]+)<\/a>/i;
  const htmlMatch = body.match(htmlPattern);
  if (htmlMatch) return htmlUnescape(htmlMatch[1]!.trim());
  const textPattern = /回复\s*[@＠]([^:：\s]+)/i;
  const textMatch = body.match(textPattern);
  if (textMatch) return htmlUnescape(textMatch[1]!.trim());
  return null;
}

/** 评论内容里应排除的图片（表情 / 头像 / 装饰）。 */
const COMMENT_IMG_EXCLUDED = [
  /qzonestyle\.gtimg\.cn\/qzone\/em\//,
  /qzonestyle\.gtimg\.cn\/qzone\/space\//,
  /\/ac\/b\.gif$/,
  /qlogo\.cn/,
  /qzapp\.qlogo\.cn/,
  /qzonestyle\.gtimg\.cn\/act/,
];

const isUserPic = (u: string): boolean =>
  u.startsWith('http') && !COMMENT_IMG_EXCLUDED.some((p) => p.test(u));

/** <img> 各形态 src 属性里 qpic / photo.store 的用户图。 */
function extractImagesFromCommentHtml(html: string): string[] {
  const urls: string[] = [];
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const candidates = [
      tag.match(/\bsrc=["']([^"']+)["']/i)?.[1],
      tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1],
      tag.match(/\bdata-original=["']([^"']+)["']/i)?.[1],
      tag.match(/\b(?:lz-src|lazy-src)=["']([^"']+)["']/i)?.[1],
    ];
    for (const url of candidates) {
      if (!url || urls.includes(url)) continue;
      if ((url.includes('qpic.cn') || url.includes('photo.store.qq.com')) && isUserPic(url)) {
        urls.push(url);
      }
    }
  }
  return urls;
}

/** `<a class="img-item" data-pickey="tid,高清URL">`（评论纯图常见）。 */
function extractPicUrlsFromDataPickey(html: string): string[] {
  const urls: string[] = [];
  const re = /data-pickey="([^,]+),([^"]+)"/gi;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const url = m[2]!.trim();
    if (!url.startsWith('http') || !isUserPic(url)) continue;
    if ((url.includes('qpic.cn') || url.includes('photo.store.qq.com')) && !urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

/** 评论图也可能直接挂在 `<a href="https://…">` 上。 */
function extractPicUrlsFromImageAnchors(html: string): string[] {
  const urls: string[] = [];
  const re = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const url = m[1]!;
    if (!isUserPic(url)) continue;
    if ((url.includes('qpic.cn') || url.includes('photo.store.qq.com')) && !urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

function extractQpicUrlsFromText(html: string): string[] {
  const urls: string[] = [];
  const pattern =
    /https?:\/\/[^"'\s<>]*qpic\.cn\/[^"'\s<>]+|https?:\/\/[^"'\s<>]*photo\.store\.qq\.com\/[^"'\s<>]+/gi;
  for (let m = pattern.exec(html); m !== null; m = pattern.exec(html)) {
    const url = m[0];
    if (isUserPic(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/** CSS background-image 中的相册图（个别评论卡用 div + 背景图）。 */
function extractPicUrlsFromBackgroundImage(html: string): string[] {
  const urls: string[] = [];
  const re = /url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/gi;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const url = m[1]!.trim();
    if (!isUserPic(url)) continue;
    if ((url.includes('qpic.cn') || url.includes('photo.store.qq.com')) && !urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

/** comments-thumbnails 块内的图。 */
function extractImagesFromCommentThumbnails(body: string): string[] {
  const startIdx = body.search(/<div[^>]*class="[^"]*comments-thumbnails[^"]*"/i);
  if (startIdx < 0) return [];
  const afterOpen = body.indexOf('>', startIdx) + 1;
  const endIdx = body.indexOf('<div', afterOpen);
  const block =
    endIdx > afterOpen ? body.slice(afterOpen, endIdx) : body.slice(afterOpen, afterOpen + 3000);
  const urls = extractImagesFromCommentHtml(block);
  if (urls.length === 0) {
    for (const u of extractQpicUrlsFromText(block)) if (!urls.includes(u)) urls.push(u);
  }
  return urls;
}

/** 截到 comments-op 为止，避免把操作条（回复/时间）卷进正文。 */
function truncateAtCommentsOp(html: string): string {
  const opMatch = html.match(/<div\s+class="[^"]*comments-op[^"]*"/i);
  if (!opMatch) return html;
  let truncated = html.slice(0, opMatch.index);
  const lastLt = truncated.lastIndexOf('<');
  if (lastLt >= 0) {
    const afterLt = truncated.slice(lastLt);
    const looksLikeTag = /^<[a-zA-Z/]/.test(afterLt);
    const hasClose = afterLt.includes('>');
    if (looksLikeTag && !hasClose) truncated = truncated.slice(0, lastLt);
  }
  return truncated;
}

/** 从评论 li 的 body 中取出「昵称:内容」片段（区分一级 / 二级回复形态）。 */
function getCommentContentFragment(body: string, isReply: boolean): string | null {
  if (isReply) {
    const replyPattern =
      /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>(?:&nbsp;|\s)*回复(?:\s*<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>)(?:&nbsp;|\s)*[:：](?:&nbsp;|\s)*([\s\S]*?)(?:<div\s+class="comments-op|<div\s+class="mod-comments-sub|$)/i;
    const replyMatch = body.match(replyPattern);
    if (replyMatch) return truncateAtCommentsOp(replyMatch[1]!);
    // 自己回复自己没有「回复 xx」字样，形态同一级评论，落到下面 root 处理。
  }
  const rootPattern =
    /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>(?:&nbsp;|\s)*[:：](?:&nbsp;|\s)*([\s\S]*?)(?:<div\s+class="comments-op|<div\s+class="mod-comments-sub|<\/div>\s*<div|$)/i;
  const rootMatch = body.match(rootPattern);
  if (rootMatch) return truncateAtCommentsOp(rootMatch[1]!);
  const loosePattern = /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>\s*[:：]\s*([^<]+)/i;
  const looseMatch = body.match(loosePattern);
  if (looseMatch) return looseMatch[1]!.trim();
  const contentPattern =
    /<div[^>]*class="[^"]*comments-content[^"]*"[^>]*>[\s\S]*?<\/a>\s*[:：]\s*([^<]+(?:<[^>]+>[^<]*)*)/i;
  const contentMatch = body.match(contentPattern);
  if (contentMatch) return truncateAtCommentsOp(contentMatch[1]!);
  return null;
}

function extractCommentContentAndImages(
  body: string,
  isReply: boolean,
): { content: string; pic: string[] } {
  const fragment = getCommentContentFragment(body, isReply);
  const content = fragment ? htmlUnescape(stripHtmlTags(fragment)).trim() : '';
  const pic: string[] = [];
  if (fragment) for (const u of extractImagesFromCommentHtml(fragment)) pic.push(u);
  const extras = [
    ...extractImagesFromCommentHtml(body),
    ...extractImagesFromCommentThumbnails(body),
    ...extractPicUrlsFromDataPickey(body),
    ...extractPicUrlsFromImageAnchors(body),
  ];
  for (const u of extras) if (!pic.includes(u)) pic.push(u);
  if (pic.length === 0) {
    for (const u of extractQpicUrlsFromText(body)) if (!pic.includes(u)) pic.push(u);
    for (const u of extractPicUrlsFromBackgroundImage(body)) if (!pic.includes(u)) pic.push(u);
  }
  return { content, pic };
}

/** 评论时间：优先 unix 参数（abstime/createtime…），再解析「昨天 18:36」等文案。 */
function parseCommentTime(body: string, widerContext = ''): number {
  const hay = `${body}\n${widerContext}`;
  const unix = (nRaw: string): number => {
    let n = parseInt(nRaw, 10);
    if (n > 1e12) n = Math.floor(n / 1000);
    return n > 1e8 && n < 2e10 ? n : 0;
  };
  const unixM = hay.match(/(?:^|[?&])(?:abstime|createtime|ctime|pubtime|oper_time)=(\d{9,13})\b/i);
  if (unixM) {
    const n = unix(unixM[1]!);
    if (n) return n;
  }
  const dataM = hay.match(/data-(?:time|ct|ts|opertime|seconds)="(\d{9,13})"/i);
  if (dataM) {
    const n = unix(dataM[1]!);
    if (n) return n;
  }
  const timeMatch = body.match(/class="[^"]*\bstate\b[^"]*"[^>]*>\s*([^<]+)/);
  if (!timeMatch) return 0;
  const ts = timeMatch[1]!.trim();
  const d = new Date();
  const hm = ts.match(/(\d{1,2}):(\d{2})/);
  if (hm) {
    if (ts.includes('昨天')) d.setDate(d.getDate() - 1);
    else if (ts.includes('前天')) d.setDate(d.getDate() - 2);
    d.setHours(parseInt(hm[1]!, 10), parseInt(hm[2]!, 10), 0, 0);
    return Math.floor(d.getTime() / 1000);
  }
  const md = ts.match(/(\d{1,2})[-月](\d{1,2})/);
  if (md) {
    d.setMonth(parseInt(md[1]!, 10) - 1, parseInt(md[2]!, 10));
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }
  const ymd = ts.match(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})/);
  if (ymd) {
    d.setFullYear(parseInt(ymd[1]!, 10), parseInt(ymd[2]!, 10) - 1, parseInt(ymd[3]!, 10));
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }
  return 0;
}

/** 从 start 起找到与当前 comments-item <li> 平衡的 </li>（只计同类 li，防越界到 feed li）。 */
function findMatchingClosingCommentsItemLi(text: string, start: number): number {
  const liCommentsOpen = /<li\s+class="comments-item/g;
  let depth = 1;
  let pos = start;
  while (depth > 0 && pos < text.length) {
    const nextClose = text.indexOf('</li>', pos);
    if (nextClose < 0) return -1;
    liCommentsOpen.lastIndex = pos;
    const openMatch = liCommentsOpen.exec(text);
    const nextOpen = openMatch !== null && openMatch.index < nextClose ? openMatch.index : -1;
    if (nextOpen >= 0) {
      depth += 1;
      pos = nextOpen + 1;
    } else {
      depth -= 1;
      if (depth === 0) return nextClose + 6;
      pos = nextClose + 1;
    }
  }
  return -1;
}

/** 一条一级评论的记录（含 reply 后缀展开），解析落在哪个 bucket 由调用方决定。 */
function pushCommentRecord(
  bucket: CommentRecord[],
  record: CommentRecord,
  seen: Set<string>,
): void {
  if (seen.has(record.commentid)) return;
  seen.add(record.commentid);
  bucket.push(record);
}

/** 把一段 region（单条动态 HTML 或纯评论片段）里的全部评论解析进 bucket。 */
function parseFeeds3CommentsInRegion(
  region: string,
  fixedPostTid: string,
  ctx?: { authorUin?: string; abstime?: number },
): CommentRecord[] {
  const bucket: CommentRecord[] = [];
  const rootCommentPat = /<li\s+class="comments-item[^"]*"[^>]*data-type="commentroot"[^>]*>/gi;
  for (
    let rootMatch = rootCommentPat.exec(region);
    rootMatch !== null;
    rootMatch = rootCommentPat.exec(region)
  ) {
    const openTag = rootMatch[0];
    const openEnd = rootMatch.index + openTag.length;
    const closeEnd = findMatchingClosingCommentsItemLi(region, openEnd);
    if (closeEnd < 0) continue;
    const fullBlock = region.slice(rootMatch.index, closeEnd);
    if (!commentBlockMatchesPost(fullBlock, fixedPostTid, ctx)) continue;
    const body = region.slice(openEnd, closeEnd - 6);

    const rootTid = openTag.match(/data-tid="([^"]*)"/)?.[1] ?? '';
    const rootUin = openTag.match(/data-uin="([^"]*)"/)?.[1] ?? '';
    const rootNick = openTag.match(/data-nick="([^"]*)"/)?.[1] ?? '';
    if (!rootTid) continue;

    const { content: rootContent, pic: rootPic } = extractCommentContentAndImages(body, false);
    const rootTime = parseCommentTime(body, fullBlock);
    const rootComment: CommentRecord = {
      commentid: rootTid,
      uin: rootUin,
      name: rootNick,
      content: rootContent,
      createtime: rootTime,
      isReply: false,
      pic: rootPic,
    };
    bucket.push(rootComment);

    const subCommentsPat =
      /<div[^>]*class="[^"]*mod-comments-sub[^"]*"[^>]*>[\s\S]*?<ul>([\s\S]*?)<\/ul>[\s\S]*?<\/div>/gi;
    for (
      let subBlockMatch = subCommentsPat.exec(fullBlock);
      subBlockMatch !== null;
      subBlockMatch = subCommentsPat.exec(fullBlock)
    ) {
      const subUl = subBlockMatch[1]!;
      const replyPat = /<li\s+class="comments-item[^"]*"[^>]*data-type="replyroot"[^>]*>/gi;
      for (
        let replyMatch = replyPat.exec(subUl);
        replyMatch !== null;
        replyMatch = replyPat.exec(subUl)
      ) {
        const replyOpenTag = replyMatch[0];
        const replyOpenEnd = replyMatch.index + replyOpenTag.length;
        const replyCloseEnd = findMatchingClosingCommentsItemLi(subUl, replyOpenEnd);
        if (replyCloseEnd < 0) continue;
        const replyBody = subUl.slice(replyOpenEnd, replyCloseEnd - 6);
        const replyTid = replyOpenTag.match(/data-tid="([^"]*)"/)?.[1] ?? '';
        const replyUin = replyOpenTag.match(/data-uin="([^"]*)"/)?.[1] ?? '';
        const replyNick = replyOpenTag.match(/data-nick="([^"]*)"/)?.[1] ?? '';
        if (!replyTid) continue;

        const t2Uin = replyBody.match(/t2_uin=(\d+)/i)?.[1] ?? '';
        const t2Tid = replyBody.match(/t2_tid=([^&"\s]+)/i)?.[1] ?? '';
        const replyToNickname = extractReplyToNickname(replyBody);
        const { content: replyContent, pic: replyPic } = extractCommentContentAndImages(
          replyBody,
          true,
        );
        const replyTime = parseCommentTime(replyBody, fullBlock);
        const replyRecord: CommentRecord = {
          // 与 onebot-qzone 相同：二级回复没有独立 id，按根楼层合成防撞。
          commentid: t2Tid
            ? `${rootTid}_r_${replyTid}_${replyUin}`
            : `${rootTid}_${replyTid}_${replyUin}`,
          uin: replyUin,
          name: replyNick,
          content: replyContent,
          createtime: replyTime,
          isReply: true,
          parentCommentId: rootTid,
          pic: replyPic,
        };
        if (t2Uin) replyRecord.replyToUin = t2Uin;
        if (replyToNickname) replyRecord.replyToNickname = replyToNickname;
        if (t2Tid) replyRecord.replyToCommentId = t2Tid;
        bucket.push(replyRecord);
      }
    }
  }

  // 兼容无 data-type 的旧式评论 li（data-tid/data-uin/data-nick 仍在）。
  const legacyCommentPat = /<li\s+class="comments-item[^"]*"([^>]*)>/g;
  for (
    let legacyMatch = legacyCommentPat.exec(region);
    legacyMatch !== null;
    legacyMatch = legacyCommentPat.exec(region)
  ) {
    const attrs = legacyMatch[1]!;
    if (attrs.includes('data-type="commentroot"') || attrs.includes('data-type="replyroot"')) {
      continue;
    }
    const openEnd = legacyMatch.index + legacyMatch[0].length;
    const closeEnd = findMatchingClosingCommentsItemLi(region, openEnd);
    if (closeEnd < 0) continue;
    const legacyFull = region.slice(legacyMatch.index, closeEnd);
    if (!commentBlockMatchesPost(legacyFull, fixedPostTid, ctx)) continue;
    const body = region.slice(openEnd, closeEnd - 6);
    const commentId = attrs.match(/data-tid="([^"]*)"/)?.[1] ?? '';
    const uin = attrs.match(/data-uin="([^"]*)"/)?.[1] ?? '';
    const nick = attrs.match(/data-nick="([^"]*)"/)?.[1] ?? '';
    if (!commentId) continue;
    const isReply = body.includes('回复');
    const { content, pic } = extractCommentContentAndImages(body, isReply);
    const createdTime = parseCommentTime(body, legacyFull);
    const record: CommentRecord = {
      commentid: commentId,
      uin,
      name: nick,
      content,
      createtime: createdTime,
      isReply,
      pic,
    };
    const t2Uin = body.match(/t2_uin=(\d+)/i)?.[1] ?? '';
    const t2Tid = body.match(/t2_tid=([^&"\s]+)/i)?.[1] ?? '';
    const replyToNickname = isReply ? extractReplyToNickname(body) : null;
    if (isReply) {
      if (t2Uin) record.replyToUin = t2Uin;
      if (replyToNickname) record.replyToNickname = replyToNickname;
      if (t2Tid) record.replyToCommentId = t2Tid;
    }
    bucket.push(record);
  }
  // 去重（root 与 legacy 可能重复扫到同一块）
  const deduped: CommentRecord[] = [];
  const seen = new Set<string>();
  for (const c of bucket) pushCommentRecord(deduped, c, seen);
  return deduped;
}

/**
 * 按 `name="feed_data"` 分段解析评论区：每条动态的评论只归入该段对应的
 * canonical tid（与说说列表的 fkey 对齐），避免全文按 t1_tid 猜帖主串桶。
 * @param processedText preprocessHtml 之后 / decode 之后的整页 HTML。
 */
export function parseFeeds3CommentsScoped(processedText: string): Map<string, CommentRecord[]> {
  const result = new Map<string, CommentRecord[]>();
  const feedDataPat = /name="feed_data"\s*([^>]*)>/g;
  const matches: Array<{ index: number; attrs: string }> = [];
  for (
    let fm = feedDataPat.exec(processedText);
    fm !== null;
    fm = feedDataPat.exec(processedText)
  ) {
    matches.push({ index: fm.index, attrs: fm[1]! });
  }
  if (matches.length === 0) return result;
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i]!.index;
    const end = i + 1 < matches.length ? matches[i + 1]!.index : processedText.length;
    const region = processedText.slice(start, end);
    const prevFdPos = i > 0 ? matches[i - 1]!.index : -1;
    const beforeStart =
      prevFdPos >= 0 ? Math.max(prevFdPos, start - 8000) : Math.max(0, start - 8000);
    const canonical = canonicalPostTidFromFeedAttrs(
      matches[i]!.attrs,
      processedText.slice(beforeStart, start),
      region.slice(0, 4000),
    );
    if (!canonical) continue;
    const ctx = {
      authorUin: dataAttrFromFeedData(matches[i]!.attrs, 'uin'),
      abstime: Number(dataAttrFromFeedData(matches[i]!.attrs, 'abstime')) || undefined,
    };
    const list = parseFeeds3CommentsInRegion(region, canonical, ctx);
    if (list.length === 0) continue;
    if (!result.has(canonical)) result.set(canonical, []);
    const dest = result.get(canonical)!;
    const seen = new Set(dest.map((c) => c.commentid));
    for (const c of list) pushCommentRecord(dest, c, seen);
  }
  return result;
}

/**
 * 主入口：从 feeds3 HTML 提取「评论桶」Map<postTid, comments>。
 * 有 feed_data 分段走 scoped；否则退回全文扫描 + 就近 t1_tid 推断
 * （兼容纯评论片段 / 测试夹具）。
 */
export function parseFeeds3Comments(text: string): Map<string, CommentRecord[]> {
  const processed = preprocessHtml(text);
  const scoped = parseFeeds3CommentsScoped(processed);
  if (scoped.size > 0) return scoped;

  // ── 兜底：全文扫 commentroot，帖主 tid = 块内「真实」t1_tid 或此前最近一条 ──
  const result = new Map<string, CommentRecord[]>();
  const tidRefs: Array<{ index: number; postTid: string }> = [];
  const t1Re = /t1_tid=([^&"'<>\s]+)/gi;
  for (let t1m = t1Re.exec(processed); t1m !== null; t1m = t1Re.exec(processed)) {
    const v = t1m[1]!.trim();
    if (v) tidRefs.push({ index: t1m.index, postTid: v });
  }
  const rootCommentPat = /<li\s+class="comments-item[^"]*"[^>]*data-type="commentroot"[^>]*>/gi;
  for (
    let rootMatch = rootCommentPat.exec(processed);
    rootMatch !== null;
    rootMatch = rootCommentPat.exec(processed)
  ) {
    const openTag = rootMatch[0];
    const openEnd = rootMatch.index + openTag.length;
    const closeEnd = findMatchingClosingCommentsItemLi(processed, openEnd);
    if (closeEnd < 0) continue;
    const fullBlock = processed.slice(rootMatch.index, closeEnd);
    const inBlock = t1TidsInSnippet(fullBlock);
    let postTid =
      inBlock.find((t) => /^[a-f0-9]{16,}$/i.test(t) || /^d\d+_\d+_/i.test(t)) ?? inBlock[0];
    if (!postTid) {
      const prev = tidRefs.filter((r) => r.index < rootMatch!.index);
      postTid = prev.length > 0 ? prev[prev.length - 1]!.postTid : '';
    }
    if (!postTid) continue;
    if (!commentBlockMatchesPost(fullBlock, postTid)) continue;
    if (!result.has(postTid)) result.set(postTid, []);
    const list = parseFeeds3CommentsInRegion(fullBlock, postTid, { authorUin: undefined });
    for (const c of list) {
      const dest = result.get(postTid)!;
      const s = new Set(dest.map((d) => d.commentid));
      pushCommentRecord(dest, c, s);
    }
  }
  return result;
}

// ───────────────────────── 点赞解析 ─────────────────────────

export interface Feeds3LikeRecord {
  uin: string;
  nickname: string;
  tid: string;
  ownerUin: string;
  abstime: number;
  customItemId: string;
}

/** 一条动态 HTML 块里的 user-list（「N 人觉得很赞」内的人名链接）。 */
function parseSinglePostLikes(html: string, tid: string, ownerUin: string): Feeds3LikeRecord[] {
  const likes: Feeds3LikeRecord[] = [];
  const userListMatch = html.match(/class="user-list"[^>]*>([\s\S]*?)<\/div>/i);
  if (!userListMatch) return likes;
  const linkPattern = /<a[^>]*href="http:\/\/user\.qzone\.qq\.com\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (
    let m = linkPattern.exec(userListMatch[1]!);
    m !== null;
    m = linkPattern.exec(userListMatch[1]!)
  ) {
    const uin = m[1]!;
    const nickname = htmlUnescape(
      m[2]!
        .replace(/<[^>]+>/g, '')
        .replace(/、/g, '')
        .trim(),
    );
    if (uin && nickname) {
      likes.push({
        uin,
        nickname,
        tid,
        ownerUin,
        abstime: 0,
        customItemId: '',
      });
    }
  }
  return likes;
}

/**
 * 从 feeds3 HTML 提取点赞：① user-list 人名链接；② `f-item-passive` 的
 * feedstype=101「XX 赞了这条动态」事件（带 data-abstime / data-custom_itemid）。
 * 返回 Map<postTid, likes>（按 uin 去重，保留最晚时间）。
 */
export function parseFeeds3Likes(text: string): Map<string, Feeds3LikeRecord[]> {
  const processed = preprocessHtml(text);
  const result = new Map<string, Feeds3LikeRecord[]>();

  const tidPositions: Array<{ index: number; postTid: string }> = [];
  const t1Re = /t1_tid=([^&"'<>\s]+)/gi;
  for (let t1m = t1Re.exec(processed); t1m !== null; t1m = t1Re.exec(processed)) {
    const v = t1m[1]!.trim();
    if (v) tidPositions.push({ index: t1m.index, postTid: v });
  }
  for (let i = 0; i < tidPositions.length; i += 1) {
    const tid = tidPositions[i]!.postTid;
    const startIdx = tidPositions[i]!.index;
    const endIdx = i < tidPositions.length - 1 ? tidPositions[i + 1]!.index : processed.length;
    const block = processed.slice(startIdx, endIdx);
    if (block.includes('user-list')) {
      const ownerMatch = block.match(/t1_uin=(\d+)/);
      const ownerUin = ownerMatch?.[1] ?? '';
      const likes = parseSinglePostLikes(block, tid, ownerUin);
      if (likes.length > 0) result.set(tid, likes);
    }
  }

  const feedItemPat =
    /<div\s+class="f-item[^"]*f-item-passive"\s+id="feed_(\d+)_(\d+)_(\d+)_(\d+)_\d+_\d+"[\s\S]*?name="feed_data"\s*([^>]*)>[\s\S]*?(?=<div\s+class="f-item|<\/ul>|$)/g;
  const dataAttr = (attrs: string, name: string): string => {
    const m = attrs.match(new RegExp(`data-${name}="([^"]*)"`));
    return m?.[1] ?? '';
  };
  for (let fm = feedItemPat.exec(processed); fm !== null; fm = feedItemPat.exec(processed)) {
    const feedDataAttrs = fm[5]!;
    if (dataAttr(feedDataAttrs, 'feedstype') !== '101') continue;
    const likerUin = fm[1]!;
    const tidRaw = dataAttr(feedDataAttrs, 'tid');
    const ownerUin = dataAttr(feedDataAttrs, 'uin');
    const abstime = parseInt(dataAttr(feedDataAttrs, 'abstime') || '0', 10);
    if (!tidRaw || !likerUin || likerUin === '0') continue;
    const searchBefore = processed.substring(Math.max(0, fm.index - 8000), fm.index);
    const tid =
      canonicalPostTidFromFeedAttrs(feedDataAttrs, searchBefore, fm[0].slice(0, 4000)) || tidRaw;
    const blockStart = Math.max(0, fm.index - 600);
    const preceding = processed.substring(blockStart, fm.index);
    let nickname = '';
    const nickMatch = preceding.match(/link="nameCard_\d+"[^>]*>([^<]+)<\/a>/);
    if (nickMatch) nickname = htmlUnescape(nickMatch[1]!.trim());
    const customMatch = fm[0].match(/data-custom_itemid="(\d+)"/);
    const like: Feeds3LikeRecord = {
      uin: likerUin,
      nickname,
      tid,
      ownerUin,
      abstime,
      customItemId: customMatch?.[1] ?? '',
    };
    if (!result.has(tid)) result.set(tid, []);
    // 无条件入桶：passive 记录带 abstime/custom_itemid，比 user-list 的
    // 占位记录信息更全，末尾按 abstime 去重会保留更优的那条。
    result.get(tid)!.push(like);
  }

  for (const [tid, likes] of result) {
    const byUin = new Map<string, Feeds3LikeRecord>();
    for (const like of likes) {
      const existing = byUin.get(like.uin);
      if (!existing || like.abstime > existing.abstime) byUin.set(like.uin, like);
    }
    result.set(tid, [...byUin.values()]);
  }
  return result;
}

// ───────────────────────── 归一化：桶 → QzoneComment/QzoneLike ─────────────────────────

function toQzoneComment(c: CommentRecord): QzoneComment {
  const out: QzoneComment = {
    id: c.commentid,
    uin: c.uin,
    nickname: c.name,
    content: c.content,
    time: c.createtime,
    isReply: c.isReply,
    images: c.pic,
  };
  if (c.parentCommentId !== undefined) out.parentCommentId = c.parentCommentId;
  if (c.replyToUin) out.replyToUin = c.replyToUin;
  if (c.replyToNickname) out.replyToNickname = c.replyToNickname;
  if (c.replyToCommentId) out.replyToCommentId = c.replyToCommentId;
  return out;
}

function toQzoneLike(l: Feeds3LikeRecord): QzoneLike {
  return { uin: l.uin, nickname: l.nickname, time: l.abstime, customItemId: l.customItemId };
}

// ───────────────────────── 拉取（feeds3_html_more scope=1 / feeds_html_act_all） ─────────────────────────

interface RawFeedsData {
  code?: number;
  message?: string;
  data?: { data?: Array<{ html?: string }> | null };
}

/** 判定「票据不对」—— 与 qzone.ts 同一套，好让 withRetry 换票重试。 */
const AUTH_CODES = new Set([-3000, -10000]);

function qzoneCodeError(what: string, code: number, message?: string): Error {
  const msg = `${what} failed: code=${code} ${message ?? ''}`.trim();
  return AUTH_CODES.has(code) ? new WebAuthError(msg, code) : new Error(msg);
}

/** 非执行解析 feeds3 JSONP body 并把每条 html 拼成一个整页 HTML。 */
async function fetchFeeds3HtmlPage(
  cred: WebCredential,
  uin: string,
  scope: number,
  count: number,
  extra: Record<string, string>,
): Promise<string> {
  const gtk = computeBkn(cred.pskey || cred.skey);
  const params = new URLSearchParams({
    uin,
    scope: String(scope),
    view: '1',
    filter: 'all',
    applist: 'all',
    flag: '1',
    pagenum: '1',
    aisortEndTime: '0',
    aisortOffset: '0',
    aisortBeginTime: '0',
    begintime: '0',
    count: String(count),
    g_tk: String(gtk),
    useutf8: '1',
    outputhtmlfeed: '1',
    format: 'json',
    callback: '_preloadCallback',
    ...extra,
  });
  const url = `https://h5.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?${params.toString()}`;
  const text = await webRequestText(url, {
    method: 'GET',
    cookie: cookieHeader(cred),
    headers: { Referer: `https://user.qzone.qq.com/${uin}` },
  });
  const data = parseQzoneCallback<RawFeedsData>(text);
  if (typeof data.code === 'number' && data.code !== 0) {
    throw qzoneCodeError('qzone feeds3 interaction', data.code, data.message);
  }
  const items = data.data?.data;
  if (!Array.isArray(items)) {
    throw new Error(`无法获取空间动态(互动读取): ${text.slice(0, 200)}`);
  }
  return items.map((i) => decodeFeedHtml(i?.html ?? '')).join('');
}

/** ic2 `feeds_html_act_all` 分页（浏览器「全部动态」链路），返回整页 HTML。 */
async function fetchFeedsActAllHtml(
  cred: WebCredential,
  pageUin: string,
  hostUin: string,
  start: number,
  count: number,
): Promise<string> {
  const gtk = computeBkn(cred.pskey || cred.skey);
  const params = new URLSearchParams({
    uin: pageUin,
    hostuin: hostUin,
    scope: '0',
    filter: 'all',
    flag: '1',
    refresh: '0',
    firstGetGroup: '0',
    mixnocache: '0',
    scene: '0',
    start: String(start),
    count: String(count),
    sidomain: 'qzonestyle.gtimg.cn',
    useutf8: '1',
    outputhtmlfeed: '1',
    refer: '2',
    r: String(Math.random()),
    g_tk: String(gtk),
  });
  const url = `https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds_html_act_all?${params.toString()}`;
  const text = await webRequestText(url, {
    method: 'GET',
    cookie: cookieHeader(cred),
    headers: { Referer: `https://user.qzone.qq.com/${hostUin}` },
  });
  const data = parseQzoneCallback<RawFeedsData>(text);
  if (typeof data.code === 'number' && data.code !== 0) {
    throw qzoneCodeError('qzone feeds_html_act_all', data.code, data.message);
  }
  const items = data.data?.data;
  if (!Array.isArray(items)) {
    throw new Error(`无法获取空间动态(act_all): ${text.slice(0, 200)}`);
  }
  return items.map((i) => decodeFeedHtml(i?.html ?? '')).join('');
}

// ───────────────────────── 批量收集 + tid 解析 ─────────────────────────

interface InteractionBuckets {
  comments: Map<string, CommentRecord[]>;
  likes: Map<string, Feeds3LikeRecord[]>;
}

function parseIntoBuckets(html: string, buckets: InteractionBuckets): void {
  for (const [tid, list] of parseFeeds3Comments(html)) {
    const existing = buckets.comments.get(tid);
    if (existing) {
      const seen = new Set(existing.map((c) => c.commentid));
      for (const c of list) if (!seen.has(c.commentid)) existing.push(c);
    } else {
      buckets.comments.set(tid, list);
    }
  }
  for (const [tid, list] of parseFeeds3Likes(html)) {
    const existing = buckets.likes.get(tid);
    if (existing) {
      const byUin = new Map(existing.map((l) => [l.uin, l]));
      for (const like of list) {
        const cur = byUin.get(like.uin);
        if (!cur || like.abstime >= cur.abstime) byUin.set(like.uin, like);
      }
      buckets.likes.set(
        tid,
        [...byUin.values()].map((l) => l),
      );
    } else {
      buckets.likes.set(tid, list);
    }
  }
}

/** act_all 翻页上限：超过即停，避免对远古说说无谓轰炸（评论覆盖是 best-effort）。 */
const ACT_ALL_MAX_PAGES = 20;
const ACT_ALL_PAGE_COUNT = 20;
/** feeds3 作者空间首页拉取条数。 */
const AUTHOR_FEED_COUNT = 50;

function commentTidsOfBuckets(buckets: InteractionBuckets): Set<string> {
  const keys = new Set<string>();
  for (const k of buckets.comments.keys()) keys.add(k);
  for (const k of buckets.likes.keys()) keys.add(k);
  return keys;
}

/**
 * 把请求的说说 tid 解析到桶：先直接相等命中，再按 (作者 uin, 发表时间) 反查
 * feeds3 里 d{uin}_{time}_… 形态的别名桶（说说列表 tid 与 feeds3 html key 偶有出入）。
 */
function resolveBuckets(
  buckets: InteractionBuckets,
  authorUin: string,
  targets: QzoneInteractionTarget[],
): Map<string, QzoneInteraction> {
  const out = new Map<string, QzoneInteraction>();
  const present = commentTidsOfBuckets(buckets);
  for (const t of targets) {
    let comments = buckets.comments.get(t.tid);
    let likes = buckets.likes.get(t.tid);
    const isEmpty = (comments?.length ?? 0) === 0 && (likes?.length ?? 0) === 0;
    if (isEmpty) {
      // 别名反查：在桶键里找同作者、时间窗一致的 key（说说列表 tid 与 feeds3
      // html key 偶有出入：hex fkey ↔ d{uin}_{abstime}_… / 纯数字 tid）。
      let aliasKey = '';
      for (const key of present) {
        if (key === t.tid || (t.time > 0 && key === String(t.time))) {
          aliasKey = key;
          break;
        }
        if (t.time <= 0) continue;
        const embedded = `_${t.time}_`;
        const sameAuthor = key.startsWith(`d${authorUin}_`) || t.tid.includes(String(authorUin));
        if (key.includes(embedded) && sameAuthor) {
          aliasKey = key;
          break;
        }
      }
      if (aliasKey) {
        comments = buckets.comments.get(aliasKey);
        likes = buckets.likes.get(aliasKey);
      }
    }
    out.set(t.tid, {
      comments: (comments ?? []).map(toQzoneComment),
      likes: (likes ?? []).map(toQzoneLike),
    });
  }
  return out;
}

/**
 * Best-effort 批量读取某空间若干说说的评论 + 点赞。
 *
 * 先拉作者空间 feeds3（scope=1，最近 50 条），未命中的说说再翻
 * `feeds_html_act_all` 至多 {@link ACT_ALL_MAX_PAGES} 页。任一页失败即抛错
 * （抛错交给调用方决定：走 withRetry 换票或按 best-effort 降级）。
 */
export async function collectQzoneInteractions(
  cred: WebCredential,
  authorUin: string,
  targets: QzoneInteractionTarget[],
): Promise<Map<string, QzoneInteraction>> {
  if (targets.length === 0) return new Map();
  const buckets: InteractionBuckets = { comments: new Map(), likes: new Map() };

  const first = await fetchFeeds3HtmlPage(cred, authorUin, 1, AUTHOR_FEED_COUNT, {});
  parseIntoBuckets(first, buckets);

  const resolved = resolveBuckets(buckets, authorUin, targets);
  const isMissing = (t: QzoneInteractionTarget): boolean => {
    const r = resolved.get(t.tid);
    return !r || (r.comments.length === 0 && r.likes.length === 0);
  };
  if (targets.every((t) => !isMissing(t))) return resolved;

  // 作者空间首页没覆盖到的说说，翻 feeds_html_act_all 分页兜底（best-effort）。
  for (let page = 0; page < ACT_ALL_MAX_PAGES; page += 1) {
    const stillMissing = targets.filter(isMissing);
    if (stillMissing.length === 0) break;
    const start = page * ACT_ALL_PAGE_COUNT;
    let html: string;
    try {
      html = await fetchFeedsActAllHtml(cred, authorUin, authorUin, start, ACT_ALL_PAGE_COUNT);
    } catch {
      break; // act_all 失败不再纠结：互动是 best-effort，不阻断正文导出
    }
    parseIntoBuckets(html, buckets);
    const got = resolveBuckets(buckets, authorUin, stillMissing);
    for (const t of stillMissing) {
      const r = got.get(t.tid)!;
      resolved.set(t.tid, r);
    }
  }
  return resolved;
}
