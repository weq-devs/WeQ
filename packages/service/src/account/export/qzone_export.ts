/**
 * QQ 空间（说说）导出器 —— 目标可以是好友或自己的空间。
 *
 * 与消息导出流水线不同 —— 数据来自 QQ 空间 Web CGI（`emotion_cgi_msglist_v6`），
 * 而非本地消息库。拉取能力由 deps 注入（service 包不依赖账号服务，照 chatlab
 * deps 的模式），底层 {@link import('../web/qzone').getQzoneMsgList} 需要在线 QQ
 * 的 skey/pskey，离线会抛错 —— 调用方（路由 + 前端 preflight）已先拦截离线。
 *
 * 翻页要点：服务端分页会**重复**返回条目（真机 test 实测），故按 `tid` 去重；
 * 说说按发表时间**倒序**，配合时间范围可提前停止翻页。
 *
 * 产物格式：json / txt / html。HTML 完整渲染：资料头（空间头像 / 昵称）+
 * 说说卡片（表情外链 qzonestyle、配图网格、赞 / 评论数、评论区含回复）。
 * 配图与互动拉取由调用方保证 —— 含 html 时强制下载配图 + 拉取评论 / 点赞。
 */

import { createExportWriter } from './stream_utils';
import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { downloadUrlToFile } from '../media_url';
import type { QzoneEmotion, QzoneMsgListResult } from '../web/qzone';
import type {
  QzoneComment,
  QzoneInteraction,
  QzoneInteractionTarget,
  QzoneLike,
} from '../web/qzone_interaction';
import type { ExportTimeRange } from './types';

/** 注入的说说拉取能力（一页）。 */
export interface QzoneExportDeps {
  fetchMsgList: (targetUin: string, pos: number, num: number) => Promise<QzoneMsgListResult>;
  /**
   * Best-effort 批量读取若干说说的评论 + 点赞（空间动态页 HTML 解析，需在线 QQ）。
   * 可选 —— 未注入时「补全互动」直接跳过。返回 Map<tid, 互动>，缺漏 tid 返回空桶。
   */
  fetchInteractions?: (
    targetUin: string,
    targets: QzoneInteractionTarget[],
  ) => Promise<Map<string, QzoneInteraction>>;
  /**
   * Best-effort 读单条说说的点赞名单（r.qzone qz_opcnt2）。可选 —— 注入后，
   * 「补全互动」会对动态页 HTML 没拿到赞的帖子自动补一轮权威名单（见
   * {@link attachInteractions}）；失败时保留 HTML 结果，不抛错。
   */
  fetchLikes?: (targetUin: string, tid: string) => Promise<QzoneLike[]>;
}

export interface QzoneExportOpts {
  /** 目标空间 uin（好友或自己）。 */
  targetUin: string;
  /** 展示名（写进文件头 / 进度）。 */
  name: string;
  format: 'json' | 'txt' | 'html';
  /** 说说文件输出路径。 */
  outputPath: string;
  /** 传入则下载配图到该 `media/` 目录（否则不下载）。 */
  mediaRoot?: string;
  /** 发表时间窗（unix 秒），null 端开放。 */
  range?: ExportTimeRange;
  /** 拉取进度：已获取去重条数 / 总数 / 说明。 */
  onProgress: (current: number, total: number, note: string) => void;
  /** 补全互动（评论 + 点赞）：拉取说说后按 tid 逐条补。缺 deps.fetchInteractions 时忽略。 */
  includeInteraction?: boolean;
  /** 互动拉取进度。 */
  onInteraction?: (done: number, total: number, note: string) => void;
  /** 配图下载进度。 */
  onMedia?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface QzoneExportResult {
  filePath: string;
  /** 过滤后写入的说说条数。 */
  count: number;
  mediaOk: number;
  mediaFailed: number;
  /** 补全互动开启时的统计（未开启为 undefined）。 */
  interaction?: {
    /** 带互动的说说条数（有评论或有点赞）。 */
    posts: number;
    /** 拉到的一级+二级评论总数。 */
    comments: number;
    /** 拉到的点赞用户总数。 */
    likes: number;
    /** 批量拉取整体失败（互动缺失，正文照常导出）。 */
    failed: boolean;
  };
}

const PAGE_SIZE = 20;
/** 翻页安全上限，防跑飞（每页 20 → 覆盖 2000 条说说）。 */
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 600;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 一条说说是否落在时间窗内。 */
function inRange(e: QzoneEmotion, range?: ExportTimeRange): boolean {
  if (!range) return true;
  if (range.start != null && e.time < range.start) return false;
  if (range.end != null && e.time > range.end) return false;
  return true;
}

/**
 * 翻页拉全某好友的说说（去重）。`pos` 按实际返回条数推进；说说按时间倒序，
 * 有 `range.start` 时一旦本页最旧条目早于窗口起点即提前停止。
 */
async function fetchAllEmotions(
  deps: QzoneExportDeps,
  targetUin: string,
  range: ExportTimeRange | undefined,
  onProgress: (current: number, total: number, note: string) => void,
  signal?: AbortSignal,
): Promise<QzoneEmotion[]> {
  const seen = new Set<string>();
  const all: QzoneEmotion[] = [];
  let total = 0;
  let pos = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal?.aborted) break;
    let res: QzoneMsgListResult;
    try {
      res = await deps.fetchMsgList(targetUin, pos, PAGE_SIZE);
    } catch (e) {
      // pos 翻过头时服务端回结构异常 —— 对翻页而言等价「没有更多了」，优雅停止。
      if (page === 0) throw e; // 首页就失败 → 真错误（离线 / 无权限），上抛
      break;
    }
    total = res.total || total;
    if (res.list.length === 0) break;

