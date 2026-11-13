import { createContext, type CSSProperties } from 'react';
import { create } from 'zustand';
import type { MessageBubbleSkin } from '@weq/service';
import { seedMessageBubbles, messageBubble } from '../lib/messageBubbles';

/** One cached message inside a forward chain, as it arrives on the wire. */
export interface ForwardRecordWire {
  cachedBubbles?: MessageBubbleSkin[];
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
  /** Per-message decoration from the nested proto40801 (0 = not set). */
  decoration?: {
    bubbleId: number;
    fontId: number;
    widgetId: number;
    cachedBubble?: MessageBubbleSkin;
  };
}

export interface ForwardWindowState {
  parentId?: number;
  id: number;
  /** Title shown in the header (parsed from the XML summary when available). */
  title: string;
  /** The forward kind needed for the lookup (c2c vs group). */
  kind: 'c2c' | 'group';
  /** Group code (群号) of the chat this was opened from; '' for c2c. Only used
   *  as one of the two scene guesses when downloading a forwarded medium. */
  conv: string;
  /** Source msgId we asked the backend to look up. */
  msgId: string;
  /**
   * msgId of the ROOT message in our own msg tables — the only row that has a
   * 40900 blob. Equal to {@link msgId} for a window opened from the timeline;
   * for a nested forward it keeps pointing at that same root, because the root's
   * 40900 already nests every level. Media downloads resolve through it.
   */
  rootMsgId: string;
  /** Inline records (for nested opens we already have the payload). */
  records: ForwardRecordWire[] | null;
  /**
   * Optional server resource id of the merged forward. When the local 40900
   * lookup returns nothing (gap messages never live in the DB), the window
   * falls back to fetching the chain from QQ servers via SsoRecvLongMsg.
   */
  resId?: string;
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
    parentId?: number;
    anchor?: DOMRect;
    title: string;
    kind: 'c2c' | 'group';
    conv: string;
    msgId: string;
    rootMsgId?: string;
    records?: ForwardRecordWire[];
    resId?: string;
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
export const WINDOW_WIDTH = 460;
export const WINDOW_HEIGHT = 560;

/** Centred top-left for a window of the configured size, plus a stagger nudge. */
function spawnPosition(offset: number, anchor?: DOMRect): { x: number; y: number } {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const baseX = Math.max(0, Math.round((vw - WINDOW_WIDTH) / 2));
  const baseY = Math.max(0, Math.round((vh - WINDOW_HEIGHT) / 2));
  const nudge = STAGGER * (offset % 8);
  const width = Math.min(WINDOW_WIDTH, vw - 16);
  const height = Math.min(WINDOW_HEIGHT, vh - 16);
  if (anchor)
    return {
      x: clamp(anchor.left, 8, Math.max(8, vw - width - 8)),
      y: clamp(
        anchor.bottom + height + 8 <= vh ? anchor.bottom + 8 : anchor.top - height - 8,
        8,
        Math.max(8, vh - height - 8),
      ),
    };
  return {
    x: clamp(baseX + nudge, 8, Math.max(8, vw - width - 8)),
    y: clamp(baseY + nudge, 8, Math.max(8, vh - height - 8)),
  };
}

export const useForwardStore = create<ForwardStore>((set, get) => ({
  windows: [],
  seq: 0,
  zTop: 1000,
  open(opts) {
    for (const record of opts.records ?? []) seedMessageBubbles(record.cachedBubbles);
    const seq = get().seq + 1;
    const zTop = get().zTop + 1;
    const offset = get().windows.length;
    const { x, y } = spawnPosition(offset, opts.anchor);
    set({
      seq,
      zTop,
      windows: [
        ...get().windows,
        {
          id: seq,
          parentId: opts.parentId,
          title: opts.title || '聊天记录',
          kind: opts.kind,
          conv: opts.conv,
          msgId: opts.msgId,
          rootMsgId: opts.rootMsgId || opts.msgId,
          records: opts.records ?? null,
          resId: opts.resId,
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
    const windows = get().windows;
    const raised = new Map([[id, get().zTop + 1]]);
    // 父窗提升时连同全部后代一起提升，子记录仍在所属父窗上方。
    for (const parent of raised.keys())
      for (const child of windows)
        if (child.parentId === parent && !raised.has(child.id))
          raised.set(child.id, get().zTop + raised.size + 1);
    const zTop = get().zTop + raised.size;
    set({
      zTop,
      windows: windows.map((w) => (raised.has(w.id) ? { ...w, z: raised.get(w.id)! } : w)),
    });
  },
  move(id, x, y) {
    set({
      windows: get().windows.map((w) => (w.id === id ? { ...w, x, y } : w)),
    });
  },
  setRecords(id, records) {
    const prepare = (rows: ForwardRecordWire[]) => {
      for (const row of rows) {
        seedMessageBubbles(row.cachedBubbles);
        if (row.decoration)
          row.decoration = {
            ...row.decoration,
            cachedBubble: messageBubble(row.decoration.bubbleId),
          };
        if (row.subMsgs) prepare(row.subMsgs);
      }
    };
    prepare(records);
    set({
      windows: get().windows.map((w) =>
        w.id === id ? { ...w, records, loading: false, error: null } : w,
      ),
    });
  },
  setError(id, error) {
    set({
      windows: get().windows.map((w) => (w.id === id ? { ...w, error, loading: false } : w)),
    });
  },
}));

/** Imperatively open a forward window. */
export function openForwardWindow(opts: {
  parentId?: number;
  anchor?: DOMRect;
  title: string;
  kind: 'c2c' | 'group';
  conv: string;
  msgId: string;
  rootMsgId?: string;
  records?: ForwardRecordWire[];
  resId?: string;
}): void {
  useForwardStore.getState().open(opts);
}

export const ForwardParentContext = createContext<number | undefined>(undefined);

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

export function forwardWindowStyle(
  win: ForwardWindowState,
  viewport: { left: number; top: number; width: number; height: number },
): CSSProperties {
  return {
    left: clamp(
      win.x,
      viewport.left + 8,
      viewport.left + Math.max(8, viewport.width - Math.min(WINDOW_WIDTH, viewport.width - 16) - 8),
    ),
    top: clamp(
      win.y,
      viewport.top + 8,
      viewport.top +
        Math.max(8, viewport.height - Math.min(WINDOW_HEIGHT, viewport.height - 16) - 8),
    ),
    zIndex: win.z,
    width: Math.min(WINDOW_WIDTH, viewport.width - 16),
    height: Math.min(WINDOW_HEIGHT, viewport.height - 16),
    maxWidth: 'calc(100vw - 16px)',
    maxHeight: 'calc(100dvh - 16px)',
  };
}
