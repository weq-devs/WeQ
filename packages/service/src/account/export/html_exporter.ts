/**
 * HTML exporter — render a conversation as a self-contained web page of chat
 * bubbles (QQ / WeChat style), streamed to disk one message at a time.
 *
 * Like the ChatLab exporter it resolves sender identities (name / role / avatar)
 * in a pre-pass via the injected {@link SenderResolveDeps}, then streams the
 * messages. Unlike the line formats it wraps the records in a document head /
 * tail and renders each message into a bubble `<div>` instead of a text line.
 *
 * Design notes:
 *   - The page renders with **virtual scrolling**: message rows are streamed
 *     into the document as a JSON payload (`<script id="log-data">`), and an
 *     inline script only keeps a window of DOM rows around the viewport,
 *     adding/removing them on scroll (top/bottom spacers hold the scrollbar
 *     height). So a huge log opens instantly and fast-scrolls without the
 *     background flicker that `content-visibility:auto` on each row caused
 *     (off-screen rows skip painting entirely → bubble backgrounds pop in/out).
 *   - Media is referenced by the same deterministic bundle-relative paths the
 *     other exporters use (`data.localPath`, stamped by `annotateLocalPaths`),
 *     so the media stages don't change — `<img src="media/image/…">` etc.
 *   - Avatars use the public uin CDN url (project convention); local avatar
 *     files are produced in a *later* pipeline stage, so they aren't available
 *     while this stage streams.
 *   - Chat content is untrusted input: every text / name / file name is passed
 *     through {@link escapeHtml} before it reaches the document (XSS guard).
 */

import { statSync } from 'node:fs';
import { createExportWriter } from './stream_utils';
import type { MsgService } from '../msg';
import type { RenderElement, ForwardMessage } from '../msg_view';
import type { MsgDecoration } from '@weq/codec';
import { TipGroupElementType } from '@weq/codec';
import { marked } from 'marked';
import type {
  DressBubbleManifest,
  DressExportKinds,
  DressExportManifest,
  DressFontManifest,
  DressWidgetManifest,
} from './dress_export';
import { toExportedMessage, type RoamMessageSource } from './message_source';
import { annotateLocalPaths, elementsToText, formatTime } from './element_text';
import { expandForwards } from './forward_expand';
import { UNICODE_FACE_MAP } from './unicode_face_map';
import { SYSFACE_SUBDIR } from './sysface_export';
import {
  avatarUrlForUin,
  fallbackSender,
  iterateConv,
  resolveC2cSenders,
  resolveGroupSenders,
  type ResolvedSender,
  type SenderResolveDeps,
} from './sender_resolve';
import type {
  ConvKind,
  ExportedMessage,
  ExportResult,
  ExportTimeRange,
  ProgressCallback,
} from './types';

export interface HtmlExportOptions {
  kind: ConvKind;
  /** Group code (群号) or peer uid. */
  conv: string;
  /** Display name for the page header (the conversation name the user picked). */
  name: string;
  outputPath: string;
  range?: ExportTimeRange;
  /** 漫游补全消息（导出「消息补全」拉回缓存后，消息流按 sendTime 合并）。 */
  roam?: RoamMessageSource;
  onProgress?: ProgressCallback;
  progressEvery?: number;
  /** When provided, each message's sender uin is collected (for avatar export). */
  collectSenders?: Set<string>;
  /**
   * When provided, every built-in system-emoji (小黄脸) face id referenced by the
   * conversation is collected here, so a later stage can copy those images into
   * the bundle's `media/face/`. Unicode-glyph faces are rendered as text and are
   * intentionally not collected.
   */
  collectFaces?: Set<string>;
  /** Stamp media elements with their bundle relative path (so `<img>` resolves). */
  withMediaPaths?: boolean;
  /** 导出装扮：勾选的类别（null/undefined = 不导出装扮）。 */
  dress?: DressExportKinds;
  /** 导出装扮：dress 阶段预扫描得到的 msgId → decoration。 */
  dressLookup?: (msgId: string) => MsgDecoration | undefined;
  /** 导出装扮：dress 阶段写出的资源清单（气泡 slice / 字体 family / 挂件路径）。 */
  dressManifest?: DressExportManifest | null;
}

/** Bracket labels for media kinds with no inline rendering / no local file. */
const PLACEHOLDER: Record<string, string> = {
  ark: '[卡片消息]',
  multiMsg: '[合并转发]',
  call: '[通话]',
  wallet: '[红包/转账]',
  onlineFolder: '[文件夹]',
  mface: '[表情]',
  shareLocation: '[位置共享]',
};

/** Escape the five HTML-significant characters (covers text and attribute values). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escaped text with newlines turned into `<br>`. */
function escapeMultiline(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, '<br>');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ─── Gray-tip XML / JSON content extraction ─────────────────────────────

/** Simple XML node attributes extractor (avoids pulling in a full XML parser). */
function xmlAttr(tag: string, attr: string): string {
  const m = tag.match(new RegExp(`${attr}="([^"]*)"`));
  return m?.[1] ?? '';
}

/** Extract plain-text content from a `<gtip>` XML string. */
function grayTipXmlToText(xml: string): string {
  const gtipMatch = xml.match(/<gtip[\s>][\s\S]*?<\/gtip>/i);
  if (!gtipMatch) return '';
  const gtip = gtipMatch[0];
  // Collect all child nodes: <qq>, <nor>, <url>, <img>, <face>
  const parts: string[] = [];
  const nodeRe = /<(qq|nor|url|img|face)([^>]*?)(?:\/?)>/gi;
  let match = nodeRe.exec(gtip);
  while (match) {
    const m = match;
    const tag = m[0];
    const kind = m[1];
    if (kind === 'qq') {
      const nm = xmlAttr(tag, 'nm');
      const uin = xmlAttr(tag, 'uin');
      parts.push(nm || uin || '某人');
    } else if (kind === 'nor') {
      const txt = xmlAttr(tag, 'txt');
      parts.push(txt || '');
    } else if (kind === 'url') {
      const txt = xmlAttr(tag, 'txt');
      parts.push(txt || '');
    } else if (kind === 'face') {
      parts.push('[表情]');
    }
    // <img> → no text
    match = nodeRe.exec(gtip);
  }
  return parts.join('');
}

