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
 *   - Streaming + `content-visibility:auto` on each row + `loading="lazy"` on
 *     images keep a very large log from ballooning memory in the browser, with
 *     no JS framework — the file stays a plain, view-source-readable page.
 *   - Media is referenced by the same deterministic bundle-relative paths the
 *     other exporters use (`data.localPath`, stamped by `annotateLocalPaths`),
 *     so the media stages don't change — `<img src="media/image/…">` etc.
 *   - Avatars use the public uin CDN url (project convention); local avatar
 *     files are produced in a *later* pipeline stage, so they aren't available
 *     while this stage streams.
 *   - Chat content is untrusted input: every text / name / file name is passed
 *     through {@link escapeHtml} before it reaches the document (XSS guard).
 */

import { createWriteStream, statSync } from 'node:fs';
import { once } from 'node:events';
import type { MsgService } from '../msg';
import type { RenderElement } from '../msg_view';
import { toExportedMessage } from './message_source';
import { annotateLocalPaths, elementsToText, formatTime } from './element_text';
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
import type { ConvKind, ExportedMessage, ExportResult, ExportTimeRange, ProgressCallback } from './types';

export interface HtmlExportOptions {
  kind: ConvKind;
  /** Group code (群号) or peer uid. */
  conv: string;
  /** Display name for the page header (the conversation name the user picked). */
  name: string;
  outputPath: string;
  range?: ExportTimeRange;
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
}

