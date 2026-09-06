/**
 * Shared helpers for the message-table accessors (c2c / group).
 *
 * `decodeBody` turns a 40800 BLOB into `Element[]`; `toBigint` / `toStr`
 * coerce raw `SqlValue`s. Kept here so c2c.ts and group.ts don't duplicate
 * the codec wiring.
 */

import { ProtoMsg, decodeElement, decodeMsgDressColumn } from '@weq/codec';
import type { Element, SetEmojiItem, MsgDecoration } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { MsgEmoji } from '@weq/codec/proto/msg/40062';
import type { SqlRow, SqlValue } from '@weq/native';
import type { DressTally } from './types';

const bodyCodec = new ProtoMsg(MsgBody);
const emojiCodec = new ProtoMsg(MsgEmoji);

export function decodeBody(blob: SqlValue | undefined): Element[] {
  if (!(blob instanceof Uint8Array)) return [];
  try {
    // Sanitize first: drop fields whose on-wire type conflicts with the schema
    // so one mis-declared tag can't derail the whole message.
    const decoded = bodyCodec.decode(sanitizeBytes(blob, MsgBody));
    return (decoded.elements ?? []).map(decodeElement);
  } catch (e) {
    console.error('[msg] failed to decode 40800 body:', e);
    return [{ kind: 'text', textContent: '[解析消息失败: 格式错误]' }];
  }
}

/**
 * Decode the 40062 BLOB (group message "贴表情"/sticker reactions). The column
 * is a protobuf whose only field is a repeated tag-40062 entry, one per emoji
 * reaction. Returns `undefined` when the column is empty/absent so the field is
 * simply omitted from the message.
 *
 * 没有贴表情的消息里这一列不是 NULL 而是 4 字节的空占位 `f2c71300`(tag 40062,
 * 长度 0),解出来是一个 emojiId=''/setNum=0 的条目 —— 直接渲染就成了「贴了 0
 * 个表情」。真实条目的 emojiId 非空且 setNum≥1(全库 15346 条无例外),所以按
 * emojiId 过滤即可。
 */
export function decodeEmoji(blob: SqlValue | undefined): SetEmojiItem[] | undefined {
  if (!(blob instanceof Uint8Array)) return undefined;
  try {
    const decoded = emojiCodec.decode(sanitizeBytes(blob, MsgEmoji));
    const list = (decoded.stickers ?? [])
      .filter((s) => !!s.emojiId)
      .map((s) => ({
        emojiId: s.emojiId ?? '',
        setNum: s.emojiNum ?? 0,
        isSelfSet: !!s.isSelfSet,
      }));
    return list.length > 0 ? list : undefined;
  } catch (e) {
    console.error('[msg] failed to decode 40062 emoji:', e);
    return undefined;
  }
}

export function decodeDress(blob: SqlValue | undefined): MsgDecoration | undefined {
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0) return undefined;
  return decodeMsgDressColumn(blob) ?? undefined;
}

export function emptyDressTally(): DressTally {
  return { bubble: {}, font: {}, widget: {}, decorated: 0, outfits: {} };
}

/** 每套装扮最多留几条真实消息样本 —— 报告滚动带子够用，又不至于把 JSON 撑大。 */
const SAMPLES_PER_OUTFIT = 24;
/** 单条样本的字数上限。气泡里画不下长篇，超长的截断加省略号。 */
const SAMPLE_MAX_CHARS = 42;

/**
 * 一条消息的正文 → 适合画进气泡的一行纯文本，不合适的返回空串。
 *
 * 只要 text / at 两类元素拼出来的字：图片、语音、表情包、卡片、灰字提示画进气泡都
 * 是「[图片]」这种方括号占位，没有回忆价值，反而会让整条带子看起来像日志。纯表情、
 * 纯空白、纯标点同理丢掉。
 *
 * 这里不复用 service 的 `elementsToText` —— 那个是给导出用的，会把媒体铺开成带标签
 * 的占位文本，正是这里要排除的东西；而且 db 层不该反向依赖 service。
 */
function sampleTextOf(elements: Element[]): string {
  let text = '';
  for (const el of elements) {
    if (el.kind === 'text') text += el.textContent ?? '';
    else if (el.kind === 'at') text += el.textContent ?? '';
    else if (el.kind === 'reply')
      continue; // 回复引用只是上下文，不算这条说了什么。
    else return ''; // 混了媒体就整条不要，避免半句话配一个 [图片]。
  }
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return '';
  // 至少要有一个中日韩汉字、假名或字母数字，纯标点/纯符号的不算「说过的话」。
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{L}\p{N}]/u.test(clean)) return '';
  return clean.length > SAMPLE_MAX_CHARS ? `${clean.slice(0, SAMPLE_MAX_CHARS)}…` : clean;
}

