/**
 * Compose layer — the subset of elements a user can *author* (insert a brand-new
 * message), plus the machinery to validate that authored input.
 *
 * Single source of truth: everything here is derived from the Zod schemas in
 * `spec.ts`. The frontend asks for {@link COMPOSE_ELEMENT_SPECS} to know which
 * fields are required vs optional (and their coarse type) and builds its form
 * from that — no hand-maintained parallel interface. The backend validates the
 * same input with the same schemas via {@link validateComposeMessage}.
 *
 * Currently supported mix (one message may combine several):
 *   - text / at / pic / face  — at least ONE must be present
 *   - reply                    — at most one, and it must be the FIRST element
 *
 * msgType convention (DB column 40011): no reply → 2, has reply → 9.
 */

import { z } from 'zod';
import {
  TextElementSchema,
  AtElementSchema,
  PicElementSchema,
  FaceElementSchema,
  ReplyElementSchema,
} from './spec';
import type { Element } from './spec';

/** Element kinds the compose flow can author. */
export const COMPOSE_KINDS = ['text', 'at', 'pic', 'face', 'reply'] as const;
export type ComposeKind = (typeof COMPOSE_KINDS)[number];

/** The content kinds (a message needs at least one of these). */
export const CONTENT_KINDS: ReadonlySet<ComposeKind> = new Set(['text', 'at', 'pic', 'face']);

/** kind → its authoritative Zod schema (from spec.ts). */
const COMPOSE_SCHEMAS: Record<ComposeKind, z.ZodObject<z.ZodRawShape>> = {
  text: TextElementSchema,
  at: AtElementSchema,
  pic: PicElementSchema,
  face: FaceElementSchema,
  reply: ReplyElementSchema,
};

/** msgType stored in column 40011 for a composed message. */
export const MSG_TYPE_PLAIN = 2;
export const MSG_TYPE_REPLY = 9;

// ─────────────────────────────────────────────────────────────────────────
// Field introspection (drives the frontend form)
// ─────────────────────────────────────────────────────────────────────────

export type FieldType =
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'bytes'
  | 'array'
  | 'object'
  | 'enum'
  | 'unknown';

export interface FieldSpec {
  name: string;
  required: boolean;
  type: FieldType;
  /** Allowed numeric values when `type === 'enum'`. */
  enumValues?: number[];
}

const WRAPPERS = new Set(['ZodOptional', 'ZodDefault', 'ZodNullable']);

/** Peel ZodOptional/ZodDefault/ZodNullable to reach the underlying type. */
function unwrap(field: z.ZodTypeAny): z.ZodTypeAny {
  let base = field;
  while (base?._def && WRAPPERS.has(base._def.typeName)) base = base._def.innerType;
  return base;
}

