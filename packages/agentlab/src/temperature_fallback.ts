/** 只改 JSON 聊天请求的温度字段，不改原始输入、模型、工具或超时信号。 */
export function withoutTemperature(path: string, init: RequestInit): RequestInit | null {
  if (
    path !== '/chat/completions' ||
    init.method?.toUpperCase() !== 'POST' ||
    typeof init.body !== 'string'
  )
    return null;
  try {
    const body: unknown = JSON.parse(init.body);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !Object.hasOwn(body, 'temperature')
    )
      return null;
    const next = { ...body };
    delete (next as Record<string, unknown>).temperature;
    return { ...init, body: JSON.stringify(next) };
  } catch {
    return null;
  }
}

const PARAMETER_CODES = new Set([
  'unsupported_parameter',
  'unknown_parameter',
  'unrecognized_parameter',
]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 仅接受明确的参数不兼容，不将取值范围、类型、鉴权、限流或输出后的错误当作回退依据。 */
export function isUnsupportedTemperature(raw: unknown, status: number): boolean {
  if (status !== 200 && status !== 400 && status !== 422) return false;
  const root = object(raw);
  if (root && Array.isArray(root.choices) && root.choices.length > 0) return false;
  const directCode = typeof root?.code === 'string' ? root.code.toLowerCase() : '';
  if (
    status === 200 &&
    !root?.error &&
    !PARAMETER_CODES.has(directCode) &&
    directCode !== 'unsupported_value'
  )
    return false;
  if (root && Array.isArray(root.detail)) {
    return root.detail.some((item: unknown) => {
      const detail = object(item);
      return (
        detail &&
        Array.isArray(detail.loc) &&
        ((detail.loc.length === 1 && detail.loc[0] === 'temperature') ||
          (detail.loc.length === 2 &&
            detail.loc[0] === 'body' &&
            detail.loc[1] === 'temperature')) &&
        (detail.type === 'extra_forbidden' || detail.type === 'value_error.extra')
      );
    });
  }
  const error = object(root?.error) ?? root;
  const param = error?.param ?? error?.parameter;
  if (param != null && param !== 'temperature') return false;
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
  const type = typeof error?.type === 'string' ? error.type.toLowerCase() : '';
  if (/(?:auth|permission|api_key|quota|rate_limit|invalid_type)/.test(`${code} ${type}`))
    return false;
  if (param === 'temperature' && PARAMETER_CODES.has(code)) return true;
  const message =
    typeof raw === 'string'
      ? raw
      : typeof root?.error === 'string'
        ? root.error
        : typeof error?.message === 'string'
          ? error.message
          : typeof root?.detail === 'string'
            ? root.detail
            : '';
  return [
    /\bunsupported\s+(?:parameter|argument|field|option)\s*:?\s*["'`]?temperature\b/i,
    /\b(?:unknown|unrecognized|unexpected)\s+(?:request\s+)?(?:parameter|argument|field|option|name|keyword(?:\s+argument)?)(?:\s+supplied)?\s*:?\s*["'`]?temperature\b/i,
    /\btemperature["'`]?\s*(?:parameter\s*)?(?:is\s+)?(?:not\s+(?:supported|allowed|permitted)|unsupported)\b/i,
    /\b(?:does\s+not|doesn't|cannot)\s+(?:support|accept)\s+(?:the\s+)?(?:parameter\s+)?["'`]?temperature\b/i,
    /\btemperature\b.{0,120}\b(?:does\s+not\s+support|not\s+supported)\b.{0,120}\b(?:this\s+model|default)\b/i,
    /\btemperature\b.{0,160}\bonly\b.{0,60}\bdefault\b.{0,60}\bsupported\b/i,
    /(?:不支持|不接受)\s*[「“"'`]?temperature\b/i,
    /\btemperature[」”"'`]?\s*(?:参数)?\s*(?:不支持|不允许|不接受)/i,
  ].some((pattern) => pattern.test(message));
}

/** 只窥视小型拒绝响应；过大或无法读取时交给原有错误路径，不增加无界缓冲。 */
export async function readParameterRejection(response: Response): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
  } catch {
    return null;
  }
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = '',
    size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) return null;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } catch {
    return null;
  } finally {
    // clone 的取消可能等候原响应分支，不在这里阻塞原有消费者。
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
