/**
 * Render a message's elements to a plain-text summary, for the TXT exporter
 * (and reusable as alt-text elsewhere). Non-text media collapse to a bracketed
 * label (`[图片]`, `[视频]`, …) the way a chat log preview would show them.
 *
 * Sender names are NOT resolved here — TXT shows the sender uin. Nickname /
 * group-card resolution needs profile / member lookups and is a later step,
 * same as media completion.
 */

import type { RenderElement } from '../msg_view';
import type { ExportedMessage } from './types';

/** Fixed bracket labels for media kinds that carry no useful text. */
const LABEL: Record<string, string> = {
  pic: '[图片]',
  video: '[视频]',
  ptt: '[语音]',
  mface: '[表情]',
  ark: '[卡片消息]',
  multiMsg: '[合并转发]',
  call: '[通话]',
  wallet: '[红包/转账]',
  qqDynamic: '[动态]',
  emojiBounce: '[表情]',
  onlineFolder: '[文件夹]',
};

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** One element → its text fragment. */
export function elementToText(el: RenderElement): string {
  switch (el.type) {
    case 'text':
      return el.data.textContent ?? '';
    case 'at':
      return el.data.textContent ?? '';
    case 'face':
      return el.data.faceText ? `[${el.data.faceText}]` : '[表情]';
    case 'file':
    case 'onlineFile':
      return `[文件: ${el.data.fileName || ''}]`;
    case 'reply': {
      const summary = elementsToText(el.data.origElements ?? []).trim();
      return summary ? `[回复: ${truncate(summary, 30)}] ` : '[回复] ';
    }
    case 'markdown':
      return el.data.markdownTextSummary || el.data.markdownContent || '[Markdown]';
    case 'grayTipRevoke':
      return `[${el.data.recallDisplayText || '撤回了一条消息'}]`;
    case 'grayTipPoke':
      return '[戳一戳]';
    case 'grayTipGroup':
    case 'grayTipInvite':
      return '[群提示]';
    case 'unknown':
      return '';
    default:
      return LABEL[el.type] ?? '';
  }
}

/** All elements → concatenated text. */
export function elementsToText(elements: RenderElement[]): string {
  return elements.map(elementToText).join('');
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Unix seconds → `YYYY-MM-DD HH:mm:ss` in local time. */
export function formatTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** One message → a single log line: `[time] <uin>: <content>`. */
export function messageToText(m: ExportedMessage): string {
  return `[${formatTime(m.sendTime)}] ${m.senderUin}: ${elementsToText(m.elements)}`;
}
