// @ts-nocheck
/**
 * 草稿正文（40800 元素数组）↔ 模板输入框文本的往返。
 *
 * 输入框本体是 `contentEditable` + 一套 token 字符串（见 composer.tsx），它只认识
 * 纯文本和表情 token。而 QQ 的草稿正文是**完整的 40800 元素数组** —— 文本 / @ /
 * 表情 / 图片 / 视频 / 文件 / markdown / ark / 引用…… 都可能出现（实测三条真实
 * 草稿里就有「文本 + 图片」「文本 + 表情」）。
 *
 * 所以这里给每个「输入框表达不了的元素」发一个**元素 token**：把整条 wire 元素
 * （含 Uint8Array 字段）序列化进 token 里，输入框把它渲染成一枚 chip（如 `[图片]`），
 * 提交/存草稿时原样还原。这样任何元素类型都能无损往返，不需要为每种类型单独写一遍
 * 前端结构 —— 「按 40800 全量解析」这条要求就落在元素层，而不是散在 UI 里。
 *
 * token 形如：`[[chat:elem:<base64url(JSON)>]]`
 */

import { emojiUrl, localMediaUrl } from '../../lib/resourceUrl';

/** 元素 token 的前缀 / 后缀，配合 composer 的 token 解析使用。 */
export const ELEMENT_TOKEN_PREFIX = '[[chat:elem:';
export const ELEMENT_TOKEN_SUFFIX = ']]';

/** Uint8Array 在 JSON 里的替身（序列化 / 反序列化共用）。 */
type U8Box = { __u8: number[] };

function isU8Box(v: unknown): v is U8Box {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as U8Box).__u8) &&
    Object.keys(v as object).length === 1
  );
}

/** 深度把 Uint8Array 换成可 JSON 化的盒子（其余原样）。 */
function boxBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return { __u8: Array.from(value) } satisfies U8Box;
  if (Array.isArray(value)) return value.map(boxBytes);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = boxBytes(v);
    return out;
  }
  return value;
}

/** {@link boxBytes} 的逆操作。 */
function unboxBytes(value: unknown): unknown {
  if (isU8Box(value)) return Uint8Array.from(value.__u8);
  if (Array.isArray(value)) return value.map(unboxBytes);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = unboxBytes(v);
    return out;
  }
  return value;
}

