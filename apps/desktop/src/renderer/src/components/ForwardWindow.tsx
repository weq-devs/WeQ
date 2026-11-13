import { lazy, Suspense, useCallback, useContext, useMemo, useRef, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { ForwardCarrierContext, ConvContext } from '../state/messageContext';
import {
  useForwardStore,
  openForwardWindow,
  ForwardParentContext,
  forwardWindowStyle,
  type ForwardWindowState,
  type ForwardRecordWire,
} from '../state/forwardWindow';
import { OverlayLayerContext, useOverlayLayer } from '../lib/overlayStack';
import { useSurfaceEscape } from '../lib/surfaceEscape';
import { visibleViewport } from '../lib/visibleViewport';
import { LoadingIndicator } from './LoadingIndicator';
export { openForwardWindow, type ForwardRecordWire } from '../state/forwardWindow';

const Content = lazy(() =>
  import('./ForwardWindowContent').then((module) => ({ default: module.ForwardWindowContent })),
);

function PendingWindow({ win }: { win: ForwardWindowState }) {
  const surface = useRef<HTMLElement>(null);
  const close = useForwardStore((s) => s.close);
  const raise = useForwardStore((s) => s.bringToFront);
  useSurfaceEscape(surface, () => close(win.id), true, false);
  return (
    <section
      ref={surface}
      tabIndex={-1}
      className="weq-forward-window"
      style={forwardWindowStyle(win, visibleViewport())}
      role="dialog"
      aria-label={win.title}
      aria-busy="true"
      onMouseDown={() => raise(win.id)}
    >
      <header className="weq-forward-header" style={{ cursor: 'default' }}>
        <div className="weq-forward-title">{win.title}</div>
        <button
          type="button"
          className="weq-forward-close"
          aria-label="关闭"
          title="关闭"
          onClick={() => close(win.id)}
        >
          <X size={16} strokeWidth={1.9} />
        </button>
      </header>
      <div className="weq-forward-body weq-forward-status">
        <LoadingIndicator />
      </div>
    </section>
  );
}

// ---- the multiMsg preview bubble ----------------------------------------

/**
 * Parse the multiMsg XML for the bits the user actually sees:
 *   - `<title>` lines (the brief "sender: msg" rows).
 *   - `<summary>` row (the "查看N条转发消息" footer).
 *   - `<source name>` for the title shown in the window header.
 *
 * The XML format is documented in `MultiMsgElementSchema` — every multiMsg
 * carries it on the element, so this is a stable parse. We treat the FIRST
 * `<title>` as the main title (typically "X的聊天记录") and subsequent ones as
 * preview lines.
 */
function parseMultiMsgXml(xml: string): {
  mainTitle: string;
  previewLines: string[];
  summary: string;
  source: string;
} {
  const fallback = {
    mainTitle: '聊天记录',
    previewLines: [],
    summary: '查看转发消息',
    source: '聊天记录',
  };
  if (!xml) return fallback;

  // QQ NT's multiMsg payload is XML that occasionally arrives slightly off-spec:
  //   - leading BOM / whitespace before `<?xml ...?>` (DOMParser rejects this in
  //     `application/xml` mode and the resulting document is unusable);
  //   - bare `&` inside <title> text (URLs, nicknames) that the strict parser
  //     refuses while every other QQ client happily renders;
  //   - the occasional <hr> self-close mismatch.
  // We try strict XML first; if it produces no usable nodes we fall back to the
  // HTML parser, which is liberal enough to recover every shape we've seen.
  const cleaned = xml.replace(/^﻿/, '').trim();

  function extract(doc: Document): {
    titles: string[];
    summary: string;
    source: string;
  } | null {
    // `getElementsByTagName` is case-insensitive in HTML and case-sensitive in
    // XML — both fine for our lowercase tags. Skip a doc that's just `<html>`
    // wrapping our content (HTML parser does that) by searching the whole tree.
    const titles = Array.from(doc.getElementsByTagName('title'))
      .map((node) => (node.textContent ?? '').trim())
      .filter(Boolean);
    const summary = (doc.getElementsByTagName('summary')[0]?.textContent ?? '').trim();
    const sourceEl = doc.getElementsByTagName('source')[0];
    const source = sourceEl?.getAttribute('name') ?? '';
    if (titles.length === 0 && !summary && !source) return null;
    return { titles, summary, source };
  }

  let picked: { titles: string[]; summary: string; source: string } | null = null;
  try {
    const xmlDoc = new DOMParser().parseFromString(cleaned, 'application/xml');
    if (!xmlDoc.querySelector('parsererror')) {
      picked = extract(xmlDoc);
    }
  } catch {
    /* fall through to HTML */
  }
  if (!picked) {
    try {
      // HTML mode is far more forgiving — recovers from missing escapes, bad
      // self-closing tags, etc. Browsers lowercase tag names, but ours already
      // are, and the HTML parser keeps custom elements like <msg>/<item> intact.
      const htmlDoc = new DOMParser().parseFromString(cleaned, 'text/html');
      picked = extract(htmlDoc);
    } catch {
      /* give up below */
    }
  }
  if (!picked) return fallback;

  const mainTitle = picked.titles[0] || picked.source || fallback.mainTitle;
  const previewLines = picked.titles.slice(1);
  return {
    mainTitle,
    previewLines,
    summary: picked.summary || fallback.summary,
    source: picked.source || mainTitle,
  };
}

function parseArkMultiMsg(raw: unknown): {
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

function parseForwardPreviewData(data: Record<string, unknown>): {
  mainTitle: string;
  previewLines: string[];
  summary: string;
  source: string;
} {
  if (typeof data.xmlContent === 'string' && data.xmlContent.trim()) {
    return parseMultiMsgXml(data.xmlContent);
  }
  const parsedArk = parseArkMultiMsg(data.arkData);
  if (parsedArk) return parsedArk;
  // 本地合成的卡片（乐观渲染的合并转发）带 `_` 前缀的客户端专用字段：真消息里没有
  // 这些字段（它们的预览行来自 XML / ark JSON），但同一张预览卡要长得一样。
  const label =
    typeof data._label === 'string' && data._label.trim() ? data._label.trim() : '聊天记录';
  const news = Array.isArray(data._news)
    ? (data._news as unknown[]).filter(
        (line): line is string => typeof line === 'string' && line.trim().length > 0,
      )
    : [];
  const summary =
    typeof data._summary === 'string' && data._summary.trim() ? data._summary.trim() : '查看详情';
  return {
    mainTitle: label,
    previewLines: news,
    summary,
    source: label,
  };
}

/**
 * Extract the server resource id from a multiMsg element's render data:
 *   - `data.resId` (codec MULTI_MSG / structLongMsg),
 *   - `m_resid` attribute of the XML preview document,
 *   - `meta.detail.resid` of an Ark `com.tencent.multimsg` wrapper.
 * Empty string when nothing usable is present (the caller then relies on the
 * local 40900 cache only).
 */
function forwardResIdOf(data: Record<string, unknown>): string {
  if (typeof data.resId === 'string' && data.resId.trim()) return data.resId.trim();
  if (typeof data.xmlContent === 'string') {
    const m = data.xmlContent.match(/m_resid\s*=\s*["']([^"']+)["']/i);
    if (m?.[1]) return m[1];
  }
  let ark: Record<string, unknown> | null = null;
  if (data.arkData && typeof data.arkData === 'object') {
    ark = data.arkData as Record<string, unknown>;
  } else if (typeof data.arkData === 'string' && data.arkData.trim()) {
    try {
      ark = JSON.parse(data.arkData) as Record<string, unknown>;
    } catch {
      ark = null;
    }
  }
  const detail = (ark?.meta as Record<string, unknown> | undefined)?.detail as
    | Record<string, unknown>
    | undefined;
  const resid = detail?.resid ?? detail?.resId;
  if (typeof resid === 'string' && resid.trim()) return resid.trim();
  return '';
}

function clampPreviewText(value: string, max: number): string {
  const text = value.trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * The preview bubble (a:xxx b:xxx c:xxx + 查看详情). Used both inside the main
 * timeline (via the multiMsg element renderer) and inside another forward
 * window when the user drills into nested forwards.
 */
export function ForwardMultiMsgPreview({
  data,
  nestedRecords,
  msgId,
  kind,
}: {
  /** The raw multiMsg element data, or an Ark `com.tencent.multimsg` wrapper. */
  data: Record<string, unknown>;
  /** Optional inline sub-records (used when nesting — saves a DB round-trip). */
  nestedRecords?: ForwardRecordWire[];
  /** msgId of the carrying message — what we look up in `getForwardMessages`. */
  msgId: string;
  /** Conversation kind so the lookup hits the right table. */
  kind: 'c2c' | 'group';
}): ReactElement {
  const parsed = useMemo(() => parseForwardPreviewData(data), [data]);
  const titleText = useMemo(() => clampPreviewText(parsed.mainTitle, 36), [parsed.mainTitle]);
  const previewLines = useMemo(
    () => parsed.previewLines.slice(0, 4).map((line) => clampPreviewText(line, 25)),
    [parsed.previewLines],
  );
  const summaryText = useMemo(() => clampPreviewText(parsed.summary, 18), [parsed.summary]);
  const resId = useMemo(() => forwardResIdOf(data), [data]);
  // 群号：主时间线由 MainView 提供；转发窗口里由 ForwardWindowFrame 再提供一次，
  // 所以嵌套转发也能把它继续传下去。
  const conv = useContext(ConvContext);
  // 已经在转发窗口里 → 保持指向最外层那条真实消息（只有它有 40900）。
  const carrier = useContext(ForwardCarrierContext);
  const parentId = useContext(ForwardParentContext);

  const open = useCallback(
    (anchor: HTMLElement) => {
      openForwardWindow({
        parentId,
        anchor: anchor.getBoundingClientRect(),
        title: parsed.source || parsed.mainTitle,
        kind,
        conv,
        msgId,
        rootMsgId: carrier?.msgId || msgId,
        records: nestedRecords && nestedRecords.length > 0 ? nestedRecords : undefined,
        ...(resId ? { resId } : {}),
      });
    },
    [kind, conv, carrier, msgId, nestedRecords, parsed.mainTitle, parsed.source, resId, parentId],
  );

  return (
    <button
      type="button"
      className="weq-forward-preview"
      data-forward-res-id={resId}
      onClick={(event) => open(event.currentTarget)}
      title="查看合并转发"
    >
      <div className="weq-forward-preview-title">{titleText}</div>
      {previewLines.length > 0 ? (
        <ul className="weq-forward-preview-lines">
          {previewLines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
            <li key={index} className="weq-forward-preview-line">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="weq-forward-preview-foot">
        <span className="weq-forward-preview-summary">{summaryText}</span>
        <span className="weq-forward-preview-detail">查看详情 ›</span>
      </div>
    </button>
  );
}

/** 宿主与请求状态常驻，窗口正文只在首次打开时加载。 */
export function ForwardWindowHost(): ReactElement | null {
  const windows = useForwardStore((s) => s.windows);
  const revision = useForwardStore((s) => s.zTop);
  const layer = useOverlayLayer(windows.length > 0, revision);
  if (typeof document === 'undefined' || windows.length === 0) return null;
  return createPortal(
    <div className="weq-forward-layer" style={{ zIndex: layer }} aria-live="polite">
      <OverlayLayerContext.Provider value={layer}>
        <Suspense fallback={windows.map((win) => <PendingWindow key={win.id} win={win} />)}>
          <Content windows={windows} />
        </Suspense>
      </OverlayLayerContext.Provider>
    </div>,
    document.body,
  );
}
