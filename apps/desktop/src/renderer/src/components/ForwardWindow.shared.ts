export function parseArkMultiMsg(raw: unknown): {
  mainTitle: string;
  previewLines: string[];
  summary: string;
  source: string;
} | null {
  const fallback = {
    mainTitle: '聊天记录',
    previewLines: [],
    summary: '查看转发消息',
    source: '聊天记录',
  };
  let ark: Record<string, unknown> | null = null;
  if (raw && typeof raw === 'object') ark = raw as Record<string, unknown>;
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      ark = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      ark = null;
    }
  }
  if (!ark) return null;
  if (ark.app !== 'com.tencent.multimsg') return null;

  const meta = ark.meta;
  const detail =
    meta &&
    typeof meta === 'object' &&
    (meta as Record<string, unknown>).detail &&
    typeof (meta as Record<string, unknown>).detail === 'object'
      ? ((meta as Record<string, unknown>).detail as Record<string, unknown>)
      : null;
  if (!detail) return fallback;

  const news = Array.isArray(detail.news) ? detail.news : [];
  const previewLines = news
    .map((item) =>
      item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string'
        ? ((item as Record<string, unknown>).text as string).trim()
        : '',
    )
    .filter(Boolean);
  const source =
    typeof detail.source === 'string' && detail.source.trim()
      ? detail.source.trim()
      : typeof ark.desc === 'string' && ark.desc.trim()
        ? ark.desc.trim()
        : fallback.source;
  const summary =
    typeof detail.summary === 'string' && detail.summary.trim()
      ? detail.summary.trim()
      : fallback.summary;
  return {
    mainTitle: source || fallback.mainTitle,
    previewLines,
    summary,
    source: source || fallback.source,
  };
}

export function isArkMultiMsg(raw: unknown): boolean {
  return parseArkMultiMsg(raw) !== null;
}