    let fresh = 0;
    for (const e of res.list) {
      if (e.tid && !seen.has(e.tid)) {
        seen.add(e.tid);
        all.push(e);
        fresh += 1;
      }
    }
    pos += res.list.length;
    onProgress(
      all.length,
      total || all.length,
      `已获取 ${all.length}${total ? `/${total}` : ''} 条`,
    );

    if (fresh === 0) break; // 整页都是旧条目 → 到底了
    if (total && all.length >= total) break;
    // 倒序早停：本页最旧一条已早于窗口起点，更早的都不要了。
    if (range?.start != null && res.list.every((e) => e.time < range.start!)) break;
    await sleep(PAGE_DELAY_MS);
  }
  return all;
}

/** 秒级时间戳 → `YYYY-MM-DD HH:mm:ss`（本地时区）。 */
function fmtTime(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 带互动字段的说说（导出内部形态，互动的说说在渲染时才读取这两个字段）。 */
interface EmotionWithInteraction extends QzoneEmotion {
  comments?: QzoneComment[];
  likes?: QzoneLike[];
}

/** HTML 转义（文本与属性值通用，防注入）。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 转义 + 换行转 `<br>`（说说 / 评论正文用）。 */
function escapeMultiline(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, '<br>');
}

const QZONE_HTML_STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #eef2f7; color: #243247; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; font-size: 14px; line-height: 1.7; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 24px 14px 44px; }
  .profile { display: flex; align-items: center; gap: 14px; background: #fff; border: 1px solid #e5eaf2; border-radius: 16px; padding: 16px 18px; margin-bottom: 14px; box-shadow: 0 8px 24px rgb(32 56 88 / 0.05); }
  .profile h1 { margin: 0 0 2px; font-size: 20px; line-height: 1.4; }
  .profile p { margin: 0; color: #758298; font-size: 13px; }
  .avatar { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 50%; flex: none; object-fit: cover; background: #e4ebf5; color: #5b6b83; font-weight: 600; font-size: 15px; }
  .profile .avatar { width: 72px; height: 72px; font-size: 26px; }
  .post-list { display: flex; flex-direction: column; gap: 14px; }
  article.card { background: #fff; border: 1px solid #e5eaf2; border-radius: 16px; padding: 16px 18px; box-shadow: 0 8px 24px rgb(32 56 88 / 0.04); }
  .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .who { min-width: 0; }
  .who strong { display: block; font-size: 15px; line-height: 1.3; }
  .who small { display: block; color: #7e899a; font-size: 12px; line-height: 1.5; }
  .badge.is-private { display: inline-block; background: #fff3ec; color: #d46b08; border-radius: 999px; padding: 0 8px; font-size: 11px; }
  .content { margin: 10px 0 0; overflow-wrap: anywhere; }
  .em { width: 22px; height: 22px; vertical-align: -5px; margin: 0 1px; display: inline-block; }
  .mention { color: #2684ff; }
  .pictures { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 6px; margin-top: 10px; }
  .pictures.is-one { grid-template-columns: minmax(0, 1fr); }
  .pictures a { display: block; border-radius: 8px; overflow: hidden; background: #eef2f7; }
  .pictures img { display: block; width: 100%; height: 210px; object-fit: cover; }
  .pictures.is-one img { height: auto; max-height: 720px; object-fit: contain; }
  .stats { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 12px; padding-top: 10px; border-top: 1px dashed #e1e8f2; color: #7e899a; font-size: 12px; }
  .stats .likes { color: #e15b64; }
  .sep { color: #c3ccd8; }
  .comments { margin-top: 12px; display: flex; flex-direction: column; gap: 12px; background: #f5f8fc; border-radius: 12px; padding: 12px 14px; }
  .comment, .reply { display: flex; gap: 8px; }
  .comment .avatar, .reply .avatar { width: 30px; height: 30px; font-size: 13px; }
  .comment-main { min-width: 0; flex: 1; }
  .comment-meta { color: #7e899a; font-size: 12px; }
  .comment-meta b { color: #2684ff; font-weight: 600; margin-right: 4px; }
  .comment-meta time { color: #a6b0be; margin-left: 4px; }
  .comment-text { margin: 2px 0 0; overflow-wrap: anywhere; }
  .replies { margin: 10px 0 0 4px; padding-left: 12px; border-left: 2px solid #d9e5f7; display: flex; flex-direction: column; gap: 10px; }
  .cimg a { color: #2684ff; margin-right: 8px; white-space: nowrap; }
  .foot { text-align: center; color: #8b98a8; font-size: 12px; padding: 26px 0 6px; }
  @media (max-width: 600px) {
    .wrap { padding: 12px 8px 32px; }
    .card, .profile { padding: 13px 14px; border-radius: 14px; }
    .pictures { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
    .pictures img { height: 140px; }
  }
`;

/** QQ 空间头像（QzoneArchive 同款 qlogo2 域）；无有效 uin 返回空串。 */
function qzoneAvatarUrl(uin: string | undefined): string {
  const u = (uin ?? '').trim();
  if (!u || u === '0') return '';
  return `https://qlogo2.store.qq.com/qzone/${u}/${u}/100`;
}

/** 头像元素：有 uin 用远端 qlogo `<img>`（需联网），缺失时回退昵称首字符。 */
function avatarElement(uin: string | undefined, fallbackName: string): string {
  const url = qzoneAvatarUrl(uin);
  if (!url) {
    const fb = escapeHtml((fallbackName || '?').trim().slice(0, 1) || '?');
    return `<span class="avatar fb">${fb}</span>`;
  }
  return `<img class="avatar" src="${url}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
}

/** QQ 表情渲染成 qzonestyle 外链 gif；个别新表情只有 png，首载失败自动换 png。 */
function emojiToHtml(code: string): string {
  return (
    `<img class="em" src="https://qzonestyle.gtimg.cn/qzone/em/${code}.gif" alt="[QQ表情]" ` +
    `loading="lazy" referrerpolicy="no-referrer" ` +
    `onerror="this.onerror=null;this.src='https://qzonestyle.gtimg.cn/qzone/em/${code}.png'">`
  );
}

/** 说说 / 评论正文里的提及 token（@{uin,nick}）与表情 token（[em]eXXX[/em]）。 */
const QZONE_TEXT_TOKEN_RE = /@\{uin:([^,}]+),nick:([^}]+)(?:,[^}]*)?\}|\[em\](e\d+)\[\/em\]/g;

/**
 * QQ 空间富文本 → 安全 HTML：文本转义 + 换行 `<br>`，表情渲染成外链图片，
 * 提及渲染成高亮 @昵称（与 QzoneArchive 前端/导出保持一致）。
 */
function qzoneTextToHtml(text: string): string {
  let out = '';
  let cursor = 0;
  for (const m of text.matchAll(QZONE_TEXT_TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > cursor) out += escapeMultiline(text.slice(cursor, idx));
    if (m[3] !== undefined) {
      out += emojiToHtml(m[3]);
    } else {
      const uin = escapeHtml(m[1] ?? '');
      const nick = escapeHtml(m[2] ?? '');
      out += `<span class="mention" title="QQ ${uin}">@${nick}</span>`;
    }
    cursor = idx + m[0].length;
  }
  return out + escapeMultiline(text.slice(cursor));
}

/** 评论里带的图片 → 「[图片]」外链。 */
function commentPicsToHtml(c: QzoneComment): string {
  if (c.images.length === 0) return '';
  const links = c.images
    .map((u) => `<a href="${escapeHtml(u)}" target="_blank" rel="noreferrer">[图片]</a>`)
    .join('');
  return `<span class="cimg">${links}</span>`;
}

/** 一条评论（一级或回复）的元信息行：昵称 + 动作 + 时间。 */
function commentMetaHtml(c: QzoneComment): string {
  const who = escapeHtml(c.nickname || c.uin || 'QQ 用户');
  const parts = [`<b>${who}</b>`];
  if (c.isReply) {
    const target = (c.replyToNickname || c.replyToUin || '').trim();
    parts.push(target ? `回复 <b>${escapeHtml(target)}</b>` : '回复');
  } else {
    parts.push('评论了');
  }
  if (c.time) parts.push(`<time>${escapeHtml(fmtTime(c.time))}</time>`);
  return `<div class="comment-meta">${parts.join(' ')}</div>`;
}

/** 一级评论 + 其二级回复，flat → 分层（保持原顺序）。 */
function groupComments(
  comments: QzoneComment[],
): Array<{ root: QzoneComment; replies: QzoneComment[] }> {
  const out: Array<{ root: QzoneComment; replies: QzoneComment[] }> = [];
  const byId = new Map<string, { root: QzoneComment; replies: QzoneComment[] }>();
  for (const c of comments) {
    if (!c.isReply) {
      const bucket = { root: c, replies: [] as QzoneComment[] };
      byId.set(c.id, bucket);
      out.push(bucket);
      continue;
    }
    const parent = c.parentCommentId ? byId.get(c.parentCommentId) : undefined;
    if (parent) {
      parent.replies.push(c);
    } else {
      // 解析器一般把回复紧跟在所属一级评论之后；个别乱序时挂到最近一条保序。
      const last = out[out.length - 1];
      if (last) last.replies.push(c);
      else out.push({ root: c, replies: [] });
    }
  }
  return out;
}

/** 单条评论正文块（头像 + 元信息 + 文字）。 */
function commentContentHtml(c: QzoneComment): string {
  const avatar = avatarElement(c.uin, c.nickname);
  const text = qzoneTextToHtml(c.content);
  return (
    `<div class="${c.isReply ? 'reply' : 'comment'}">${avatar}` +
    `<div class="comment-main">${commentMetaHtml(c)}` +
    `${text || c.images.length ? `<p class="comment-text">${text}${commentPicsToHtml(c)}</p>` : ''}` +
    '</div></div>'
  );
}

/** 一组评论（一级 + 回复）渲染成评论区 HTML。 */
function commentsToHtml(comments: QzoneComment[]): string {
  const blocks = groupComments(comments);
  const out: string[] = [];
  for (const block of blocks) {
    out.push('<div class="comment">');
    out.push(avatarElement(block.root.uin, block.root.nickname));
    out.push('<div class="comment-main">');
    out.push(commentMetaHtml(block.root));
    const text = qzoneTextToHtml(block.root.content);
    if (text || block.root.images.length) {
      out.push(`<p class="comment-text">${text}${commentPicsToHtml(block.root)}</p>`);
    }
    if (block.replies.length > 0) {
      out.push('<div class="replies">');
      for (const r of block.replies) out.push(commentContentHtml(r));
      out.push('</div>');
    }
    out.push('</div></div>');
  }
  return out.join('');
}

/** 点赞列表（前 10 个名字，超出补「等 N 人赞了」）。 */
function likesToHtml(likes: QzoneLike[]): string {
  if (likes.length === 0) return '';
  const names = likes
    .slice(0, 10)
    .map((l) => escapeHtml(l.nickname || l.uin || 'QQ用户'))
    .join('、');
  const label = likes.length > 10 ? `${names} 等 ${likes.length} 人赞了` : `${names} 赞了`;
  return `<span class="likes">♥ ${label}</span>`;
}

/** 帖子统计行：赞 + 评论数。 */
function statsToHtml(e: EmotionWithInteraction): string {
  const parts: string[] = [];
  const likes = e.likes ?? [];
  const likesHtml = likesToHtml(likes);
  if (likesHtml) parts.push(likesHtml);
  // 拉过互动就按实际拉到评论数，否则用服务端返回的计数。
  const cmtTotal = Math.max(e.commentNum || 0, e.comments?.length ?? 0);
  if (cmtTotal > 0) parts.push(`<span class="cmt-count">💬 ${cmtTotal} 条评论</span>`);
  if (parts.length === 0) return '';
  return `<div class="stats">${parts.join('<span class="sep">·</span>')}</div>`;
}

/** 说说配图网格：下载了走本地 `media/`，否则直接引用远端图（完整渲染）。 */
function picturesToHtml(e: QzoneEmotion, localMedia: boolean): string {
  if (e.images.length === 0) return '';
  const one = e.images.length === 1;
  const items = e.images
    .map((url, i) => {
      const local = localMedia ? `media/${encodeURI(imageFileName(e, url, i))}` : '';
      const href = local || url;
      const ext = local ? '' : ' target="_blank" rel="noreferrer"';
      return `<a href="${escapeHtml(href)}"${ext}><img loading="lazy" src="${escapeHtml(href)}" alt="配图 ${i + 1}" referrerpolicy="no-referrer"></a>`;
    })
    .join('');
  return `<div class="pictures${one ? ' is-one' : ''}">${items}</div>`;
}

/**
 * 一条说说渲染成 HTML article（参考 QzoneArchive 归档页）：头像 + 昵称头、
 * 正文（表情外链 / 提及）、配图、赞与评论数、评论区（含回复）。
 */
function emotionToHtml(
  e: EmotionWithInteraction,
  author: { name: string; uin: string },
  localMedia: boolean,
): string {
  const when = e.time ? fmtTime(e.time) : '';
  const privateBadge = e.isPrivate ? '<span class="badge is-private">私密</span>' : '';
  const head =
    '<header class="card-head">' +
    avatarElement(author.uin, author.name) +
    '<div class="who">' +
    `<strong>${escapeHtml(author.name || 'QQ 用户')}</strong>` +
    `<small>${when}${privateBadge ? ` · ${privateBadge}` : ''}</small>` +
    '</div></header>';
  const content = e.content ? `<div class="content">${qzoneTextToHtml(e.content)}</div>` : '';
  const pictures = picturesToHtml(e, localMedia);
  const stats = statsToHtml(e);
  const comments =
    e.comments && e.comments.length > 0
      ? `<section class="comments">${commentsToHtml(e.comments)}</section>`
      : '';
  return `<article class="card">${head}${content}${pictures}${stats}${comments}</article>`;
}

/** 整页 HTML 文档：资料头（头像 / 昵称 / 统计）+ 各说说 article。 */
function buildHtmlDoc(name: string, uin: string, count: number, postsHtml: string): string {
  const title = escapeHtml(name || 'QQ 空间');
  const exportedAt = escapeHtml(fmtTime(Math.floor(Date.now() / 1000)));
  const profile =
    '<header class="profile">' +
    avatarElement(uin, name) +
    '<div class="profile-main">' +
    `<h1>${title} 的 QQ 空间</h1>` +
    `<p>${uin ? `QQ ${escapeHtml(uin)} · ` : ''}说说导出 · 共 ${count} 条 · 导出于 ${exportedAt}</p>` +
    '</div></header>';
  return (
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    `<title>${title} · QQ 空间说说</title>\n<style>${QZONE_HTML_STYLE}</style>\n</head>\n<body>\n` +
    `<div class="wrap">\n${profile}\n` +
    `<main class="post-list">\n${postsHtml}\n</main>\n` +
    `<footer class="foot">共 ${count} 条说说 · 导出于 ${exportedAt}</footer>\n</div>\n</body>\n</html>\n`
  );
}

/** 一条评论渲染成 TXT 行（缩进）。 */
function commentToTxt(c: QzoneComment, indent: string): string {
  const who = c.isReply
    ? `${c.nickname || c.uin} 回复 ${c.replyToNickname || c.replyToUin || ''}`.trim()
    : c.nickname || c.uin;
  const t = c.time ? ` ${fmtTime(c.time)}` : '';
  const line = `${indent}${who}${t}: ${c.content || (c.images.length ? '[图片]' : '')}`;
  return c.images.length ? `${line} 图: ${c.images.join(', ')}` : line;
}

/** 一条说说渲染成 TXT 段落（含互动时附评论 / 点赞）。 */
function emotionToTxt(e: EmotionWithInteraction): string {
  const head = `[${fmtTime(e.time)}]${e.isPrivate ? ' (私密)' : ''}${e.commentNum ? ` (评论 ${e.commentNum})` : ''}`;
  const lines = [head];
  if (e.content) lines.push(e.content);
  if (e.images.length) lines.push(`图片: ${e.images.join(', ')}`);
  const comments = e.comments ?? [];
  const likes = e.likes ?? [];
  if (comments.length) {
    lines.push(`评论 ${comments.length} 条:`);
    for (const c of comments) lines.push(commentToTxt(c, '  '));
  }
  if (likes.length) {
    lines.push(`赞: ${likes.map((l) => l.nickname || l.uin).join('、')}`);
  }
  lines.push('—'.repeat(24));
  return `${lines.join('\n')}\n`;
}

/** 从 URL 猜图片扩展名，缺失回退 `.jpg`。 */
function picExt(url: string): string {
  const ext = extname(url.split('?')[0] ?? '').toLowerCase();
  return /^\.(jpg|jpeg|png|gif|webp|bmp)$/.test(ext) ? ext : '.jpg';
}

/** 说说配图的本地文件名 —— 下载落盘与 HTML 引用必须共用同一套命名。 */
function imageFileName(e: QzoneEmotion, url: string, i: number): string {
  return `${e.tid}_${i}${picExt(url)}`;
}

/** 下载全部说说配图到 `mediaRoot`，并发 4，返回成败计数。 */
async function downloadImages(
  emotions: QzoneEmotion[],
  mediaRoot: string,
  onMedia?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ ok: number; failed: number }> {
  const jobs: Array<{ url: string; dest: string }> = [];
  for (const e of emotions) {
    e.images.forEach((url, i) => {
      jobs.push({ url, dest: join(mediaRoot, imageFileName(e, url, i)) });
    });
  }
  const total = jobs.length;
  if (total === 0) {
    onMedia?.(0, 0);
    return { ok: 0, failed: 0 };
  }
  await mkdir(mediaRoot, { recursive: true });

  let done = 0;
  let ok = 0;
  let failed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const idx = next++;
      if (idx >= total) return;
      const job = jobs[idx]!;
      const outcome = await downloadUrlToFile(job.url, job.dest);
      if (outcome.ok) ok += 1;
      else failed += 1;
      done += 1;
      onMedia?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, total) }, worker));
  return { ok, failed };
}

/**
 * 批量补拉说说评论 + 点赞，挂在 emotion 上（含空的互动桶；便于 JSON 稳定输出）。
 * 拉取整体失败时返回 failed=true，正文照常导出 —— 互动是增强项，不能因它废掉整次导出。
 */
async function attachInteractions(
  filtered: EmotionWithInteraction[],
  deps: QzoneExportDeps,
  opts: QzoneExportOpts,
): Promise<{ failed: boolean; interactionPosts: number }> {
  const onInteraction = opts.onInteraction;
  try {
    if (!deps.fetchInteractions) {
      onInteraction?.(0, filtered.length, '互动能力不可用，跳过');
      return { failed: false, interactionPosts: 0 };
    }
    const targets: QzoneInteractionTarget[] = filtered.map((e) => ({ tid: e.tid, time: e.time }));
    onInteraction?.(0, filtered.length, '拉取评论 / 点赞…');
    const map = await deps.fetchInteractions(opts.targetUin, targets);
    for (const e of filtered) {
      const it = map.get(e.tid);
      if (it) {
        e.comments = it.comments;
        e.likes = it.likes;
      } else {
        e.comments = [];
        e.likes = [];
      }
    }
    // 点赞补全（顺便）：动态页 HTML 偶发不渲染 user-list 名单 → 对「HTML 没拿到
    // 赞」的帖子用 r.qzone qz_opcnt2 补一轮权威名单。只补空赞的帖子，少打扰；
    // 单条失败保留 HTML 结果继续（赞是增强项，不因它中断导出）。
    let likesTopUp = 0;
    if (deps.fetchLikes && !opts.signal?.aborted) {
      const needTopUp = filtered.filter((e) => (e.likes?.length ?? 0) === 0);
      if (needTopUp.length > 0) {
        let done = 0;
        let next = 0;
        const worker = async (): Promise<void> => {
          for (;;) {
            if (opts.signal?.aborted) return;
            const idx = next++;
            if (idx >= needTopUp.length) return;
            const e = needTopUp[idx]!;
            try {
              const ls = await deps.fetchLikes!(opts.targetUin, e.tid);
              if (ls.length > 0) {
                e.likes = ls;
                likesTopUp += 1;
              }
            } catch {
              // qz_opcnt2 单条失败 → 保留 HTML 空赞，best-effort。
            }
            done += 1;
            onInteraction?.(done, needTopUp.length, `补拉点赞 ${done}/${needTopUp.length}…`);
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, needTopUp.length) }, worker));
      }
    }
    let posts = 0;
    for (const e of filtered) {
      if ((e.comments?.length ?? 0) > 0 || (e.likes?.length ?? 0) > 0) posts += 1;
    }
    const note = likesTopUp
      ? `互动完成：${posts} 条有评论/赞（qz_opcnt2 补拉 ${likesTopUp} 条赞）`
      : `互动完成：${posts} 条有评论/赞`;
    onInteraction?.(filtered.length, filtered.length, note);
    return { failed: false, interactionPosts: posts };
  } catch (e) {
    // 互动拉取失败（票据 / 风控 / 网络）不阻断正文导出：置空并标记 failed。
    for (const em of filtered) {
      em.comments = [];
      em.likes = [];
    }
    onInteraction?.(0, filtered.length, `互动拉取失败: ${(e as Error).message}`);
    return { failed: true, interactionPosts: 0 };
  }
}

/**
 * 导出一个空间（好友或自己）的说说到 json / txt / html，可选下载配图（bundle）、
 * 补全评论/点赞。
 */
export async function exportQzone(
  opts: QzoneExportOpts,
  deps: QzoneExportDeps,
): Promise<QzoneExportResult> {
  opts.onProgress(0, 0, '拉取说说…');
  const fetched = await fetchAllEmotions(
    deps,
    opts.targetUin,
    opts.range,
    opts.onProgress,
    opts.signal,
  );
  const filtered = fetched.filter((e) => inRange(e, opts.range));
  // 互动字段挂在 EmotionWithInteraction 上；不带互动时数组元素仍是合法 QzoneEmotion。
  const rows: EmotionWithInteraction[] = filtered;

  // 补全互动（评论 + 点赞）：一次批量拉取，JSON / TXT 两份产物共用同一份数据。
  let interaction: QzoneExportResult['interaction'];
  if (opts.includeInteraction && !opts.signal?.aborted) {
    const { failed, interactionPosts } = await attachInteractions(rows, deps, opts);
    const commentCount = rows.reduce((s, e) => s + (e.comments?.length ?? 0), 0);
    const likeCount = rows.reduce((s, e) => s + (e.likes?.length ?? 0), 0);
    interaction = {
      posts: interactionPosts,
      comments: commentCount,
      likes: likeCount,
      failed,
    };
  }

  // 写盘（说说量级不大，一次性写；json 带缩进便于阅读）。HTML 的配图引用本地
  // media/ 相对路径 —— 配图是否实际下载由调用方保证（含 html 时强制下载）。
  const body =
    opts.format === 'json'
      ? JSON.stringify(rows, null, 2)
      : opts.format === 'html'
        ? buildHtmlDoc(
            opts.name,
            opts.targetUin,
            rows.length,
            rows
              .map((e) =>
                emotionToHtml(e, { name: opts.name, uin: opts.targetUin }, Boolean(opts.mediaRoot)),
              )
              .join('\n'),
          )
        : rows.map(emotionToTxt).join('\n');
  const writer = createExportWriter(opts.outputPath);
  await writer.write(body);
  await writer.end();

  let mediaOk = 0;
  let mediaFailed = 0;
  if (opts.mediaRoot && !opts.signal?.aborted) {
    const r = await downloadImages(filtered, opts.mediaRoot, opts.onMedia, opts.signal);
    mediaOk = r.ok;
    mediaFailed = r.failed;
  }

  return {
    filePath: opts.outputPath,
    count: filtered.length,
    mediaOk,
    mediaFailed,
    ...(interaction ? { interaction } : {}),
  };
}