/** base64url（无填充），避免 token 里出现 `+` `/` `=` 干扰解析。 */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(token: string): string {
  const padded = token.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 把一个元素编成 token。 */
export function elementToToken(element: unknown): string {
  const json = JSON.stringify(boxBytes(element));
  return `${ELEMENT_TOKEN_PREFIX}${toBase64Url(json)}${ELEMENT_TOKEN_SUFFIX}`;
}

/** 从 token 还原元素；不是元素 token / 解不出来时返回 null。 */
export function tokenToElement(token: string): unknown | null {
  if (!token.startsWith(ELEMENT_TOKEN_PREFIX) || !token.endsWith(ELEMENT_TOKEN_SUFFIX)) {
    return null;
  }
  const body = token.slice(ELEMENT_TOKEN_PREFIX.length, -ELEMENT_TOKEN_SUFFIX.length);
  try {
    return unboxBytes(JSON.parse(fromBase64Url(body)));
  } catch {
    return null;
  }
}

/** chip 上显示什么（给人看，不参与还原）。 */
export function elementLabel(element: unknown): string {
  const kind = (element as { kind?: string })?.kind;
  const data = element as Record<string, unknown> | null;
  switch (kind) {
    case 'at':
      return String(data?.textContent ?? '@');
    case 'face':
      return String(data?.faceText ?? '[表情]');
    // 表情弹射：chip 上直接写「×N」的总结（真机样本「你弹射了3个[大笑]」），
    // 不认得这个字段的旧草稿就退回一个通用标签。
    case 'emojiBounce':
      return String(data?.emojiBounceTextSummary ?? data?.emojiBouncePcText ?? '[表情弹射]');
    case 'pic':
      return '[图片]';
    case 'video':
    case 'bubbleVideo':
      return '[视频]';
    case 'file':
      return '[文件]';
    case 'ptt':
      return '[语音]';
    case 'mface':
      return '[表情]';
    case 'ark':
      return '[卡片]';
    case 'markdown':
      return '[Markdown]';
    case 'multiMsg':
      return '[合并转发]';
    case 'reply':
      return '[引用]';
    case 'wallet':
      return '[红包]';
    case 'onlineFile':
      return '[在线文件]';
    case 'onlineFolder':
      return '[在线文件夹]';
    case 'unknown':
      return '[消息]';
    default:
      return '[消息]';
  }
}

/**
 * 输入框里画这枚元素 chip 时用的预览图 src；画不出来就返回 null（退回文本标签）。
 *
 * 只处理两类「本来就有图」的元素：
 *   - pic：先用元素自带的本地预览地址（本会话里刚插进来的图是 blob:）；没有就
 *     从 `localPath`（wire tag 45004）里剥出相对 QQ 图片缓存的相对路径 —— QQ 草稿里
 *     的图片长成 `…/nt_data/Pic/<月>/Ori/<md5>.<ext>`，媒体协议按这个 rel 直接读得出来。
 *   - face：按 faceId 拼系统表情资源地址（与 emojiPacks.systemFaceItem 同一规则）。
 *
 * 文件 / ark / 引用等本来就没有缩略图，继续走文本标签。
 */
export function elementPreviewSrc(element: unknown): string | null {
  const kind = (element as { kind?: string } | null)?.kind;
  const data = element as Record<string, unknown> | null;
  if (kind === 'pic') {
    const direct = typeof data?.localPreviewUrl === 'string' ? data.localPreviewUrl : '';
    if (direct) return direct;
    const rel = picRelFromLocalPath(data?.localPath);
    return rel ? localMediaUrl('pic', rel) : null;
  }
  if (kind === 'face') {
    const id = String(data?.faceId ?? '');
    return /^\d+$/.test(id) ? emojiUrl(id, 'apng', `${id}.png`) : null;
  }
  return null;
}

/** `…/nt_data/Pic/<月>/Ori/<name>` → `<月>/Ori/<name>`（认不出就 null）。 */
function picRelFromLocalPath(localPath: unknown): string | null {
  if (typeof localPath !== 'string' || !localPath) return null;
  const match = /[\\/]nt_data[\\/]Pic[\\/](.+)$/.exec(localPath);
  const rel = match?.[1];
  return rel ? rel.replace(/\\/g, '/') : null;
}

/**
 * 草稿元素数组 → 输入框文本。
 *
 * 文本 / @ 直接铺成字面文本（@ 的提醒语义在元素里，文本只是给人看的）；
 * 其余元素一律编成元素 token，交给输入框渲染成 chip。
 */
export function elementsToComposerText(elements: readonly unknown[]): string {
  const out: string[] = [];
  for (const element of elements ?? []) {
    const kind = (element as { kind?: string })?.kind;
    if (kind === 'text' || kind === 'at') {
      out.push(String((element as { textContent?: string }).textContent ?? ''));
      continue;
    }
    out.push(elementToToken(element));
  }
  return out.join('');
}

/**
 * 输入框文本 → 草稿元素数组。认识两种 token：
 *   - 元素 token（本模块产的）        → 原样还原 wire 元素
 *   - 模板自带的表情 token `[名字]`   → 交给 {@link decodeElement} 前先落回文本
 *     （模板表情包是内置 mock，跟 QQ 的 faceId 目录不是一套，所以不猜 faceId）
 * 其余按纯文本处理。空白文本段被丢弃（与模板 composer 的 trim 语义一致）。
 */
export function composerTextToElements(text: string): unknown[] {
  const out: unknown[] = [];
  // 元素 token 与模板表情 token（`[名字]`）都要认；表情 token 落到纯文本 ——
  // 模板表情包是内置 mock，跟 QQ 的 faceId 目录不是一套，不猜 faceId。
  const pattern =
    /\[\[chat:elem:([^\]]+)\]\]|\[\[chat:emoji:[a-z0-9_-]+:[^\]]+\]\]|\[([^\]\n]{1,32})\]/gi;
  let cursor = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > cursor) pushText(out, text.slice(cursor, match.index));
    const element = match[1] === undefined ? null : tokenToElement(match[0]);
    if (element) {
      out.push(element);
    } else {
      // 表情 token / 解不出来的元素 token 一律当字面文本保留。
      pushText(out, match[0]);
    }
    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (cursor < text.length) pushText(out, text.slice(cursor));
  return out;
}

function pushText(out: unknown[], value: string): void {
  if (value.length === 0) return;
  out.push({ kind: 'text', textContent: value });
}

/**
 * 把元素数组转成 IPC 安全的形状：`Uint8Array` → `{type:'Buffer',data:[...]}`。
 * 与主进程 `serde.elementsFromEditable` 的约定一致（它会把这种盒子还原成
 * `Uint8Array`），这样 `account.saveDraft` 传过去的元素能被原样解码写库。
 */
export function toIpcElements(elements: readonly unknown[]): unknown[] {
  return elements.map((element) => boxForIpc(element));
}

function boxForIpc(value: unknown): unknown {
  if (value instanceof Uint8Array) return { type: 'Buffer', data: Array.from(value) };
  if (Array.isArray(value)) return value.map(boxForIpc);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = boxForIpc(v);
    return out;
  }
  return value;
}