/**
 * 把一批 `SELECT "40801","40800","40050"` 的行累加进一份 {@link DressTally}。
 *
 * 装扮在时间上是「一段一段」的：同一套用几个月，那几个月里每条消息的 40801 字节
 * **完全相同**。所以解码前先按字节内容查一层 map —— 十几万行的扫描通常只落到几十次
 * 真实 protobuf 解码上，其余全是哈希命中。缓存只活在这一次调用里（跨调用留着没有
 * 意义：一次扫描就是一次全量）。
 *
 * 40800 消息体的解码则**按需**：只有当这套装扮的样本还没攒够 {@link SAMPLES_PER_OUTFIT}
 * 条时才解一条。所以全表扫描里真正解正文的次数上界是「套数 × 24」——几十套也就千把
 * 次，与「每行都解」差着两个数量级。
 *
 * 坏行（解不出 / 全零）静默跳过 —— 装扮统计不该因为一条畸形消息整页失败。
 */
export function tallyDressBlobs(rows: SqlRow[], into: DressTally): DressTally {
  const decoded = new Map<string, MsgDecoration | null>();
  for (const row of rows) {
    const blob = row[0];
    if (!(blob instanceof Uint8Array) || blob.byteLength === 0) continue;
    const key = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength).toString('latin1');
    let dress = decoded.get(key);
    if (dress === undefined) {
      dress = decodeMsgDressColumn(blob);
      decoded.set(key, dress);
    }
    if (!dress) continue;
    if (dress.bubbleId > 0) into.bubble[dress.bubbleId] = (into.bubble[dress.bubbleId] ?? 0) + 1;
    if (dress.fontId > 0) into.font[dress.fontId] = (into.font[dress.fontId] ?? 0) + 1;
    if (dress.widgetId > 0) into.widget[dress.widgetId] = (into.widget[dress.widgetId] ?? 0) + 1;
    into.decorated += 1;

    const outfitKey = `${dress.bubbleId}:${dress.fontId}:${dress.widgetId}`;
    let outfit = into.outfits[outfitKey];
    if (!outfit) {
      outfit = {
        bubbleId: dress.bubbleId,
        fontId: dress.fontId,
        widgetId: dress.widgetId,
        count: 0,
        samples: [],
        firstTime: 0,
        lastTime: 0,
      };
      into.outfits[outfitKey] = outfit;
    }
    outfit.count += 1;

    const sendTime = Number(row[2] ?? 0);
    if (sendTime > 0) {
      if (outfit.firstTime === 0 || sendTime < outfit.firstTime) outfit.firstTime = sendTime;
      if (sendTime > outfit.lastTime) outfit.lastTime = sendTime;
    }

    // 样本够了就完全不碰 40800 —— 这是这次扫描能保持轻量的关键。
    if (outfit.samples.length >= SAMPLES_PER_OUTFIT) continue;
    const body = row[1];
    if (!(body instanceof Uint8Array) || body.byteLength === 0) continue;
    const text = sampleTextOf(decodeBody(body));
    if (text && !outfit.samples.includes(text)) outfit.samples.push(text);
  }
  return into;
}

/** 把若干份 tally（私聊 / 群聊）合并成一份。 */
export function mergeDressTally(parts: DressTally[]): DressTally {
  const out = emptyDressTally();
  for (const part of parts) {
    for (const kind of ['bubble', 'font', 'widget'] as const) {
      for (const [id, count] of Object.entries(part[kind])) {
        out[kind][Number(id)] = (out[kind][Number(id)] ?? 0) + count;
      }
    }
    out.decorated += part.decorated;
    for (const [key, outfit] of Object.entries(part.outfits)) {
      const existing = out.outfits[key];
      if (!existing) {
        out.outfits[key] = { ...outfit, samples: [...outfit.samples] };
        continue;
      }
      existing.count += outfit.count;
      if (
        outfit.firstTime > 0 &&
        (existing.firstTime === 0 || outfit.firstTime < existing.firstTime)
      ) {
        existing.firstTime = outfit.firstTime;
      }
      if (outfit.lastTime > existing.lastTime) existing.lastTime = outfit.lastTime;
      // 两张表各自攒满过，合并后按同样的上限截断，并且去重。
      for (const sample of outfit.samples) {
        if (existing.samples.length >= SAMPLES_PER_OUTFIT) break;
        if (!existing.samples.includes(sample)) existing.samples.push(sample);
      }
    }
  }
  return out;
}

export function toBigint(v: SqlValue | undefined): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

export function toStr(v: SqlValue | undefined): string {
  return typeof v === 'string' ? v : String(v ?? '');
}
