/**
 * 合并转发预览窗口 — floating, movable, closable window stack.
 *
 * `openForwardWindow(...)` pushes a new window onto the global stack and kicks
 * off a `trpc.account.getForwardMessages` query. Multiple windows stack with
 * increasing z-index; the top one always sits above the rest. A nested forward
 * (a `multiMsg` element inside one of the sub-messages) opens YET another
 * window on top — the user can keep drilling down arbitrarily deep.
 *
 * Layout reuses the same renderer the main chat uses (`QqMessageContent`), so a
 * forwarded text / sticker / image / reply / face all draw exactly like in the
 * main timeline. The forward payload from the main process is already in the
 * `{ type, data }` render-view shape (see `forwardRecordToWire` in serde.ts) —
 * we do not parse proto on the renderer.
 *
 * Drag is by the title bar only. The window stays inside the viewport (clamped
 * on every drag) so closing the chrome can't strand it offscreen.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { X } from 'lucide-react';
import { client } from '../trpc/client';
import { QqMessageContent } from './QqMessageContent';

// ---- types & store -------------------------------------------------------

/** One cached message inside a forward chain, as it arrives on the wire. */
export interface ForwardRecordWire {
  msgId: string;
  msgSeq?: string;
  msgType?: number;
  isSender?: boolean;
  senderUid?: string;
  senderUin?: string;
  sendTime?: string;
  sendNick?: string;
  senderInfo?: {
    avatar?: {
      avatarUrl?: string;
      encryptedUin?: string;
    };
  };
  /** Already lifted to render-view shape in the main process. */
  elements: Array<{ type?: string; data?: Record<string, unknown> }>;
  /** Recursive: nested 40900 forward cache (multi-forward inside multi-forward). */
  subMsgs?: ForwardRecordWire[];
}

interface ForwardWindowState {
  id: number;
  /** Title shown in the header (parsed from the XML summary when available). */
  title: string;
  /** The forward kind needed for the lookup (c2c vs group). */
  kind: 'c2c' | 'group';
  /** Source msgId we asked the backend to look up. */
  msgId: string;
  /** Inline records (for nested opens we already have the payload). */
  records: ForwardRecordWire[] | null;
  /** Position (top-left), zustand-mutated by the drag handler. */
  x: number;
  y: number;
  /** Render order — bumped on every interaction. */
  z: number;
  /** Loading / error flags for the initial fetch. */
  loading: boolean;
  error: string | null;
}

interface ForwardStore {
  windows: ForwardWindowState[];
  seq: number;
  zTop: number;
  open(opts: {
    title: string;
    kind: 'c2c' | 'group';
    msgId: string;
    records?: ForwardRecordWire[];
  }): void;
  close(id: number): void;
  bringToFront(id: number): void;
  move(id: number, x: number, y: number): void;
  setRecords(id: number, records: ForwardRecordWire[]): void;
  setError(id: number, error: string): void;
}

// Each new window opens centred in the viewport (Electron BrowserWindow). When
// several windows stack, each subsequent one nudges down-right by STAGGER so
// older ones stay partially visible — the user can still reach them to drag.
const STAGGER = 28;
const WINDOW_WIDTH = 460;
const WINDOW_HEIGHT = 560;

/** Centred top-left for a window of the configured size, plus a stagger nudge. */
function spawnPosition(offset: number): { x: number; y: number } {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const baseX = Math.max(0, Math.round((vw - WINDOW_WIDTH) / 2));
  const baseY = Math.max(0, Math.round((vh - WINDOW_HEIGHT) / 2));
  const nudge = STAGGER * (offset % 8);
  return {
    x: clamp(baseX + nudge, 0, Math.max(0, vw - 80)),
    y: clamp(baseY + nudge, 0, Math.max(0, vh - 32)),
  };
}

const useForwardStore = create<ForwardStore>((set, get) => ({
  windows: [],
  seq: 0,
  zTop: 1000,
  open(opts) {
    const seq = get().seq + 1;
    const zTop = get().zTop + 1;
    const offset = get().windows.length;
    const { x, y } = spawnPosition(offset);
    set({
      seq,
      zTop,
      windows: [
        ...get().windows,
        {
          id: seq,
          title: opts.title || '聊天记录',
          kind: opts.kind,
          msgId: opts.msgId,
          records: opts.records ?? null,
          x,
          y,
          z: zTop,
          loading: !opts.records,
          error: null,
        },
      ],
    });
  },
  close(id) {
    set({ windows: get().windows.filter((w) => w.id !== id) });
  },
  bringToFront(id) {
    const zTop = get().zTop + 1;
    set({
      zTop,
      windows: get().windows.map((w) => (w.id === id ? { ...w, z: zTop } : w)),
    });
  },
  move(id, x, y) {
    set({
      windows: get().windows.map((w) => (w.id === id ? { ...w, x, y } : w)),
    });
  },
  setRecords(id, records) {
    set({
      windows: get().windows.map((w) =>
        w.id === id ? { ...w, records, loading: false, error: null } : w,
      ),
    });
  },
  setError(id, error) {
    set({
      windows: get().windows.map((w) =>
        w.id === id ? { ...w, error, loading: false } : w,
      ),
    });
  },
}));