function fieldType(field: z.ZodTypeAny): { type: FieldType; enumValues?: number[] } {
  const base = unwrap(field);
  switch (base?._def?.typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBigInt':
      return { type: 'bigint' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray':
      return { type: 'array' };
    case 'ZodObject':
      return { type: 'object' };
    case 'ZodNativeEnum':
      return {
        type: 'enum',
        enumValues: Object.values(base._def.values).filter((v): v is number => typeof v === 'number'),
      };
    // z.instanceof(Uint8Array) compiles to a ZodEffects — the only effect we use.
    case 'ZodEffects':
      return { type: 'bytes' };
    default:
      return { type: 'unknown' };
  }
}

/** Field descriptors for one compose kind (excluding the `kind` discriminator). */
export function describeComposeFields(kind: ComposeKind): FieldSpec[] {
  const shape = COMPOSE_SCHEMAS[kind].shape;
  return Object.keys(shape)
    .filter((k) => k !== 'kind')
    .map((name) => {
      const field = shape[name] as z.ZodTypeAny;
      const { type, enumValues } = fieldType(field);
      const spec: FieldSpec = { name, required: !field.isOptional(), type };
      if (enumValues) spec.enumValues = enumValues;
      return spec;
    });
}

/** All compose specs, precomputed — this is what the frontend fetches. */
export const COMPOSE_ELEMENT_SPECS: Record<ComposeKind, FieldSpec[]> = Object.fromEntries(
  COMPOSE_KINDS.map((k) => [k, describeComposeFields(k)]),
) as Record<ComposeKind, FieldSpec[]>;

// ─────────────────────────────────────────────────────────────────────────
// Validation / coercion of authored input
// ─────────────────────────────────────────────────────────────────────────

/**
 * Rebuild one field's schema with boundary coercion: number/bigint leaves accept
 * their string form (the IPC layer ships bigints as strings). Everything else —
 * string checks, enums, `z.instanceof(Uint8Array)`, arrays — is kept verbatim,
 * so the field *set* still comes straight from spec.ts.
 */
function coerceField(field: z.ZodTypeAny): z.ZodTypeAny {
  const optional = field.isOptional();
  const base = unwrap(field);
  let out: z.ZodTypeAny = base;
  if (base?._def?.typeName === 'ZodNumber') out = z.coerce.number();
  else if (base?._def?.typeName === 'ZodBigInt') out = z.coerce.bigint();
  return optional ? out.optional() : out;
}

/**
 * Coercion-augmented copy of each compose schema, used for parsing input.
 *
 * `pic` is special-cased: its element is never hand-authored but *lifted* from
 * an existing message (to keep the CDN fields valid), and real pics vary in
 * which "required" fields they carry. So pic is parsed leniently — every field
 * optional + passthrough — while still coercing its numeric/bigint leaves. The
 * frontend form descriptors ({@link COMPOSE_ELEMENT_SPECS}) stay accurate.
 */
const COERCED_SCHEMAS: Record<ComposeKind, z.ZodType> = Object.fromEntries(
  COMPOSE_KINDS.map((kind) => {
    const shape = COMPOSE_SCHEMAS[kind].shape;
    const next: z.ZodRawShape = {};
    for (const k of Object.keys(shape)) next[k] = coerceField(shape[k] as z.ZodTypeAny);
    const obj = z.object(next);
    return [kind, kind === 'pic' ? obj.partial().passthrough() : obj];
  }),
) as unknown as Record<ComposeKind, z.ZodType>;

export interface ComposeParseError {
  ok: false;
  error: string;
}
export interface ComposeParseOk {
  ok: true;
  elements: Element[];
  /** DB column 40011: 9 when the message opens with a reply, else 2. */
  msgType: number;
}
export type ComposeParseResult = ComposeParseOk | ComposeParseError;

/**
 * Coerce a quoted (reply.origElements) element. A lifted `pic` carries CDN
 * fields whose numeric/bigint leaves arrive as strings over IPC, so run it
 * through the lenient pic schema to restore their types before it is re-encoded
 * into the stored quote. Text/@/face need no coercion, and wire-form items
 * (elementType, no `kind`) are left untouched. Never throws — an unparseable
 * item is returned verbatim so the insert still succeeds.
 */
function coerceOrigElement(raw: unknown): unknown {
  if ((raw as { kind?: string })?.kind === 'pic') {
    const res = COERCED_SCHEMAS.pic.safeParse(raw);
    if (res.success) return res.data;
  }
  return raw;
}

/** Validate + coerce one authored element. */
function parseComposeElement(raw: unknown): { ok: true; element: Element } | ComposeParseError {
  const kind = (raw as { kind?: string })?.kind;
  if (!kind || !(kind in COERCED_SCHEMAS)) {
    return { ok: false, error: `不支持的 element 类型: ${String(kind)}` };
  }
  const res = COERCED_SCHEMAS[kind as ComposeKind].safeParse(raw);
  if (!res.success) {
    return { ok: false, error: `${kind} 校验失败: ${res.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
  }
  const element = res.data as Element & { origElements?: unknown };
  if (kind === 'reply' && Array.isArray(element.origElements)) {
    element.origElements = element.origElements.map(coerceOrigElement);
  }
  return { ok: true, element: element as Element };
}

/**
 * Validate a whole authored message: each element against its spec schema, plus
 * the compose rules —
 *   - reply: at most one, and only as the first element,
 *   - at least one content element (text/at/pic/face).
 * Returns the coerced `Element[]` and the derived msgType on success.
 */
export function validateComposeMessage(rawElements: unknown[]): ComposeParseResult {
  if (!Array.isArray(rawElements) || rawElements.length === 0) {
    return { ok: false, error: '消息不能为空' };
  }

  const elements: Element[] = [];
  for (const raw of rawElements) {
    const parsed = parseComposeElement(raw);
    if (!parsed.ok) return parsed;
    elements.push(parsed.element);
  }

  const replyIdxs = elements.flatMap((e, i) => (e.kind === 'reply' ? [i] : []));
  if (replyIdxs.length > 1) return { ok: false, error: '一条消息最多只能有一个回复(reply)' };
  if (replyIdxs.length === 1 && replyIdxs[0] !== 0) {
    return { ok: false, error: '回复(reply)必须是第一个 element' };
  }

  const hasContent = elements.some((e) => CONTENT_KINDS.has(e.kind as ComposeKind));
  if (!hasContent) return { ok: false, error: '消息至少需要一个内容 element(text/at/pic/face)' };

  return { ok: true, elements, msgType: replyIdxs.length === 1 ? MSG_TYPE_REPLY : MSG_TYPE_PLAIN };
}