/** Bracket labels for media kinds with no inline rendering / no local file. */
const PLACEHOLDER: Record<string, string> = {
  ark: '[卡片消息]',
  multiMsg: '[合并转发]',
  call: '[通话]',
  wallet: '[红包/转账]',
  qqDynamic: '[动态]',
  onlineFolder: '[文件夹]',
  mface: '[表情]',
  emojiBounce: '[表情]',
  grayTipPoke: '[戳一戳]',
  grayTipGroup: '[群提示]',
  grayTipInvite: '[群提示]',
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

/** Human-readable byte size (service-local; the front-end has its own copy). */
function fmtBytes(bytes: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** A message whose every element is a gray-tip is shown as a centered system line. */
function isSystemOnly(elements: RenderElement[]): boolean {
  return elements.length > 0 && elements.every((e) => e.type.startsWith('grayTip'));
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
    if (glyph) return `<span class="face-glyph" title="${escapeHtml(label)}">${escapeHtml(glyph)}</span>`;
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
      if (p) return `<img class="${cls}" loading="lazy" src="${escapeHtml(p)}" alt="${el.data.subType === 1 ? '表情' : '图片'}">`;
      return `<span class="ph">${el.data.subType === 1 ? '[表情]' : '[图片]'}</span>`;
    }
    case 'video': {
      const p = localPath(el);
      if (p) return `<video class="media" controls preload="none" src="${escapeHtml(p)}"></video>`;
      return '<span class="ph">[视频]</span>';
    }
    case 'ptt': {
      const p = localPath(el);
      const name = el.data.fileName ? `<small class="cap">${escapeHtml(el.data.fileName)}</small>` : '';
      if (p) return `<span class="voice"><audio controls preload="none" src="${escapeHtml(p)}"></audio>${name}</span>`;
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
    case 'markdown':
      return escapeMultiline(el.data.markdownTextSummary || el.data.markdownContent || '[Markdown]');
    case 'grayTipRevoke':
      return `<span class="ph">[${escapeHtml(el.data.recallDisplayText || '撤回了一条消息')}]</span>`;
    case 'unknown':
      return '';
    default:
      return PLACEHOLDER[el.type] ? `<span class="ph">${PLACEHOLDER[el.type]}</span>` : '';
  }
}

/** All elements → the bubble body (reply quote floats to the top). */
function renderBody(elements: RenderElement[], collectFaces?: Set<string>): string {
  const quotes = elements.filter((e) => e.type === 'reply').map((e) => renderElement(e, collectFaces)).join('');
  const rest = elements.filter((e) => e.type !== 'reply').map((e) => renderElement(e, collectFaces)).join('');
  return quotes + rest;
}

/** One message → a bubble row, or a centered system line for gray-tip-only messages. */
function renderMessage(m: ExportedMessage, sender: ResolvedSender, selfId: string | undefined, collectFaces?: Set<string>): string {
  if (isSystemOnly(m.elements)) {
    return `<div class="sys">${escapeHtml(elementsToText(m.elements).replace(/[[\]]/g, ''))}</div>\n`;
  }
  const isSelf = Boolean(selfId) && sender.platformId === selfId;
  const name = escapeHtml(sender.groupNickname || sender.accountName);
  const numeric = /^\d+$/.test(sender.platformId);
  const ava = numeric
    ? `<img class="ava" loading="lazy" src="${escapeHtml(avatarUrlForUin(sender.platformId))}" alt="">`
    : `<span class="ava ava-none">${escapeHtml((sender.accountName || '?').slice(0, 1))}</span>`;
  const role =
    sender.role === 'owner' ? '<span class="role owner">群主</span>' : sender.role === 'admin' ? '<span class="role">管理员</span>' : '';
  const body = renderBody(m.elements, collectFaces);
  return (
    `<div class="msg${isSelf ? ' me' : ''}">${ava}` +
    `<div class="col"><div class="meta"><span class="name">${name}</span>${role}` +
    `<span class="time">${escapeHtml(formatTime(m.sendTime))}</span></div>` +
    `<div class="bubble">${body}</div></div></div>\n`
  );
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
.day{text-align:center;margin:22px 0 12px}.day span{background:rgba(140,140,140,.18);color:var(--sub);font-size:12px;padding:2px 10px;border-radius:10px}
.sys{text-align:center;color:var(--sub);font-size:12px;margin:14px 0}
.msg{display:flex;gap:10px;margin:18px 0;content-visibility:auto;contain-intrinsic-size:auto 72px;border-radius:8px;transition:background .2s}
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
.ph{color:var(--sub)}
.foot{text-align:center;color:var(--sub);font-size:12px;padding:16px}
`;

/**
 * Inline page script (no framework): on load jump to the newest message (bottom)
 * so the user scrolls *up* into history; plus a content search that lists
 * matching messages and scroll-jumps + flashes the one clicked. The message
 * index is built lazily on first search to keep load fast on large logs.
 */
const SCRIPT = `
(function(){
  function toBottom(){window.scrollTo(0,document.documentElement.scrollHeight);}
  toBottom();window.addEventListener('load',toBottom);
  var q=document.getElementById('q'),results=document.getElementById('results'),qinfo=document.getElementById('qinfo');
  if(!q)return;
  var index=null,timer=0,flashed=null;
  function build(){index=[];var rows=document.querySelectorAll('.msg,.sys');
    for(var i=0;i<rows.length;i++){var r=rows[i],t=r.textContent||'',n=r.querySelector('.name'),tm=r.querySelector('.time');
      index.push({el:r,text:t,low:t.toLowerCase(),name:n?n.textContent:'',time:tm?tm.textContent:''});}}
  function clearFlash(){if(flashed){flashed.classList.remove('flash');flashed=null;}}
  function jump(it){results.hidden=true;clearFlash();it.el.scrollIntoView({behavior:'smooth',block:'center'});
    void it.el.offsetWidth;it.el.classList.add('flash');flashed=it.el;}
  function snip(text,low,term){var i=low.indexOf(term);if(i<0)i=0;var s=Math.max(0,i-18);
    var f=document.createDocumentFragment();
    f.appendChild(document.createTextNode((s>0?'…':'')+text.slice(s,i)));
    var m=document.createElement('mark');m.textContent=text.slice(i,i+term.length);f.appendChild(m);
    var e=i+term.length;f.appendChild(document.createTextNode(text.slice(e,e+44)+(text.length>e+44?'…':'')));return f;}
  function run(){var term=q.value.trim().toLowerCase();results.innerHTML='';
    if(!term){results.hidden=true;qinfo.textContent='';return;}
    if(!index)build();var hits=[],total=0;
    for(var i=0;i<index.length;i++){if(index[i].low.indexOf(term)!==-1){total++;if(hits.length<300)hits.push(index[i]);}}
    qinfo.textContent=total?total+' 条结果':'无结果';
    if(!total){results.hidden=true;return;}
    var frag=document.createDocumentFragment();
    hits.forEach(function(it){var b=document.createElement('button');b.type='button';b.className='ritem';
      var mt=document.createElement('span');mt.className='rmeta';mt.textContent=(it.name?it.name+' · ':'')+it.time;
      var sn=document.createElement('span');sn.className='rsnip';sn.appendChild(snip(it.text,it.low,term));
      b.appendChild(mt);b.appendChild(sn);b.addEventListener('click',function(){jump(it);});frag.appendChild(b);});
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

  // ---- resolve self (for right-aligning own messages) + members ----
  const self = deps.self ? await deps.self().catch(() => null) : null;
  let selfId = self ? (self.uin && self.uin !== '0' ? self.uin : self.uid) : undefined;

  let senders: Map<string, ResolvedSender>;
  let convName = opts.name;
  if (opts.kind === 'group') {
    const meta = deps.groupMeta ? await deps.groupMeta(opts.conv).catch(() => null) : null;
    if (meta?.name) convName = opts.name || meta.name;
    opts.onProgress?.({ current: 0, message: '解析成员…' });
    senders = await resolveGroupSenders(msgs, opts.conv, opts.range, deps, meta?.ownerUid ?? '');
  } else {
    const r = await resolveC2cSenders(opts.conv, deps);
    senders = r.senders;
    selfId = selfId ?? r.ownerId;
  }

  // ---- write ----
  const stream = createWriteStream(opts.outputPath, { encoding: 'utf-8' });
  const write = async (chunk: string): Promise<void> => {
    if (!stream.write(chunk)) await once(stream, 'drain');
  };

  const title = escapeHtml(convName || (opts.kind === 'group' ? '群聊' : '私聊'));
  const exportedAt = escapeHtml(formatTime(Math.floor(Date.now() / 1000)));
  await write(
    `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${title} · 聊天记录</title>\n` +
      `<style>${STYLE}</style>\n</head>\n<body>\n<div class="frame">\n` +
      `<header class="head">\n` +
      `<div class="head-top"><strong>${title}</strong><small>${opts.kind === 'group' ? '群聊' : '私聊'} · 导出于 ${exportedAt}</small></div>\n` +
      `<div class="search"><input id="q" type="search" placeholder="搜索消息内容…" autocomplete="off" spellcheck="false"><span id="qinfo"></span><div id="results" class="results" hidden></div></div>\n` +
      `</header>\n<main class="log">\n`,
  );

  let count = 0;
  let lastDay = '';
  try {
    for await (const raw of iterateConv(msgs, opts.kind, opts.conv, opts.range)) {
      const exported = toExportedMessage(raw);
      opts.collectSenders?.add(exported.senderUin);
      if (opts.withMediaPaths) annotateLocalPaths(exported.elements);
      const day = dayKey(exported.sendTime);
      if (day !== lastDay) {
        await write(`<div class="day"><span>${escapeHtml(day)}</span></div>\n`);
        lastDay = day;
      }
      const sender = senders.get(exported.senderUid) ?? fallbackSender(exported);
      await write(renderMessage(exported, sender, selfId, opts.collectFaces));
      count += 1;
      if (count % progressEvery === 0) opts.onProgress?.({ current: count, message: `已导出 ${count} 条` });
    }
    await write(
      `</main>\n<footer class="foot">共 ${count} 条消息 · 顶部搜索框可检索并点击跳转</footer>\n</div>\n` +
        `<script>${SCRIPT}</script>\n</body>\n</html>\n`,
    );
  } finally {
    stream.end();
    await once(stream, 'finish');
  }

  return {
    filePath: opts.outputPath,
    format: 'html',
    messageCount: count,
    fileSize: statSync(opts.outputPath).size,
    durationMs: Date.now() - start,
  };
}