/** Extract plain-text from a grayTipPoke `tipJson` string. */
function grayTipPokeJsonToText(json: string): string {
  try {
    const data = JSON.parse(json) as { items?: Array<{ type?: string; txt?: string; uid?: string; uin?: string; nm?: string }> };
    if (!data.items) return '';
    return data.items.map((item) => {
      if (item.type === 'qq' || item.type === 'url') {
        return item.nm || item.txt || item.uin || '';
      }
      return item.txt || '';
    }).join('');
  } catch {
    return '';
  }
}

/** Format a grayTipGroup element into a human-readable system line. */
function renderGrayTipGroupText(el: RenderElement): string {
  const d = el.data as Record<string, unknown>;
  const groupTipType = d.groupTipType as number | undefined;
  const u1 = (d.user1GroupNick || d.user1Nick || '') as string;
  const u2 = (d.user2GroupNick || d.user2Nick || '') as string;
  const groupName = (d.groupTipGroupName || '') as string;
  const muteInfo = d.muteInfo as {
    operator?: { uid?: string };
    mutedUser?: { uid?: string; groupNick?: string };
    duration?: number;
  } | undefined;

  switch (groupTipType) {
    case TipGroupElementType.KMEMBERADD:
      return u1 ? `${u1} 加入了群聊` : '';
    case TipGroupElementType.KDISBANDED:
      return '该群已被群主解散';
    case TipGroupElementType.KQUITTE:
      return u1 ? `${u1} 已将你移出群聊` : '';
    case TipGroupElementType.KCREATED:
      return `${u1 || ''} 创建了群聊${groupName ? ` ${groupName}` : ''}`;
    case TipGroupElementType.KGROUPNAMEMODIFIED:
      return `${u1 || ''} 修改群名为 ${groupName || '新群名'}`;
    case TipGroupElementType.KBLOCK:
      return u1 ? `${u1} 将 ${u2 || '某成员'} 加入了黑名单` : '';
    case TipGroupElementType.KUNBLOCK:
      return u1 ? `${u1} 将 ${u2 || '某成员'} 移出了黑名单` : '';
    case TipGroupElementType.KSHUTUP: {
      if (!muteInfo) return '禁言';
      const dur = muteInfo.duration || 0;
      const op = u1 || '管理员';
      const target = muteInfo.mutedUser?.groupNick || u2;
      if (!target) {
        return `${op} ${dur > 0 ? '开启' : '关闭'}了全员禁言`;
      }
      if (dur > 0) {
        const days = Math.floor(dur / 86400);
        const hours = Math.floor((dur % 86400) / 3600);
        const minutes = Math.floor((dur % 3600) / 60);
        const durStr = days > 0 ? `${days}天` : hours > 0 ? `${hours}小时` : `${minutes}分钟`;
        return `${target} 被 ${op} 禁言了${durStr}`;
      }
      return `${op} 结束了 ${target} 的禁言`;
    }
    case TipGroupElementType.KBERECYCLED:
      return '该群因违规被回收';
    case TipGroupElementType.KDISBANDORBERECYCLED:
      return '该群已被解散或被回收';
    default:
      return '';
  }
}

/** Render the text content of any gray-tip element as a system line. */
function renderGrayTipContent(el: RenderElement): string {
  const d = el.data as Record<string, unknown>;
  switch (el.type) {
    case 'grayTipRevoke': {
      const text = (d.recallDisplayText as string) || '撤回了一条消息';
      return text;
    }
    case 'grayTipPoke': {
      const xml = (d.grayTipXmlContent as string) || '';
      const json = (d.tipJson as string) || '';
      if (xml) {
        const text = grayTipXmlToText(xml);
        if (text) return text;
      }
      if (json) {
        const text = grayTipPokeJsonToText(json);
        if (text) return text;
      }
      return '戳一戳';
    }
    case 'grayTipGroup':
      return renderGrayTipGroupText(el) || '群提示';
    case 'grayTipXml': {
      const xml = (d.grayTipXmlContent as string) || '';
      if (xml) {
        const text = grayTipXmlToText(xml);
        if (text) return text;
      }
      return '群提示';
    }
    case 'grayTipFileRecv': {
      const name = (d.fileName as string) || '';
      return name ? `文件传输完成: ${name}` : '文件传输完成';
    }
    case 'grayTipTempSession': {
      const code = (d.tempSessionGroupCode as string) || '';
      return code ? `该用户通过群 ${code} 向你发起临时会话` : '临时会话';
    }
    default:
      return '';
  }
}

// ─── Markdown rendering ──────────────────────────────────────────────────

/** Configure marked for safe, compact HTML output. */
marked.use({
  gfm: true,
  breaks: true,
  pedantic: false,
});

/** Render markdown source to an HTML fragment (sanitized for inline display). */
function renderMarkdownHtml(src: string): string {
  if (!src) return '';
  const raw: string = marked.parse(src) as string;
  return raw;
}

