import { z } from 'zod';

const segmentSchema = z.object({ type: z.string(), data: z.record(z.unknown()) });
export type Segment = z.infer<typeof segmentSchema>;
export type Params = Record<string, unknown>;

export class ActionError extends Error {
  constructor(
    message: string,
    readonly retcode = 1400,
  ) {
    super(message);
  }
}

export function id(value: unknown): string {
  const text = String(value ?? '');
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new ActionError('QQ 号或群号无效');
  return text;
}

export function bool(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === 'true' || value === '1' || value === 'yes')
    return true;
  if (value === false || value === 0 || value === 'false' || value === '0' || value === 'no')
    return false;
  throw new ActionError('布尔参数无效');
}

export function integer(value: unknown, fallback?: number, min = 0, max = 0xffffffff): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '')
    throw new ActionError('整数参数无效');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new ActionError('整数参数超出范围');
  return n;
}

export function text(value: unknown, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw new ActionError('字符串参数无效');
  return value;
}

function unescapeCq(value: string): string {
  return value
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

/** 先识别控制段再反转义，正文里的转义 CQ 不会变成命令。 */
export function parseSegments(value: unknown, autoEscape = false): Segment[] {
  if (typeof value !== 'string')
    return z
      .array(segmentSchema)
      .min(1)
      .max(256)
      .parse(Array.isArray(value) ? value : [value]);
  if (autoEscape) return [{ type: 'text', data: { text: value } }];
  const segments: Segment[] = [];
  let offset = 0;
  for (const match of value.matchAll(/\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index > offset)
      segments.push({ type: 'text', data: { text: unescapeCq(value.slice(offset, match.index)) } });
    const data: Record<string, string> = {};
    for (const part of (match[2] ?? '').split(',').filter(Boolean)) {
      const equals = part.indexOf('=');
      if (equals < 1) throw new ActionError('CQ 参数无效');
      data[part.slice(0, equals)] = unescapeCq(part.slice(equals + 1));
    }
    segments.push({ type: match[1]!, data });
    offset = match.index + match[0].length;
  }
  if (offset < value.length)
    segments.push({ type: 'text', data: { text: unescapeCq(value.slice(offset)) } });
  if (!segments.length || segments.length > 256) throw new ActionError('消息不能为空或超过 256 段');
  return segments;
}

export function serializeSegments(segments: Segment[]): string {
  const escapeText = (value: unknown) =>
    String(value).replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
  return segments
    .map((segment) =>
      segment.type === 'text'
        ? escapeText(segment.data.text ?? '')
        : `[CQ:${segment.type}${Object.entries(segment.data)
            .map(([key, value]) => `,${key}=${escapeText(value).replace(/,/g, '&#44;')}`)
            .join('')}]`,
    )
    .join('');
}

export function sendTarget(
  action: string,
  p: Params,
): { peerType: 'c2c' | 'group'; targetId: string } {
  if (
    action === 'send_msg' &&
    p.message_type !== undefined &&
    !['private', 'group'].includes(String(p.message_type))
  )
    throw new ActionError('message_type 无效');
  if (
    action === 'send_msg' &&
    p.message_type === undefined &&
    p.user_id !== undefined &&
    p.group_id !== undefined
  )
    throw new ActionError('同时提供两个目标时必须指定 message_type');
  const group =
    action === 'send_group_msg' ||
    action === 'upload_group_file' ||
    (action === 'send_msg' &&
      (p.message_type === 'group' || (p.message_type === undefined && p.group_id !== undefined)));
  return { peerType: group ? 'group' : 'c2c', targetId: id(group ? p.group_id : p.user_id) };
}