/** Imperatively open a forward window. */
export function openForwardWindow(opts: {
  title: string;
  kind: 'c2c' | 'group';
  msgId: string;
  records?: ForwardRecordWire[];
}): void {
  useForwardStore.getState().open(opts);
}

// ---- helpers -------------------------------------------------------------

function senderAvatarFromUin(uin: string | undefined): string | null {
  if (!uin || uin === '0') return null;
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`;
}

function formatForwardTime(seconds: string | undefined): string {
  const secs = Number(seconds ?? 0);
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const d = new Date(secs * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

// ---- single window -------------------------------------------------------

function ForwardWindowFrame({ win }: { win: ForwardWindowState }): ReactElement {
  const close = useForwardStore((s) => s.close);
  const bringToFront = useForwardStore((s) => s.bringToFront);
  const move = useForwardStore((s) => s.move);
  const setRecords = useForwardStore((s) => s.setRecords);
  const setError = useForwardStore((s) => s.setError);

  // Initial fetch — only when no payload was injected up-front.
  useEffect(() => {
    if (win.records !== null) return;
    let cancelled = false;
    client.account.getForwardMessages
      .query({ kind: win.kind, msgId: win.msgId })
      .then((records) => {
        if (cancelled) return;
        setRecords(win.id, records as ForwardRecordWire[]);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[forward] getForwardMessages failed', err);
        setError(win.id, (err as Error)?.message || 'Failed to load forward');
      });
    return () => {
      cancelled = true;
    };
    // We intentionally depend only on the identity — the rest of the state is
    // mutated by the very setters we call from here.
  }, [win.id, win.kind, win.msgId, win.records, setRecords, setError]);

  // Drag — only the header is a handle. Capture the pointer on the header so a
  // fast drag past the window edge keeps tracking instead of stalling on the
  // viewport background. The window is clamped to the viewport on every move.
  const dragStateRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  const onHeaderPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      // Ignore drags that start on the close button or any nested control.
      const target = event.target as HTMLElement;
      if (target.closest('button')) return;

      bringToFront(win.id);
      dragStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originX: win.x,
        originY: win.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [bringToFront, win.id, win.x, win.y],
  );

  const onHeaderPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const maxX = Math.max(0, window.innerWidth - 80);
      const maxY = Math.max(0, window.innerHeight - 32);
      move(win.id, clamp(drag.originX + dx, -WINDOW_WIDTH + 80, maxX), clamp(drag.originY + dy, 0, maxY));
    },
    [move, win.id],
  );

  const onHeaderPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    dragStateRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }, []);

  // ESC closes the topmost window.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      const wins = useForwardStore.getState().windows;
      if (wins.length === 0) return;
      const top = wins.reduce((a, b) => (a.z > b.z ? a : b));
      if (top.id === win.id) {
        event.stopPropagation();
        useForwardStore.getState().close(top.id);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [win.id]);

  // Position with left/top — NOT transform. The entrance animation
  // (`weq-anim-pop`) owns `transform`, and a running/filled CSS animation wins
  // over inline styles, so a transform-based position would be clobbered back to
  // (0,0). left/top keeps the two concerns from colliding.
  const style: CSSProperties = useMemo(
    () => ({
      left: win.x,
      top: win.y,
      zIndex: win.z,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    }),
    [win.x, win.y, win.z],
  );

  return (
    <section
      className="weq-forward-window weq-anim-pop"
      style={style}
      role="dialog"
      aria-label={win.title}
      onMouseDown={() => bringToFront(win.id)}
    >
      <header
        className="weq-forward-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <div className="weq-forward-title" title={win.title}>
          {win.title}
        </div>
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
      <ForwardScroll win={win} />
    </section>
  );
}

function ForwardScroll({ win }: { win: ForwardWindowState }): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    // Always start at the top of the chain — keeps the chronological reading
    // order obvious (oldest forward at the top, newest at the bottom).
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [win.records]);

  if (win.loading) {
    return (
      <div className="weq-forward-body weq-forward-status">
        <span>加载中…</span>
      </div>
    );
  }
  if (win.error) {
    return (
      <div className="weq-forward-body weq-forward-status weq-forward-error">
        <span>加载失败：{win.error}</span>
      </div>
    );
  }
  const records = win.records ?? [];
  if (records.length === 0) {
    return (
      <div className="weq-forward-body weq-forward-status">
        <span>没有更多消息</span>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="weq-forward-body">
      {records.map((record, index) => (
        <ForwardRow
          key={`${record.msgId || 'rec'}:${index}`}
          record={record}
          kind={win.kind}
        />
      ))}
    </div>
  );
}

function ForwardRow({
  record,
  kind,
}: {
  record: ForwardRecordWire;
  kind: 'c2c' | 'group';
}): ReactElement {
  const avatar =
    senderAvatarFromUin(record.senderUin) || record.senderInfo?.avatar?.avatarUrl || null;
  const displayName = record.sendNick || record.senderUin || record.senderUid || 'Unknown';
  const time = formatForwardTime(record.sendTime);
  const sendTimeMs = (Number(record.sendTime) || 0) * 1000;

  return (
    <div className="weq-forward-row">
      <div className="weq-forward-avatar">
        {avatar ? (
          <img src={avatar} alt="" loading="lazy" />
        ) : (
          <span className="weq-forward-avatar-fallback">
            {displayName.slice(0, 1)}
          </span>
        )}
      </div>
      <div className="weq-forward-row-main">
        <div className="weq-forward-row-meta">
          <span className="weq-forward-row-name">{displayName}</span>
          {time ? <span className="weq-forward-row-time">{time}</span> : null}
        </div>
        <ForwardBubble record={record} kind={kind} sendTimeMs={sendTimeMs} />
      </div>
    </div>
  );
}

/**
 * One forwarded message's content. Uses the same QqMessageContent component the
 * main timeline uses, so text / face / image / sticker / file / reply quote all
 * draw identically. A nested multiMsg element delegates back into the same
 * preview-bubble path used in the main chat — clicking it opens another window.
 */
function ForwardBubble({
  record,
  kind,
  sendTimeMs,
}: {
  record: ForwardRecordWire;
  kind: 'c2c' | 'group';
  sendTimeMs: number;
}): ReactElement {
  // Nested forward: render the preview bubble. We have the sub-payload inline
  // (record.subMsgs) so the click handler does NOT need to round-trip the DB
  // again — it opens the next window with `records` already populated.
  const multiMsgIndex = record.elements.findIndex((el) => el?.type === 'multiMsg');
  if (multiMsgIndex !== -1) {
    const multi = record.elements[multiMsgIndex];
    return (
      <div className="weq-forward-bubble qq-bubble-shell">
        <ForwardMultiMsgPreview
          data={(multi?.data ?? {}) as Record<string, unknown>}
          nestedRecords={record.subMsgs ?? []}
          msgId={record.msgId}
          kind={kind}
        />
      </div>
    );
  }

  return (
    <div className="weq-forward-bubble qq-bubble-shell">
      <QqMessageContent
        elements={record.elements as Array<{ type?: string; data?: Record<string, unknown> }>}
        sendTimeMs={sendTimeMs}
        msgId={record.msgId}
      />
    </div>
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
  const fallback = { mainTitle: '聊天记录', previewLines: [], summary: '查看转发消息', source: '聊天记录' };
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
  /** The raw multiMsg element data: { xmlContent, resId, sessionId }. */
  data: Record<string, unknown>;
  /** Optional inline sub-records (used when nesting — saves a DB round-trip). */
  nestedRecords?: ForwardRecordWire[];
  /** msgId of the carrying message — what we look up in `getForwardMessages`. */
  msgId: string;
  /** Conversation kind so the lookup hits the right table. */
  kind: 'c2c' | 'group';
}): ReactElement {
  const xml = typeof data.xmlContent === 'string' ? (data.xmlContent as string) : '';
  const parsed = useMemo(() => parseMultiMsgXml(xml), [xml]);

  const open = useCallback(() => {
    openForwardWindow({
      title: parsed.source || parsed.mainTitle,
      kind,
      msgId,
      records: nestedRecords && nestedRecords.length > 0 ? nestedRecords : undefined,
    });
  }, [kind, msgId, nestedRecords, parsed.mainTitle, parsed.source]);

  return (
    <button type="button" className="weq-forward-preview" onClick={open} title="查看合并转发">
      <div className="weq-forward-preview-title">{parsed.mainTitle}</div>
      {parsed.previewLines.length > 0 ? (
        <ul className="weq-forward-preview-lines">
          {parsed.previewLines.slice(0, 4).map((line, index) => (
            <li key={index} className="weq-forward-preview-line">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="weq-forward-preview-foot">
        <span className="weq-forward-preview-summary">{parsed.summary}</span>
        <span className="weq-forward-preview-detail">查看详情 ›</span>
      </div>
    </button>
  );
}

// ---- host ---------------------------------------------------------------

/** Mount once near the root. Renders the floating window stack. */
export function ForwardWindowHost(): ReactElement | null {
  const windows = useForwardStore((s) => s.windows);
  if (typeof document === 'undefined' || windows.length === 0) return null;
  return createPortal(
    <div className="weq-forward-layer" aria-live="polite">
      {windows.map((w) => (
        <ForwardWindowFrame key={w.id} win={w} />
      ))}
    </div>,
    document.body,
  );
}