/** Human-readable byte size (service-local; the front-end has its own copy). */
function fmtBytes(bytes: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Gray-tip and system-only element kinds that render as centered system lines. */
const SYSTEM_KINDS = new Set([
  'grayTipRevoke', 'grayTipPoke', 'grayTipGroup', 'grayTipXml',
  'grayTipFileRecv', 'grayTipTempSession',
  'emojiBounce', 'qqDynamic', 'call',
]);

/** A message whose every element is a gray-tip is shown as a centered system line. */
function isSystemOnly(elements: RenderElement[]): boolean {
  return elements.length > 0 && elements.every((e) => SYSTEM_KINDS.has(e.type));
}

/** Local bundle path stamped by `annotateLocalPaths`, if any. */
function localPath(el: RenderElement): string | undefined {
  return (el.data as { localPath?: string }).localPath;
}

/**
 * Render one built-in system-emoji (faceElement) face.
 *   - Unicode-glyph faces (faceId is a code point) → the glyph as text.
 *   - Numeric faces → `<img src="media/face/<id>.png">`; the id is collected so a
 *     later stage copies the image in. `onerror` swaps the img for its `[表情]`
 *     text so a not-copied / unknown face still reads sensibly.
 */
function renderFace(el: RenderElement, collectFaces?: Set<string>): string {
  const data = el.data as { faceId?: number; faceText?: string };
  const faceId = data.faceId;
  const label = data.faceText ? `[${data.faceText}]` : '[表情]';

  if (typeof faceId === 'number') {
    const glyph = UNICODE_FACE_MAP[faceId];
    if (glyph)
      return `<span class="face-glyph" title="${escapeHtml(label)}">${escapeHtml(glyph)}</span>`;
    if (Number.isInteger(faceId) && faceId >= 0) {
      const idStr = String(faceId);
      collectFaces?.add(idStr);
      const alt = escapeHtml(label);
      // onerror: if the image wasn't copied (unknown/uninstalled face), replace
      // it in place with its bracketed text so the bubble never shows a broken
      // image icon. `this.replaceWith` keeps the page a plain static document.
      return (
        `<img class="face-emoji" loading="lazy" src="media/${SYSFACE_SUBDIR}/${idStr}.png"` +
        ` alt="${alt}" title="${alt}"` +
        ` onerror="this.replaceWith(document.createTextNode(this.alt))">`
      );
    }
  }
  return `<span class="face">${escapeHtml(label)}</span>`;
}

/** One element → an HTML fragment for the bubble body. */
function renderElement(el: RenderElement, collectFaces?: Set<string>): string {
  switch (el.type) {
    case 'text':
      return escapeMultiline(el.data.textContent ?? '');
    case 'at':
      return `<span class="at">${escapeHtml(el.data.textContent ?? '')}</span>`;
    case 'face':
      return renderFace(el, collectFaces);
    case 'pic': {
      const p = localPath(el);
      const cls = el.data.subType === 1 ? 'media emoji' : 'media';
      if (p)
        return `<img class="${cls}" loading="lazy" src="${escapeHtml(p)}" alt="${el.data.subType === 1 ? '表情' : '图片'}">`;
      return `<span class="ph">${el.data.subType === 1 ? '[表情]' : '[图片]'}</span>`;
    }
    case 'video': {
      const p = localPath(el);
      if (p) return `<video class="media" controls preload="none" src="${escapeHtml(p)}"></video>`;
      return '<span class="ph">[视频]</span>';
    }
    case 'ptt': {
      const p = localPath(el);
      const name = el.data.fileName
        ? `<small class="cap">${escapeHtml(el.data.fileName)}</small>`
        : '';
      if (p)
        return `<span class="voice"><audio controls preload="none" src="${escapeHtml(p)}"></audio>${name}</span>`;
      return `<span class="ph">[语音]${el.data.fileName ? ` ${escapeHtml(el.data.fileName)}` : ''}</span>`;
    }
    case 'file':
    case 'onlineFile': {
      const p = localPath(el);
      const name = escapeHtml(el.data.fileName || '文件');
      const size = el.data.fileSize ? `<small>${fmtBytes(el.data.fileSize)}</small>` : '';
      if (p) return `<a class="file" href="${escapeHtml(p)}" download>📎 ${name} ${size}</a>`;
      return `<span class="file ph">📎 ${name} ${size}</span>`;
    }
    case 'reply': {
      const summary = truncate(elementsToText(el.data.origElements ?? []).trim(), 120);
      return summary ? `<div class="quote">${escapeMultiline(summary)}</div>` : '';
    }
    case 'markdown': {
      // Render markdown as rich HTML instead of plain text.
      const mdSrc = el.data.markdownContent
        || el.data.markdownTextSummary
        || '';
      if (mdSrc) {
        return `<div class="md-wrap">${renderMarkdownHtml(mdSrc)}</div>`;
      }
      return '<span class="ph">[Markdown]</span>';
    }
    case 'multiMsg':
      return renderForward(el.data.forwardMessages, collectFaces);
    case 'grayTipRevoke':
    case 'grayTipPoke':
    case 'grayTipGroup':
    case 'grayTipXml':
    case 'grayTipFileRecv':
    case 'grayTipTempSession': {
      const text = renderGrayTipContent(el);
      return text ? `<span class="graytip-text">${escapeHtml(text)}</span>` : '<span class="ph">[提示]</span>';
    }
    case 'emojiBounce': {
      const summary = el.data.emojiBounceTextSummary || el.data.emojiBouncePcText || '';
      return `<span class="graytip-text">${escapeHtml(summary || '[表情]')}</span>`;
    }
    case 'qqDynamic': {
      const main = el.data.dynamicDesc?.mainDesc || el.data.dynamicDesc2?.mainDesc || '';
      return `<span class="graytip-text">${main ? escapeHtml(main) : '[动态]'}</span>`;
    }
    case 'call': {
      const summary = Array.isArray(el.data.callSummary)
        ? el.data.callSummary.filter((s) => typeof s === 'string' && s).join(' ')
        : '';
      return summary ? `<span class="graytip-text">${escapeHtml(summary)}</span>` : '<span class="ph">[通话]</span>';
    }
    case 'unknown':
      return '';
    default:
      return PLACEHOLDER[el.type] ? `<span class="ph">${PLACEHOLDER[el.type]}</span>` : '';
  }
}

/** All elements → the bubble body (reply quote floats to the top). */
function renderBody(elements: RenderElement[], collectFaces?: Set<string>): string {
  const quotes = elements
    .filter((e) => e.type === 'reply')
    .map((e) => renderElement(e, collectFaces))
    .join('');
  const rest = elements
    .filter((e) => e.type !== 'reply')
    .map((e) => renderElement(e, collectFaces))
    .join('');
  return quotes + rest;
}

/**
 * A merged-forward's expanded content as a nested card of mini-bubbles. Each
 * forwarded message shows its sender name + rendered body; a nested forward
 * recurses (its own `multiMsg` element renders another card via `renderBody`).
 * Falls back to a `[合并转发]` placeholder when the cache wasn't expanded.
 */
function renderForward(messages: ForwardMessage[] | undefined, collectFaces?: Set<string>): string {
  if (!messages || messages.length === 0) return '<span class="ph">[合并转发]</span>';
  const rows = messages
    .map((msg) => {
      const name = escapeHtml(msg.senderName || '匿名');
      const time = msg.sendTime
        ? `<span class="fwd-time">${escapeHtml(formatTime(msg.sendTime))}</span>`
        : '';
      const body = renderBody(msg.elements, collectFaces);
      return `<div class="fwd-msg"><div class="fwd-meta"><span class="fwd-name">${name}</span>${time}</div><div class="fwd-body">${body}</div></div>`;
    })
    .join('');
  return `<div class="fwd"><div class="fwd-head">合并转发的聊天记录</div>${rows}</div>`;
}

/** One message → a bubble row, or a centered system line for gray-tip-only messages. */
function renderMessage(
  m: ExportedMessage,
  sender: ResolvedSender,
  selfId: string | undefined,
  collectFaces?: Set<string>,
  dec?: MsgDecoration,
  widgets?: Map<number, DressWidgetManifest>,
): string {
  if (isSystemOnly(m.elements)) {
    // Render gray-tip content with rich text extraction instead of bracket labels.
    const parts = m.elements.map((el) => {
      if (SYSTEM_KINDS.has(el.type)) {
        return renderGrayTipContent(el) || escapeHtml(elementsToText([el]).replace(/[[\]]/g, ''));
      }
      return escapeHtml(elementsToText([el]).replace(/[[\]]/g, ''));
    }).filter(Boolean);
    const text = parts.join('\n') || escapeHtml(elementsToText(m.elements).replace(/[[\]]/g, ''));
    return `<div class="sys">${escapeMultiline(text)}</div>\n`;
  }
  const isSelf = Boolean(selfId) && sender.platformId === selfId;
  const name = escapeHtml(sender.groupNickname || sender.accountName);
  const numeric = /^\d+$/.test(sender.platformId);
  const ava = numeric
    ? `<img class="ava" loading="lazy" src="${escapeHtml(avatarUrlForUin(sender.platformId))}" alt="">`
    : `<span class="ava ava-none">${escapeHtml((sender.accountName || '?').slice(0, 1))}</span>`;
  const role =
    sender.role === 'owner'
      ? '<span class="role owner">群主</span>'
      : sender.role === 'admin'
        ? '<span class="role">管理员</span>'
        : '';
  const body = renderBody(m.elements, collectFaces);
  const attrs = dec
    ? ` data-bubble="${dec.bubbleId}" data-font="${dec.fontId}" data-widget="${dec.widgetId}"`
    : '';
  const widgetImg =
    dec && dec.widgetId > 0 && widgets?.get(dec.widgetId)
      ? `<img class="widget" src="${escapeHtml(widgets.get(dec.widgetId)!.file)}" alt="">`
      : '';
  return (
    `<div class="msg${isSelf ? ' me' : ''}"${attrs}>${widgetImg}${ava}` +
    `<div class="col"><div class="meta"><span class="name">${name}</span>${role}` +
    `<span class="time">${escapeHtml(formatTime(m.sendTime))}</span></div>` +
    `<div class="bubble">${body}</div></div></div>\n`
  );
}

/** 装扮 CSS 的换算常量 —— 与渲染侧 dressSkin.ts / msgDecorationStyle.ts 保持一致。 */
const BUBBLE_SCALE = 0.5;
const PAD_RATIO_Y = 0.6;

function dressPx(v: number): string {
  return `${Math.round(v * 100) / 100}px`;
}

/** 由 dress 清单生成页面内的装扮 CSS（字体 / 气泡 border-image / 挂件定位）。 */
function buildDressCss(manifest: DressExportManifest): string {
  const rules: string[] = [];

  for (const font of manifest.fonts) {
    rules.push(
      `@font-face{font-family:"${font.family}";src:url("${font.file}") format("truetype");font-display:swap}`,
      `.msg[data-font="${font.itemId}"] .bubble{` +
        `font-family:"${font.family}",-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}`,
    );
  }

  for (const b of manifest.bubbles) {
    rules.push(...bubbleRules(b));
  }

  if (manifest.widgets.length > 0) {
    // 挂件几何与聊天页保持一致（chat.css 的 .weq-avatar-pendant-img）：60×60，中心对齐
    // 36px 头像中心再上移 4px。头像位于 .msg 内容盒左上角（me 时右上角），换算成绝对定位：
    //   垂直 top = 18 - 4 - 30 = -16px
    //   水平 left(right) = 18 - 30 = -12px
    rules.push(
      `.msg{position:relative}`,
      `.msg .widget{position:absolute;z-index:2;width:60px;height:60px;left:-12px;top:-16px;` +
        `pointer-events:none;object-fit:contain;filter:drop-shadow(0 1px 2px rgba(0,0,0,.25))}`,
      `.msg.me .widget{left:auto;right:-12px}`,
    );
  }

  return rules.join('\n');
}

/** 一款气泡的 border-image CSS（含对方消息镜像）。 */
function bubbleRules(skin: DressBubbleManifest): string[] {
  const { left, top, right, bottom } = skin.slice;
  const wTop = top * BUBBLE_SCALE;
  const wRight = right * BUBBLE_SCALE;
  const wBottom = bottom * BUBBLE_SCALE;
  const wLeft = left * BUBBLE_SCALE;
  const slice = `${top} ${right} ${bottom} ${left} fill`;
  const width = `${dressPx(wTop)} ${dressPx(wRight)} ${dressPx(wBottom)} ${dressPx(wLeft)}`;
  const avgSlice = (top + bottom) / 2;
  const topDiff = avgSlice - top;
  const bottomDiff = avgSlice - bottom;
  const topPad = wTop * PAD_RATIO_Y + topDiff * BUBBLE_SCALE * 0.5;
  const bottomPad = wBottom * PAD_RATIO_Y + bottomDiff * BUBBLE_SCALE * 0.5;

  const sel = `.msg[data-bubble="${skin.itemId}"] .bubble`;
  const theirsSel = `.msg:not(.me)[data-bubble="${skin.itemId}"] .bubble`;
  return [
    `${sel}{`,
    `  position:relative;isolation:isolate;background:transparent;color:${skin.textColor};`,
    `  border-style:solid;border-width:0;`,
    `  border-image-source:url("${skin.staticPng}");`,
    `  border-image-slice:${slice};`,
    `  border-image-width:${width};`,
    `  border-image-repeat:stretch;border-radius:0;`,
    `  padding:${dressPx(topPad)} ${dressPx(Math.max(wLeft, wRight))} ${dressPx(bottomPad)};`,
    `  min-width:${dressPx((left + right) * BUBBLE_SCALE)};`,
    `  min-height:${dressPx((top + bottom) * BUBBLE_SCALE)};`,
    `}`,
    // 对方消息镜像：素材按「自己的右侧气泡」绘制，放左侧要左右翻转。
    // 不能对整个 .bubble 做 scaleX(-1)（文字会跟着镜像），挪到 ::before 上翻。
    `${theirsSel}{border-image-source:none}`,
    `${theirsSel}::before{`,
    `  content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;`,
    `  border-style:solid;border-width:0;`,
    `  border-image-source:url("${skin.staticPng}");`,
    `  border-image-slice:${slice};`,
    `  border-image-width:${width};`,
    `  border-image-repeat:stretch;border-radius:0;`,
    `  transform:scaleX(-1);`,
    `}`,
  ];
}

/** `YYYY-MM-DD` local-day key (date dividers fire when it changes). */
function dayKey(unixSec: number): string {
  return formatTime(unixSec).slice(0, 10);
}

/** Inline stylesheet for the page (kept compact; #0099ff theme, light/dark). */
const STYLE = `
:root{--accent:#0099ff;--bg:#e9eaee;--panel:#fff;--bubble:#fff;--me:#d2ebff;--text:#1f2329;--sub:#8a9099;--line:#e6e8eb}
@media(prefers-color-scheme:dark){:root{--bg:#141518;--panel:#1f2023;--bubble:#2a2c30;--me:#10456b;--text:#e8eaed;--sub:#8a9099;--line:#34373c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
.frame{max-width:900px;margin:0 auto;min-height:100vh;background:var(--panel);border-left:1px solid var(--line);border-right:1px solid var(--line);box-shadow:0 0 24px rgba(0,0,0,.06)}
.head{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);padding:11px 18px}
.head-top strong{font-size:16px}.head-top small{color:var(--sub);margin-left:10px}
.search{position:relative;margin-top:9px;display:flex;align-items:center;gap:9px}
.search input{flex:1;min-width:0;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 11px;color:var(--text);font:inherit;font-size:13px;outline:none}
.search input:focus{border-color:var(--accent)}
#qinfo{color:var(--sub);font-size:12px;white-space:nowrap}
.results{position:absolute;left:0;right:0;top:calc(100% + 6px);max-height:54vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 26px rgba(0,0,0,.2);z-index:6}
.ritem{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--line);background:none;color:var(--text);padding:8px 13px;cursor:pointer;font:inherit}
.ritem:last-child{border-bottom:0}.ritem:hover{background:rgba(0,153,255,.08)}
.rmeta{display:block;color:var(--sub);font-size:11px;margin-bottom:2px}
.rsnip{display:block;font-size:13px;line-height:1.4;word-break:break-word}
.rsnip mark{background:rgba(245,166,35,.5);color:inherit;border-radius:2px;padding:0 1px}
.rmore{padding:7px 13px;color:var(--sub);font-size:12px;text-align:center}
.log{padding:16px 18px 64px}
/* 行距用 padding 而不是 margin：虚拟滚动靠 offsetHeight 按行测高，margin 不计入 offsetHeight，
   换成 padding 后每行实际高度包含行距，定位才准确。 */
.day{text-align:center;padding:6px 0 18px}.day span{background:rgba(140,140,140,.18);color:var(--sub);font-size:12px;padding:2px 10px;border-radius:10px}
.sys{text-align:center;color:var(--sub);font-size:12px;padding:0 0 18px}
.msg{display:flex;gap:10px;padding:0 0 18px;border-radius:8px;transition:background .2s}
.msg.me{flex-direction:row-reverse}
.flash{animation:flash 1.7s ease}
@keyframes flash{0%,18%{background:rgba(245,166,35,.32)}100%{background:transparent}}
.ava{width:36px;height:36px;border-radius:50%;flex:0 0 36px;object-fit:cover;background:var(--line)}
.ava-none{display:flex;align-items:center;justify-content:center;color:#fff;background:var(--accent);font-size:15px}
.col{min-width:0;max-width:76%;display:flex;flex-direction:column}
.msg.me .col{align-items:flex-end}
.meta{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--sub);margin:0 2px 4px}
.msg.me .meta{flex-direction:row-reverse}
.role{background:var(--accent);color:#fff;border-radius:3px;padding:0 4px;font-size:11px}
.role.owner{background:#f5a623}
.bubble{background:var(--bubble);border-radius:10px;padding:8px 11px;word-break:break-word;white-space:normal;box-shadow:0 1px 1px rgba(0,0,0,.04)}
.msg.me .bubble{background:var(--me)}
.at{color:var(--accent)}
.face-emoji{display:inline-block;width:1.4em;height:1.4em;vertical-align:-0.28em;margin:0 1px;object-fit:contain}
.face-glyph{font-size:1.25em;line-height:1;vertical-align:-0.15em}
.media{max-width:240px;max-height:280px;border-radius:6px;display:block;margin:3px 0}
.media.emoji{max-width:90px;max-height:90px}
.voice{display:inline-flex;flex-direction:column;gap:2px}.voice audio{height:34px}
.cap{color:var(--sub)}
.file{display:inline-flex;align-items:center;gap:6px;color:var(--accent);text-decoration:none;background:rgba(0,153,255,.08);border-radius:6px;padding:6px 9px}
.file small{color:var(--sub)}
.quote{border-left:3px solid var(--accent);background:rgba(140,140,140,.1);color:var(--sub);font-size:13px;border-radius:0 6px 6px 0;padding:3px 8px;margin-bottom:5px}
.fwd{border:1px solid var(--line);border-radius:8px;background:rgba(140,140,140,.06);margin:3px 0;overflow:hidden;max-width:340px}
.fwd-head{background:rgba(140,140,140,.12);color:var(--sub);font-size:12px;padding:5px 9px;border-bottom:1px solid var(--line)}
.fwd-msg{padding:6px 9px;border-bottom:1px solid var(--line)}
.fwd-msg:last-child{border-bottom:0}
.fwd-meta{display:flex;gap:6px;align-items:baseline;margin-bottom:2px}
.fwd-name{color:var(--accent);font-size:12px;font-weight:600}
.fwd-time{color:var(--sub);font-size:11px}
.fwd-body{font-size:13px;word-break:break-word}
.fwd .media{max-width:180px;max-height:180px}
.ph{color:var(--sub)}
.graytip-text{color:var(--sub);font-size:12px}
.foot{text-align:center;color:var(--sub);font-size:12px;padding:16px}
/* Markdown rendering inside bubbles */
.md-wrap{line-height:1.6}
.md-wrap h1,.md-wrap h2,.md-wrap h3,.md-wrap h4,.md-wrap h5,.md-wrap h6{margin:8px 0 4px;font-weight:600;line-height:1.3}
.md-wrap h1{font-size:1.3em}
.md-wrap h2{font-size:1.15em}
.md-wrap h3{font-size:1.05em}
.md-wrap p{margin:4px 0}
.md-wrap ul,.md-wrap ol{margin:4px 0;padding-left:1.5em}
.md-wrap li{margin:1px 0}
.md-wrap code{background:rgba(140,140,140,.15);padding:1px 4px;border-radius:3px;font-family:"SF Mono",Consolas,"Liberation Mono",Menlo,monospace;font-size:.9em}
.md-wrap pre{background:rgba(140,140,140,.12);border-radius:6px;padding:8px 10px;overflow-x:auto;margin:6px 0}
.md-wrap pre code{background:none;padding:0;font-size:.85em}
.md-wrap blockquote{border-left:3px solid var(--accent);color:var(--sub);padding:2px 8px;margin:6px 0}
.md-wrap a{color:var(--accent);text-decoration:none}
.md-wrap a:hover{text-decoration:underline}
.md-wrap img{max-width:240px;max-height:280px;border-radius:6px;display:block;margin:3px 0}
.md-wrap table{border-collapse:collapse;margin:6px 0;font-size:13px}
.md-wrap th,.md-wrap td{border:1px solid var(--line);padding:4px 8px;text-align:left}
.md-wrap th{background:rgba(140,140,140,.1);font-weight:600}
.md-wrap hr{border:none;border-top:1px solid var(--line);margin:8px 0}
`;

/**
 * Inline page script (no framework): renders a virtual-scroll window of message
 * rows from the embedded JSON payload, then jumps to the bottom on load (so the
 * user scrolls *up* into history). A window around the viewport is kept in the
 * DOM; top/bottom spacer divs hold the scrollbar height so the document length
 * stays correct without materializing all rows. Search scans the JSON payload
 * (built lazily on first search) and scroll-jumps + flashes the chosen row.
 */
const SCRIPT = `
(function(){
  var ds=document.getElementById('log-data');
  var ROWS=ds?(function(){try{return JSON.parse(ds.textContent)||[];}catch(e){return[];}})():[];
  var N=ROWS.length;
  var vp=document.getElementById('log-viewport');
  var tsp=document.getElementById('log-spacer-top');
  var rows=document.getElementById('log-rows');
  var bsp=document.getElementById('log-spacer-bottom');
  if(!vp||!rows)return;
  /* 默认行高估计 + 视口缓冲（viewport 的倍数）。 */
  var EST=84,BUF=3;
  var hei=[],sum=new Float64Array(N+1);
  var i; sum[0]=0; for(i=0;i<N;i++)sum[i+1]=sum[i]+EST;
  function setH(k,h){hei[k]=h;for(var j=k+1;j<=N;j++)sum[j]=sum[j-1]+(hei[j-1]||EST);}
  /* 第一个底 > y 的行下标。 */
  function idxAt(y){var lo=0,hi=N;while(lo<hi){var mid=(lo+hi)>>1;if(sum[mid+1]>y)hi=mid;else lo=mid+1;}return lo;}
  var start=0,end=0,nodes={};
  function make(h){var t=document.createElement('div');t.innerHTML=h;var c=t.firstChild;return c||document.createElement('div');}
  var raf=0;
  function render(){
    if(N===0){tsp.style.height='0px';bsp.style.height='0px';return;}
    var vh=window.innerHeight||500,sy=window.pageYOffset||document.documentElement.scrollTop||0;
    var rel=sy-(vp.getBoundingClientRect().top+sy);
    var y0=rel-BUF*vh;if(y0<0)y0=0;
    var y1=rel+(BUF+1)*vh;
    var a=idxAt(y0),b=idxAt(y1);if(a<0)a=0;if(b>N)b=N;
    /* 移除窗口外的节点。 */
    for(var k=start;k<end;k++){if(k<a||k>=b){var n=nodes[k];if(n&&n.parentNode){n.parentNode.removeChild(n);}delete nodes[k];}}
    /* 补齐窗口内缺失节点，保持文档顺序。 */
    var bound=b>end?b:end;
    for(k=a;k<b;k++){if(!nodes[k]){var el=make(ROWS[k].h);var ref=null;for(var j=k+1;j<=bound;j++){if(nodes[j]){ref=nodes[j];break;}}rows.insertBefore(el,ref);nodes[k]=el;}}
    /* 测高并更新累计高度，再刷新 spacer。 */
    for(k=a;k<b;k++){var e=nodes[k];if(e){var h=e.offsetHeight||EST;if(!hei[k]||Math.abs(h-hei[k])>1)setH(k,h);}}
    tsp.style.height=(sum[a]||0)+'px';
    bsp.style.height=(sum[N]-sum[b])+'px';
    start=a;end=b;
  }
  function schedule(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;render();});}
  window.addEventListener('scroll',schedule,{passive:true});
  window.addEventListener('resize',schedule);
  if(N){render();window.scrollTo(0,sum[N]);window.addEventListener('load',function(){render();});}
  /* ---- search（索引懒构建，扫描 JSON payload） ---- */
  var q=document.getElementById('q'),results=document.getElementById('results'),qinfo=document.getElementById('qinfo');
  if(!q)return;
  var index=null,timer=0,flashed=null;
  function clearFlash(){if(flashed){flashed.classList.remove('flash');flashed=null;}}
  function build(){index=[];for(var k=0;k<N;k++){var d=document.createElement('div');d.innerHTML=ROWS[k].h;
      var t=d.textContent||'',n=d.querySelector('.name'),tm=d.querySelector('.time');
      index.push({i:k,t:t,low:t.toLowerCase(),name:n?n.textContent:'',time:tm?tm.textContent:''});}}
  function jump(it){results.hidden=true;clearFlash();
    var y=(sum[it.i]||0)-window.innerHeight/2;if(y<0)y=0;
    window.scrollTo(0,y);
    requestAnimationFrame(function(){render();var el=nodes[it.i];if(el){void el.offsetWidth;el.classList.add('flash');flashed=el;}});}
  function snip(text,low,term){var i2=low.indexOf(term);if(i2<0)i2=0;var s=Math.max(0,i2-18);
    var f=document.createDocumentFragment();
    f.appendChild(document.createTextNode((s>0?'…':'')+text.slice(s,i2)));
    var m=document.createElement('mark');m.textContent=text.slice(i2,i2+term.length);f.appendChild(m);
    var e=i2+term.length;f.appendChild(document.createTextNode(text.slice(e,e+44)+(text.length>e+44?'…':'')));return f;}
  function run(){var term=q.value.trim().toLowerCase();results.innerHTML='';
    if(!term){results.hidden=true;qinfo.textContent='';return;}
    if(!index)build();var hits=[],total=0;
    for(var i3=0;i3<index.length;i3++){if(index[i3].low.indexOf(term)!==-1){total++;if(hits.length<300)hits.push(index[i3]);}}
    qinfo.textContent=total?total+' 条结果':'无结果';
    if(!total){results.hidden=true;return;}
    var frag=document.createDocumentFragment();
    hits.forEach(function(it){var b2=document.createElement('button');b2.type='button';b2.className='ritem';
      var mt=document.createElement('span');mt.className='rmeta';mt.textContent=(it.name?it.name+' · ':'')+it.time;
      var sn=document.createElement('span');sn.className='rsnip';sn.appendChild(snip(it.t,it.low,term));
      b2.appendChild(mt);b2.appendChild(sn);b2.addEventListener('click',function(){jump(it);});frag.appendChild(b2);});
    if(total>hits.length){var mo=document.createElement('div');mo.className='rmore';mo.textContent='仅显示前 '+hits.length+' 条，请输入更精确的关键词';frag.appendChild(mo);}
    results.appendChild(frag);results.hidden=false;}
  q.addEventListener('input',function(){clearTimeout(timer);timer=setTimeout(run,150);});
  q.addEventListener('keydown',function(e){if(e.key==='Enter'){var f=results.querySelector('.ritem');if(f)f.click();}else if(e.key==='Escape'){results.hidden=true;q.blur();}});
  document.addEventListener('click',function(e){if(!results.contains(e.target)&&e.target!==q)results.hidden=true;});
})();
`;

/**
 * Export a conversation to a single self-contained HTML page. Members are
 * resolved first (for names / roles / self-alignment), then messages stream as
 * bubble rows with write-backpressure.
 */
export async function exportToHtml(
  msgs: MsgService,
  opts: HtmlExportOptions,
  deps: SenderResolveDeps = {},
): Promise<ExportResult> {
  const start = Date.now();
  const progressEvery = opts.progressEvery ?? 1000;

  // 装扮：dress 阶段已经写好资源，这里只需把清单转成「itemId → 资产」的查表。
  const dressOn = Boolean(opts.dress && opts.dressManifest);
  const bubbleById = new Map<number, DressBubbleManifest>();
  const fontById = new Map<number, DressFontManifest>();
  const widgetById = new Map<number, DressWidgetManifest>();
  if (dressOn && opts.dressManifest) {
    for (const b of opts.dressManifest.bubbles) bubbleById.set(b.itemId, b);
    for (const f of opts.dressManifest.fonts) fontById.set(f.itemId, f);
    for (const w of opts.dressManifest.widgets) widgetById.set(w.itemId, w);
  }
  const dressCss = dressOn && opts.dressManifest ? buildDressCss(opts.dressManifest) : '';

  // ---- resolve self (for right-aligning own messages) + members ----
  const self = deps.self ? await deps.self().catch(() => null) : null;
  let selfId = self ? (self.uin && self.uin !== '0' ? self.uin : self.uid) : undefined;

  let senders: Map<string, ResolvedSender>;
  let convName = opts.name;
  if (opts.kind === 'group') {
    const meta = deps.groupMeta ? await deps.groupMeta(opts.conv).catch(() => null) : null;
    if (meta?.name) convName = opts.name || meta.name;
    opts.onProgress?.({ current: 0, message: '解析成员…' });
    senders = await resolveGroupSenders(
      msgs,
      opts.conv,
      opts.range,
      deps,
      meta?.ownerUid ?? '',
      opts.roam,
    );
  } else {
    const r = await resolveC2cSenders(opts.conv, deps);
    senders = r.senders;
    selfId = selfId ?? r.ownerId;
  }

  // ---- write ----
  const writer = createExportWriter(opts.outputPath);

  const title = escapeHtml(convName || (opts.kind === 'group' ? '群聊' : '私聊'));
  const exportedAt = escapeHtml(formatTime(Math.floor(Date.now() / 1000)));
  await writer.write(
    `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${title} · 聊天记录</title>\n` +
      `<style>${STYLE}</style>\n` +
      (dressCss ? `<style id="dress-css">${dressCss}</style>\n` : '') +
      `</head>\n<body>\n<div class="frame">\n` +
      `<header class="head">\n` +
      `<div class="head-top"><strong>${title}</strong><small>${opts.kind === 'group' ? '群聊' : '私聊'} · 导出于 ${exportedAt}</small></div>\n` +
      `<div class="search"><input id="q" type="search" placeholder="搜索消息内容…" autocomplete="off" spellcheck="false"><span id="qinfo"></span><div id="results" class="results" hidden></div></div>\n` +
      `</header>\n<main class="log"><div id="log-viewport"><div id="log-spacer-top"></div><div id="log-rows"></div><div id="log-spacer-bottom"></div></div></main>\n` +
      `<script type="application/json" id="log-data">\n[\n`,
  );

  let count = 0;
  let lastDay = '';
  let rowFirst = true;
  /* 每行预渲染成一条 JSON 记录流式写入，浏览器端再按需实例化（虚拟滚动）。 */
  async function writeRow(h: string): Promise<void> {
    await writer.write(`${rowFirst ? '' : ',\n'}${JSON.stringify({ h })}`);
    rowFirst = false;
  }
  try {
    for await (const raw of iterateConv(msgs, opts.kind, opts.conv, opts.range, opts.roam)) {
      const exported = toExportedMessage(raw);
      opts.collectSenders?.add(exported.senderUin);
      await expandForwards(msgs, opts.kind, exported);
      if (opts.withMediaPaths) annotateLocalPaths(exported.elements);
      const day = dayKey(exported.sendTime);
      if (day !== lastDay) {
        await writeRow(`<div class="day"><span>${escapeHtml(day)}</span></div>`);
        lastDay = day;
      }
      const sender = senders.get(exported.senderUid) ?? fallbackSender(exported);
      const dec = opts.dressLookup?.(exported.msgId);
      await writeRow(renderMessage(exported, sender, selfId, opts.collectFaces, dec, widgetById));
      count += 1;
      if (count % progressEvery === 0)
        opts.onProgress?.({ current: count, message: `已导出 ${count} 条` });
    }
    await writer.write(
      `\n]\n</script>\n<footer class="foot">共 ${count} 条消息 · 顶部搜索框可检索并点击跳转</footer>\n</div>\n` +
        `<script>${SCRIPT}</script>\n</body>\n</html>\n`,
    );
  } finally {
    await writer.end();
  }

  return {
    filePath: opts.outputPath,
    format: 'html',
    messageCount: count,
    fileSize: statSync(opts.outputPath).size,
    durationMs: Date.now() - start,
  };
}
