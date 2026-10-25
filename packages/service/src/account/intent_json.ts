/** 兼容模型输出的 JSON 围栏与前后说明文字。 */
export function extractJsonBlock(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw: string = fenced?.[1] ?? text;
  const starts = [raw.indexOf('['), raw.indexOf('{')].filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const open = raw[start] as '[' | '{';
  const close = open === '[' ? ']' : '}';
  const end = raw.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}
