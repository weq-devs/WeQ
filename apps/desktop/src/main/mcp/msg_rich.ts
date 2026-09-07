/**
 * Rich-message helpers for the AI tool registry.
 *
 * The old `flattenElements` in tools.ts treated everything as a coarse
 * bracket label, which hid exactly the parts users ask about (quoted replies,
 * markdown bodies, gray-tips, QQ 动态, voice transcripts …). WeQ's export
 * pipeline already knows how to render every element kind into plain text
 * (`elementToText` / `elementsToText`), so this module reuses that as the
 * single source of truth and adds the extras the exporter deliberately drops:
 * stored voice transcripts and on-disk media resolution.
 */

import { elementToText, elementsToText, type RenderElement } from '@weq/service';
import type { FileType } from '@weq/service';

/** The surface of FileSearchService the helpers need (avoids service import
 *  cycles and keeps this module usable in tests with a stub). */
export interface MediaLocator {
  findFile(
    timestamp: number,
    filename: string,
    type: FileType,
  ): Promise<{
    source: string | null;
    thumb: string | null;
  }>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Truncate long payload strings for model output while saying they were cut. */
function snippet(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（已截断，原文 ${s.length} 字）`;
}

/** One element → a human-readable line. Voice transcripts and reply quotes are
 *  included here even though the plain exporters collapse them. */
export function elementToAiText(el: RenderElement): string {
  if (el.type === 'ptt') {
    const transcript = str(el.data.pttTranscript).trim();
    if (transcript) return `[语音转写: ${transcript}]`;
    return elementToText(el);
  }
  if (el.type === 'reply') {
    const quote = elementsToText(el.data.origElements ?? []).trim();
    return quote ? `[回复: ${quote}]` : '[回复]';
  }
  return elementToText(el);
}

/** All elements → concatenated text with the same fallback as the old
 *  projection (`[空消息]` only when nothing meaningful survived). */
export function elementsToAiText(elements: readonly unknown[]): string {
  const parts = (elements ?? [])
    .map((el) => elementToAiText(el as RenderElement))
    .filter((t) => t.trim());
  return parts.join(' ').trim() || '[空消息]';
}

/** Optional structured payload for a single element — enough for the model to
 *  quote real content without seeing every raw CDN token. */
export function elementAiPayload(el: RenderElement): Record<string, unknown> {
  const d = el.data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  switch (el.type) {
    case 'text':
    case 'at':
      out.text = str(d.textContent);
      break;
    case 'face':
      out.faceId = num(d.faceId);
      out.faceText = str(d.faceText);
      break;
    case 'reply':
      if (d.origMsgId !== undefined && d.origMsgId !== null && d.origMsgId !== 0n) {
        out.origMsgId = String(d.origMsgId);
      }
      if (str(d.origSenderUid)) out.origSenderUid = str(d.origSenderUid);
      if (Array.isArray(d.origElements) && d.origElements.length) {
        out.quoteText = elementsToText(d.origElements as RenderElement[]).trim();
      }
      break;
    case 'markdown': {
      const content = str(d.markdownContent).trim();
      const summary = str(d.markdownTextSummary).trim();
      if (content) out.content = snippet(content);
      else if (summary) out.content = snippet(summary);
      break;
    }
    case 'ark':
      if (str(d.arkData)) out.payload = snippet(str(d.arkData));
      break;
    case 'multiMsg':
      if (str(d.resId)) out.resId = str(d.resId);
      if (str(d.sessionId)) out.sessionId = str(d.sessionId);
      break;
    case 'grayTipRevoke':
      if (str(d.recallDisplayText)) out.text = str(d.recallDisplayText);
      break;
    case 'grayTipPoke':
    case 'grayTipXml':
      if (str(d.grayTipXmlContent)) out.xml = snippet(str(d.grayTipXmlContent), 2000);
      if (str(d.tipJson)) out.tipJson = snippet(str(d.tipJson), 2000);
      break;
    case 'grayTipGroup':
      if (str(d.user1GroupNick) || str(d.user1Nick))
        out.user1 = str(d.user1GroupNick) || str(d.user1Nick);
      if (str(d.user2GroupNick) || str(d.user2Nick))
        out.user2 = str(d.user2GroupNick) || str(d.user2Nick);
      if (str(d.groupTipGroupName)) out.groupName = str(d.groupTipGroupName);
      break;
    case 'call':
      if (Array.isArray(d.callSummary)) out.callSummary = d.callSummary;
      break;
    case 'qqDynamic': {
      const desc = d.dynamicDesc as Record<string, unknown> | undefined;
      const desc2 = d.dynamicDesc2 as Record<string, unknown> | undefined;
      const main = str(desc?.mainDesc) || str(desc2?.mainDesc);
      if (main) out.title = main;
      if (str(d.dynamicCoverUrl)) out.coverUrl = str(d.dynamicCoverUrl);
      break;
    }
    case 'emojiBounce':
      if (str(d.emojiBounceTextSummary) || str(d.emojiBouncePcText)) {
        out.text = str(d.emojiBounceTextSummary) || str(d.emojiBouncePcText);
      }
      break;
    case 'inlineKeyboard': {
      const rows = d.rows as Array<Array<Record<string, unknown>>> | undefined;
      if (Array.isArray(rows)) {
        out.buttons = rows
          .flat()
          .map((b) => str(b.label))
          .filter(Boolean);
      }
      break;
    }
    case 'shareLocation':
      if (str(d.shareLocationText)) out.text = str(d.shareLocationText);
      break;
    default:
      break;
  }
  return out;
}

/** A resolved local-media view returned to the model. */
export interface ElementMedia {
  kind: string;
  fileName?: string;
  fileSize?: number;
  transcript?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  widthHeightLabel?: string;
  localPath?: string;
  thumbnailPath?: string;
  foundLocally: boolean;
}

/**
 * Try to find a media element's actual file in QQ's local media caches.
 * Pure local lookup — never downloads from CDN.
 */
export async function mediaForElement(
  locator: MediaLocator,
  sendTimeSec: number,
  el: RenderElement,
): Promise<ElementMedia | null> {
  const d = el.data as Record<string, unknown>;
  const fileName = str(d.fileName).trim();
  const out: ElementMedia = { kind: el.type, foundLocally: false };
  if (el.type === 'pic') {
    out.fileName = fileName || undefined;
    out.fileSize = num(d.fileSize);
    out.width = num(d.imgWidth);
    out.height = num(d.imgHeight);
    out.widthHeightLabel = out.width && out.height ? `${out.width}×${out.height}` : undefined;
    const isEmoji = num(d.subType) === 1;
    out.kind = isEmoji ? 'emoji' : 'image';
    if (!fileName) return null;
    const hit = await locator.findFile(sendTimeSec, fileName, isEmoji ? 'emoji' : 'pic');
    out.localPath = hit.source ?? (isEmoji ? hit.thumb : undefined) ?? undefined;
    out.thumbnailPath = hit.thumb ?? undefined;
    out.foundLocally = Boolean(out.localPath || out.thumbnailPath);
    return out;
  }
  if (el.type === 'ptt') {
    out.fileName = fileName || undefined;
    out.fileSize = num(d.fileSize);
    out.durationSec = num(d.pttDuration);
    out.transcript = str(d.pttTranscript).trim() || undefined;
    if (fileName) {
      const hit = await locator.findFile(sendTimeSec, fileName, 'ptt');
      out.localPath = hit.source ?? undefined;
      out.foundLocally = Boolean(out.localPath);
    }
    return out;
  }
  if (el.type === 'video') {
    out.fileName = fileName || undefined;
    out.fileSize = num(d.fileSize);
    out.durationSec = num(d.videoDuration);
    out.width = num(d.videoWidth);
    out.height = num(d.videoHeight);
    out.widthHeightLabel = out.width && out.height ? `${out.width}×${out.height}` : undefined;
    if (fileName) {
      const hit = await locator.findFile(sendTimeSec, fileName, 'video');
      out.localPath = hit.source ?? undefined;
      out.thumbnailPath = hit.thumb ?? undefined;
      out.foundLocally = Boolean(out.localPath || out.thumbnailPath);
    }
    return out;
  }
  if (el.type === 'file' || el.type === 'onlineFile' || el.type === 'grayTipFileRecv') {
    out.fileName = fileName || undefined;
    out.fileSize = num(d.fileSize);
    if (fileName) {
      const hit = await locator.findFile(sendTimeSec, fileName, 'file');
      out.localPath = hit.source ?? undefined;
      out.foundLocally = Boolean(out.localPath);
    }
    return out;
  }
  return null;
}

/** Resolve all local media references in a message's elements (capped). */
export async function mediaForElements(
  locator: MediaLocator,
  sendTimeSec: number,
  elements: readonly RenderElement[],
  cap = 12,
): Promise<ElementMedia[]> {
  const mediaTypes = new Set(['pic', 'ptt', 'video', 'file', 'onlineFile', 'grayTipFileRecv']);
  const targets = (elements ?? []).filter((el) => mediaTypes.has(el.type)).slice(0, cap);
  const out: ElementMedia[] = [];
  for (const el of targets) {
    const hit = await mediaForElement(locator, sendTimeSec, el);
    if (hit) out.push(hit);
  }
  return out;
}

/** Compact per-element view used by `get_message_details`. */
export function elementAiDetail(
  el: RenderElement,
  index: number,
  includePayload: boolean,
): { index: number; kind: string; text: string; payload?: Record<string, unknown> } {
  const base = {
    index,
    kind: el.type,
    text: elementToAiText(el),
  };
  if (!includePayload) return base;
  const payload = elementAiPayload(el);
  return Object.keys(payload).length ? { ...base, payload } : base;
}
