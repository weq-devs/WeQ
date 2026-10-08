/**
 * 妙妙工具「ntqq 抓包」面板。
 *
 * 非侵入式读网卡（nt_helper 的 capture 后端）：TCP 重组 → MSF 帧切分 → 用会话
 * d2key 做 TEA 解密。版式参考 reqable 的桌面端：
 *
 *   ┌ 工具条（单行，底边一道 hairline）────────────────────────────┐
 *   │ ● iface:port · 帧数 · 丢包 · d2key 状态 │ 账号 [▾] ▶ 开始 ⏹ 停止 🗑 │
 *   ├ 左：会话表 ──────────────────┬ 右：请求 / 响应详情 ────────────┤
 *   │ [全部│发包│收包] [过滤…]      │ 发包 | 收包   ← 方向（下划线 Tab）│
 *   │ 命令字 方向 seq 时间 大小 # │ 总览 · 解密数据 · 原始数据       │
 *   │ pttTrans.… ↕ 36 … 36 …  # │ 键值表 / 解析树 / hexdump        │
 *   │ 共 30 项（选择 1 项）         │                                  │
 *   └──────────────────────────────┴──────────────────────────────────┘
 *
 * 设计口径（与 reqable 一致，刻意避开「一堆圆角胶囊」）：
 *   - 分栏靠 **hairline 分隔线**，不是卡片阴影 + 圆角堆叠；面板撑满整格、自己滚。
 *   - 选中态是「左侧 2px 强调色竖条 + 淡底」，Tab 是**下划线**不是药丸。
 *   - 按钮一律方角细边框（3px），主操作才填色；标签是方角小字（2px）。
 *
 * 同一 seq 的请求与应答合成一组（一张表行）：点行即选中，右侧出该组的两个方向。
 * 解密失败时**说清原因**（缺 d2key / 明文帧 / 解析不了），不再一律甩锅给 d2key。
 *
 * Windows 上开启前检查 Npcap（`probeCaptureSupport`），缺失直接弹窗引导安装；
 * Linux/macOS 则要 root / CAP_NET_RAW，而 Electron 不能以 root 运行 —— 所以
 * 「开始抓包」时主进程会弹授权窗口，把抓包会话放进一个临时提权子进程里，前端只管
 * 照常 start / poll / stop（工具条会标出「提权」）。抓包会读原始流量，用完请「停止」。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Copy,
  Download,
  FileJson,
  FileText,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import { useOverlayLayer } from '../lib/overlayStack';
import { client } from '../trpc/client';
import { useDialog } from './Dialog';
import { decodeAnyBytes, RvTree } from './ReverseTool';
import { useToast } from './Toast';

/** 后端传回的帧（hex 形态）。与主进程 `CaptureFrameWire` 保持一致。 */
interface CaptureFrameWire {
  cursor: number;
  ts: number;
  direction: 'c2s' | 's2c';
  proto: number;
  encryptType: number;
  seq: number;
  cmd: string | null;
  rawHex: string;
  plainHex: string;
  bodyHex: string;
}

interface CaptureSupportWire {
  available: boolean;
  backend: string;
  elevated: boolean;
  hint: string;
  platform: string;
}

interface CaptureSessionState {
  pid: number;
  iface: string;
  port: string;
  linktype: number;
  /** 会话是否跑在临时提权子进程里（Linux/macOS 非 root 时必然为真）。 */
  elevated: boolean;
  /** 本次会话是否拿到了 d2key —— 没拿到就只能看原始密文。 */
  hasD2Key: boolean;
}

/** 同一 seq 的请求与应答合并成一组（一行）。 */
interface CaptureGroup {
  key: string;
  seq: number;
  c2s?: CaptureFrameWire;
  s2c?: CaptureFrameWire;
  /** 组内最早帧在列表中的序号，用于稳定排序。 */
  order: number;
}

/** 前端最多保留的帧数，避免长时间抓包把渲染层内存撑爆。 */
const MAX_FRAMES = 4000;
/** 单次 hexdump 默认渲染的字节数，超过可用「显示全部」展开。 */
const HEX_PREVIEW_BYTES = 2048;
/** 列表栏默认宽度占比（可拖动分隔条调整）。 */
const DEFAULT_SPLIT = 0.46;
/** 原包小于该字节数的一律当噪声丢掉（TCP ack / 心跳之流）。 */
const MIN_RAW_BYTES = 75;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 加密类型文案（native：0 = 不加密，1 = d2key，2 = 全零 key）。 */
function encryptLabel(type: number): string {
  if (type === 0) return '明文（未加密）';
  if (type === 1) return 'd2key';
  if (type === 2) return '全零 key';
  return `#${type}`;
}

/** 一帧的解密结果：成功（有明文）/ 未加密 / 没解开。 */
type FrameState = 'plain' | 'decrypted' | 'failed';

function frameState(f: CaptureFrameWire): FrameState {
  if (f.plainHex) return 'decrypted';
  return f.encryptType === 0 ? 'plain' : 'failed';
}

/** 该帧要展示给「解密数据」那栏的字节：优先正文，退回完整明文。 */
function framePayload(f: CaptureFrameWire): Uint8Array {
  return hexToBytes(f.bodyHex || f.plainHex);
}

/** 一组（发包 + 收包）原始帧的字节数。 */
function groupRawBytes(g: CaptureGroup): number {
  const c2s = g.c2s ? hexToBytes(g.c2s.rawHex).length : 0;
  const s2c = g.s2c ? hexToBytes(g.s2c.rawHex).length : 0;
  return c2s + s2c;
}

function dirGlyph(g: CaptureGroup): ReactElement {
  const both = Boolean(g.c2s && g.s2c);
  if (both) return <ArrowUpDown size={12} />;
  if (g.c2s) return <ArrowUp size={12} />;
  return <ArrowDown size={12} />;
}

/** 逐行 hexdump（偏移 + hex + ASCII）。 */
function HexDump({ bytes, copyText }: { bytes: Uint8Array; copyText: string }): ReactElement {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? bytes : bytes.subarray(0, HEX_PREVIEW_BYTES);
  const rows: ReactElement[] = [];
  for (let off = 0; off < shown.length; off += 16) {
    const slice = shown.subarray(off, off + 16);
    const hex = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    const ascii = Array.from(slice)
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
      .join('');
    rows.push(
      <div className="weq-cap-hx-line" key={off}>
        <span className="weq-cap-hx-off">{off.toString(16).padStart(8, '0')}</span>
        <span className="weq-cap-hx-hex">{hex}</span>
        <span className="weq-cap-hx-ascii">{ascii}</span>
      </div>,
    );
  }
  return (
    <div className="weq-cap-hexdump">
      <div className="weq-cap-hexdump-body">{rows}</div>
      <div className="weq-cap-hexdump-foot">
        <span>
          {bytes.length === 0
            ? '空'
            : showAll
              ? `已显示全部 ${fmtBytes(bytes.length)}`
              : `前 ${Math.min(bytes.length, HEX_PREVIEW_BYTES)} B / 共 ${fmtBytes(bytes.length)}`}
        </span>
        {!showAll && bytes.length > HEX_PREVIEW_BYTES ? (
          <button type="button" className="weq-cap-more" onClick={() => setShowAll(true)}>
            显示全部
          </button>
        ) : null}
        <CopyHex text={copyText} disabled={bytes.length === 0} />
      </div>
    </div>
  );
}

/** 复制 hex 文本的小按钮（带 1.4s 的已复制反馈）。 */
function CopyHex({ text, disabled }: { text: string; disabled?: boolean }): ReactElement {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="weq-cap-iconbtn"
      title="复制 hex"
      disabled={disabled}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/** 键值表（「总览」栏）。 */
function KvGrid({ rows }: { rows: [string, ReactElement | string][] }): ReactElement {
  return (
    <div className="weq-cap-kv">
      {rows.map(([k, v]) => (
        <div className="weq-cap-kv-row" key={k}>
          <span className="weq-cap-kv-k">{k}</span>
          <span className="weq-cap-kv-v">{v}</span>
        </div>
      ))}
    </div>
  );
}

/** 右侧详情：一个方向的数据（总览 / 解密数据 / 原始数据）。 */
function FrameDetail({
  frame,
  dirLabel,
}: {
  frame: CaptureFrameWire;
  dirLabel: string;
}): ReactElement {
  const [tab, setTab] = useState<'overview' | 'decoded' | 'raw'>('decoded');
  const raw = useMemo(() => hexToBytes(frame.rawHex), [frame.rawHex]);
  const payload = useMemo(() => framePayload(frame), [frame]);
  const decoded = useMemo(() => (payload.length > 0 ? decodeAnyBytes(payload) : null), [payload]);
  const state = frameState(frame);

  const stateText =
    state === 'decrypted' ? '已解密' : state === 'plain' ? '明文帧（未加密）' : '未解密';

  return (
    <div className="weq-cap-frame">
      <div className="weq-cap-tabs" role="tablist" aria-label="数据视图">
        {(
          [
            { key: 'overview', label: '总览', meta: null },
            {
              key: 'decoded',
              label: '解密数据',
              meta: payload.length > 0 ? fmtBytes(payload.length) : null,
            },
            { key: 'raw', label: '原始数据', meta: fmtBytes(raw.length) },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`weq-cap-tab${tab === t.key ? ' is-on' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.meta ? <em>{t.meta}</em> : null}
          </button>
        ))}
        <span className="weq-cap-tabs-meta">
          <span className={`weq-cap-state is-${state}`}>{stateText}</span>
        </span>
      </div>

      <div className="weq-cap-pane">
        {tab === 'overview' ? (
          <KvGrid
            rows={[
              [
                '方向',
                `${dirLabel}（${frame.direction === 'c2s' ? '客户端 → 服务端' : '服务端 → 客户端'}）`,
              ],
              ['命令字', frame.cmd ?? '（无命令字）'],
              ['序号', `seq ${frame.seq}`],
              ['加密', encryptLabel(frame.encryptType)],
              ['时间', `${fmtClock(frame.ts)}（游标 ${frame.cursor}）`],
              ['proto', String(frame.proto)],
              ['原始大小', fmtBytes(raw.length)],
              ['解密大小', payload.length > 0 ? fmtBytes(payload.length) : '—（未解开）'],
              ['解析结果', decoded ? decoded.kind : payload.length === 0 ? '—' : '无法识别'],
            ]}
          />
        ) : tab === 'raw' ? (
          <HexDump bytes={raw} copyText={frame.rawHex} />
        ) : payload.length === 0 ? (
          <div className="weq-cap-note">
            {state === 'plain'
              ? '明文帧：没有 SSO 包体可解密（如心跳 / ack）。'
              : '这一帧没解开：TEA 密文要用该会话的 d2key 才能解。若是本次会话没拿到 d2key，请在 QQ 在线时重新「开始抓包」。'}
          </div>
        ) : (
          <div className="weq-cap-decoded">
            <div className="weq-cap-decoded-tag">
              <span className={`weq-cap-kind is-${decoded?.kind ?? 'unknown'}`}>
                {decoded ? decoded.kind : 'raw'}
              </span>
              {!decoded ? (
                <span className="weq-cap-hint">无法按 protobuf / JCE 解析，已按原文展示</span>
              ) : null}
            </div>
            <div className="weq-cap-tree">
              {decoded ? (
                <RvTree nodes={decoded.nodes} />
              ) : (
                <HexDump bytes={payload} copyText={frame.bodyHex || frame.plainHex} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 右侧：选中的一组（发包 / 收包 两个方向）。 */
function GroupDetail({ group }: { group: CaptureGroup }): ReactElement {
  const [dir, setDir] = useState<'c2s' | 's2c'>(group.c2s ? 'c2s' : 's2c');
  const both = Boolean(group.c2s && group.s2c);

  // 切换选中行时，若当前方向在那一组里不存在，就落到存在的那一侧。
  useEffect(() => {
    setDir((prev) =>
      prev === 'c2s' && !group.c2s ? 's2c' : prev === 's2c' && !group.s2c ? 'c2s' : prev,
    );
  }, [group]);

  const active = dir === 's2c' ? group.s2c : group.c2s;
  const dirLabel = dir === 'c2s' ? '发包' : '收包';

  return (
    <div className="weq-cap-detail-inner">
      <header className="weq-cap-dhead">
        <span className={`weq-cap-dir-tag is-${dir}`}>{dirLabel}</span>
        <span className="weq-cap-dcmd" title={active?.cmd ?? undefined}>
          {active?.cmd ?? '（无命令字）'}
        </span>
        <span className="weq-cap-hint">
          seq {group.seq}
          {active ? ` · ${fmtClock(active.ts)}` : ''}
        </span>
      </header>

      {both ? (
        <div className="weq-cap-tabs is-primary" role="tablist" aria-label="方向">
          {(
            [
              { key: 'c2s', label: '发包', frame: group.c2s },
              { key: 's2c', label: '收包', frame: group.s2c },
            ] as const
          ).map((d) => (
            <button
              key={d.key}
              type="button"
              role="tab"
              aria-selected={dir === d.key}
              className={`weq-cap-tab${dir === d.key ? ' is-on' : ''}`}
              onClick={() => setDir(d.key)}
            >
              {d.label}
              <em>{d.frame ? fmtBytes(hexToBytes(d.frame.rawHex).length) : '—'}</em>
            </button>
          ))}
        </div>
      ) : null}

      {active ? (
        <FrameDetail frame={active} dirLabel={dirLabel} />
      ) : (
        <div className="weq-cap-note">这一组里没有该方向的帧。</div>
      )}
    </div>
  );
}

/** 导出按钮的下拉菜单：JSON（自包含文档）/ JSONL（每行一帧）。 */
function ExportMenu({
  anchor,
  busy,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null;
  busy: boolean;
  onPick: (format: 'json' | 'jsonl') => void;
  onClose: () => void;
}): ReactElement | null {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const layer = useOverlayLayer(true);

  useEffect(() => {
    const margin = 6;
    const gap = 4;
    const el = menuRef.current;
    const rect = anchor?.getBoundingClientRect();
    const width = el?.offsetWidth ?? 190;
    const height = el?.offsetHeight ?? 110;
    let top = rect ? rect.bottom + gap : margin;
    if (top + height > window.innerHeight - margin) {
      top = rect ? Math.max(margin, rect.top - height - gap) : margin;
    }
    let left = rect ? rect.right - width : margin;
    if (left < margin) left = margin;
    if (left + width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - width - margin);
    }
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="weq-cap-menu"
      role="menu"
      aria-label="导出格式"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        zIndex: layer,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => onPick('json')}
        title="一份自包含的文档（meta + frames），适合直接看或发给别人"
      >
        <FileJson size={14} />
        <span>
          JSON
          <em>自包含文档，含解析树</em>
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => onPick('jsonl')}
        title="每行一帧，方便用 jq / grep 流式筛"
      >
        <FileText size={14} />
        <span>
          JSONL
          <em>每行一帧，便于流式处理</em>
        </span>
      </button>
    </div>,
    document.body,
  );
}

export function CapturePanel({
  accounts,
}: {
  accounts: { uin: string; name: string; avatarUrl: string; pid: number | null }[];
}): ReactElement {
  const dialog = useDialog();
  const onlineAccounts = accounts.filter((a) => a.pid !== null);

  const [support, setSupport] = useState<CaptureSupportWire | null>(null);
  const [selectedUin, setSelectedUin] = useState<string>('');
  const [session, setSession] = useState<CaptureSessionState | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [frames, setFrames] = useState<CaptureFrameWire[]>([]);
  const [dropped, setDropped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  /** 过滤：方向 + 关键字（命令字 / seq）。 */
  const [dirFilter, setDirFilter] = useState<'all' | 'c2s' | 's2c'>('all');
  const [query, setQuery] = useState('');
  /** 选中的组；null = 跟随最新一组。 */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const [dragging, setDragging] = useState(false);
  /** 导出：按钮处于导出中 / 下拉菜单挂在哪个按钮上（null = 收起）。 */
  const [exporting, setExporting] = useState(false);
  const [exportAnchor, setExportAnchor] = useState<HTMLElement | null>(null);
  const exportBtnRef = useRef<HTMLButtonElement | null>(null);

  const cursorRef = useRef<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const dragRef = useRef(false);

  // 默认选中第一个在线账号。
  useEffect(() => {
    if (!selectedUin && onlineAccounts.length > 0) setSelectedUin(onlineAccounts[0]!.uin);
  }, [onlineAccounts, selectedUin]);

  const refreshSupport = useCallback(async (): Promise<void> => {
    try {
      setSupport(await client.wonderfulTools.captureSupport.query());
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void refreshSupport();
  }, [refreshSupport]);

  // 轮询新帧（长轮询：每次最多等 waitMs）。暂停即退出循环，native 会话仍 armed。
  useEffect(() => {
    if (!running || !session) return undefined;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      while (!cancelled) {
        try {
          const res = await client.wonderfulTools.capturePoll.query({
            pid: session.pid,
            cursor: cursorRef.current,
            waitMs: 1000,
          });
          if (cancelled) return;
          cursorRef.current = res.nextCursor;
          setDropped(res.dropped);
          if (res.frames.length > 0) {
            setFrames((prev) => {
              const merged = [...prev, ...res.frames];
              const excess = merged.length - MAX_FRAMES;
              return excess > 0 ? merged.slice(excess) : merged;
            });
          }
        } catch (e) {
          if (!cancelled) {
            setError(errMsg(e));
            setRunning(false);
          }
          return;
        }
      }
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [running, session]);

  /** 开始抓包（无会话时）或继续（已有会话时）。 */
  const startOrResume = useCallback(async (): Promise<void> => {
    if (busy) return;
    setError(null);
    if (session) {
      setRunning(true);
      return;
    }
    if (!selectedUin) {
      setError('请先选择一个在线的 QQ 账号');
      return;
    }
    setBusy(true);
    try {
      // 后端不可用时按平台给引导：只有 Windows 才可能「缺后端 = 缺 Npcap」，
      // 其它情况（Linux 装了旧产物没带抓包接口等）照 hint 说，别一律甩 Npcap 安装页。
      const sup = support ?? (await client.wonderfulTools.captureSupport.query());
      setSupport(sup);
      if (!sup.available) {
        if (sup.platform === 'win32') {
          const openSite = await dialog.confirm(
            '需要 Npcap',
            <>
              Windows 抓包依赖 <strong>Npcap</strong>
              （安装时勾选 WinPcap API-compatible Mode），当前未检测到。是否前往官网下载？
            </>,
            { okLabel: '打开官网', cancelLabel: '取消', tone: 'warning' },
          );
          if (openSite) {
            await client.help.openExternal
              .mutate({ url: 'https://npcap.com/#download' })
              .catch(() => undefined);
          }
        } else {
          dialog.showError('抓包后端不可用', sup.hint || '当前平台的抓包后端不可用。');
        }
        return;
      }
      const s = await client.wonderfulTools.captureStart.mutate({ uin: selectedUin });
      cursorRef.current = undefined;
      setFrames([]);
      setDropped(0);
      setSelectedKey(null);
      setSession({
        pid: s.pid,
        iface: s.iface,
        port: s.port,
        linktype: s.linktype,
        elevated: s.elevated,
        hasD2Key: s.hasD2Key,
      });
      setRunning(true);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [busy, session, selectedUin, support, dialog]);

  const pause = useCallback((): void => {
    setRunning(false);
  }, []);

  /** 停止并释放 native 会话，清空列表。 */
  const stopAndClear = useCallback(async (): Promise<void> => {
    setRunning(false);
    const pid = session?.pid;
    setSession(null);
    cursorRef.current = undefined;
    setFrames([]);
    setDropped(0);
    setSelectedKey(null);
    if (pid) {
      try {
        await client.wonderfulTools.captureStop.mutate({ pid });
      } catch {
        // 幂等停止：会话已释放也无所谓。
      }
    }
  }, [session]);

  /** 清空列表但不停会话。 */
  const clearList = useCallback((): void => {
    setFrames([]);
    setDropped(0);
    setSelectedKey(null);
  }, []);

  /** 重新读一次后端能力（提权状态 / Npcap）——排查「抓不到 / 解不开」时用。 */
  const rediagnose = useCallback(async (): Promise<void> => {
    setDiagnosing(true);
    setError(null);
    try {
      const sup = await client.wonderfulTools.captureSupport.query();
      setSupport(sup);
      // 会话在跑：顺手让 native 再回一次统计（帧数 / 丢包），确认读循环还活着。
      if (session) {
        const batch = await client.wonderfulTools.capturePoll.query({
          pid: session.pid,
          cursor: cursorRef.current,
          waitMs: 0,
        });
        cursorRef.current = batch.nextCursor;
        setDropped(batch.dropped);
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setDiagnosing(false);
    }
  }, [session]);

  const groups = useMemo<CaptureGroup[]>(() => {
    // 同一个 seq 的 c2s / s2c 合成一组；seq 被复用时（两侧都占满）另起一组，
    // 免得早先的包被后来的覆盖掉。
    const bySeq = new Map<number, CaptureGroup[]>();
    frames.forEach((f, i) => {
      const list = bySeq.get(f.seq);
      let g = list?.find((it) => (f.direction === 'c2s' ? !it.c2s : !it.s2c));
      if (!g) {
        g = { key: `${f.seq}:${i}`, seq: f.seq, order: i };
        if (list) list.push(g);
        else bySeq.set(f.seq, [g]);
      }
      if (f.direction === 'c2s') g.c2s = f;
      else g.s2c = f;
    });
    // 丢掉小于阈值的原包：多半是 TCP ack / 心跳这类噪声，留着只会刷屏。
    return [...bySeq.values()]
      .flat()
      .filter((g) => groupRawBytes(g) >= MIN_RAW_BYTES)
      .sort((a, b) => a.order - b.order);
  }, [frames]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups.filter((g) => {
      if (dirFilter === 'c2s' && !g.c2s) return false;
      if (dirFilter === 's2c' && !g.s2c) return false;
      if (!q) return true;
      const cmd = `${g.c2s?.cmd ?? ''} ${g.s2c?.cmd ?? ''}`.toLowerCase();
      return cmd.includes(q) || String(g.seq).includes(q);
    });
  }, [groups, dirFilter, query]);

  const newestKey = groups.length > 0 ? groups[groups.length - 1]!.key : null;
  const activeKey = selectedKey ?? newestKey;
  const activeGroup = useMemo(
    () => visible.find((g) => g.key === activeKey) ?? null,
    [visible, activeKey],
  );

  /**
   * 导出当前列表里**符合过滤条件**的帧（也就是用户眼前看到的这些）：合并每个组
   * 的发包 / 收包，按时间顺序拍平后交给主进程落盘。
   *
   * 走 `captureExport`：桌面端弹系统保存框；Web 端写进导出目录并回带下载地址。
   */
  const runExport = useCallback(
    async (format: 'json' | 'jsonl'): Promise<void> => {
      setExportAnchor(null);
      if (exporting) return;
      const exportFrames: CaptureFrameWire[] = [];
      for (const g of visible) {
        if (g.c2s) exportFrames.push(g.c2s);
        if (g.s2c) exportFrames.push(g.s2c);
      }
      exportFrames.sort((a, b) => a.cursor - b.cursor);
      if (exportFrames.length === 0) {
        setError('没有可导出的帧');
        return;
      }

      setExporting(true);
      setError(null);
      const toast = useToast.getState();
      const toastId = toast.push({
        tone: 'info',
        title: '正在导出抓包结果…',
        ttl: 4000,
      });
      try {
        const account = accounts.find((a) => a.uin === selectedUin);
        const nameParts = [
          'capture',
          account?.name || selectedUin || 'unknown',
          session ? `${session.iface}` : null,
        ].filter(Boolean);
        const result = await client.wonderfulTools.captureExport.mutate({
          name: nameParts.join('_'),
          uin: selectedUin || undefined,
          iface: session?.iface,
          port: session?.port,
          format,
          frames: exportFrames,
        });
        if (result.saved) {
          const sizeLabel = result.bytes ? fmtBytes(result.bytes) : '';
          if (result.downloadId) {
            // Web 端：把文件从服务端拉下来（浏览器直接下载）。
            const a = document.createElement('a');
            a.href = `/_download/${result.downloadId}`;
            a.download = result.path ? result.path.split(/[\\/]/).pop() || '' : '';
            document.body.appendChild(a);
            a.click();
            a.remove();
          }
          toast.update(toastId, {
            tone: 'success',
            title: `已导出 ${result.frames ?? exportFrames.length} 帧${
              sizeLabel ? `（${sizeLabel}）` : ''
            }`,
            detail: result.downloadId ? '已开始下载' : result.path,
            ttl: 8000,
          });
        } else if (result.canceled) {
          toast.update(toastId, { tone: 'info', title: '已取消导出', ttl: 3000 });
        } else {
          toast.update(toastId, {
            tone: 'error',
            title: '导出失败',
            detail: result.error ?? '未知错误',
            ttl: 8000,
          });
        }
      } catch (e) {
        toast.update(toastId, { tone: 'error', title: '导出失败', detail: errMsg(e), ttl: 8000 });
      } finally {
        setExporting(false);
      }
    },
    [accounts, exporting, selectedUin, session, visible],
  );

  const frameStats = useMemo(() => {
    let ok = 0;
    let bad = 0;
    for (const g of groups) {
      for (const f of [g.c2s, g.s2c]) {
        if (!f) continue;
        if (frameState(f) === 'failed') bad += 1;
        else ok += 1;
      }
    }
    return { ok, bad };
  }, [groups]);

  // 新帧到达且处于跟随状态时自动滚到底部。
  useEffect(() => {
    if (!followRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  // 拖动分隔条：按下后跟着指针走，夹在 24%–78% 之间。
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      if (!dragRef.current) return;
      const el = splitRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (e.clientX - rect.left) / rect.width;
      setSplit(Math.min(0.78, Math.max(0.24, ratio)));
    };
    const onUp = (): void => {
      if (!dragRef.current) return;
      dragRef.current = false;
      setDragging(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const supportWarn = support && !support.available;
  const needsElevation = support?.available && !support.elevated;
  const noKey = Boolean(session) && !session?.hasD2Key;
  const primaryLabel = busy ? '正在开启…' : running ? '暂停' : session ? '继续' : '开始抓包';

  return (
    <div className="weq-cap">
      {/* 工具条 */}
      <div className="weq-cap-bar">
        <span className={`weq-cap-led${running ? ' is-live' : ''}`} aria-hidden />
        <span
          className="weq-cap-env"
          title={session ? `${session.iface} · 端口 ${session.port}` : '未开始'}
        >
          {session ? `${session.iface}:${session.port}` : '未连接'}
        </span>

        <span className="weq-cap-metrics">
          <span>
            帧 <b>{groups.length}</b>
          </span>
          <span>
            已解密 <b>{frameStats.ok}</b>
          </span>
          {frameStats.bad > 0 ? (
            <span className="is-warn">
              未解密 <b>{frameStats.bad}</b>
            </span>
          ) : null}
          {dropped > 0 ? (
            <span className="is-warn">
              丢 <b>{dropped}</b>
            </span>
          ) : null}
        </span>

        {session?.elevated ? <span className="weq-cap-tag">提权</span> : null}
        {session ? (
          session.hasD2Key ? (
            <span className="weq-cap-tag is-ok" title="本次会话已拿到 d2key，TEA 密文能解">
              d2key
            </span>
          ) : (
            <span className="weq-cap-tag is-bad" title="本次会话没拿到 d2key，只能看原始密文">
              无 d2key
            </span>
          )
        ) : null}

        <span className="weq-cap-spacer" />

        <label className="weq-cap-acct">
          <span>账号</span>
          <select
            value={selectedUin}
            disabled={Boolean(session) || onlineAccounts.length === 0}
            onChange={(e) => setSelectedUin(e.target.value)}
          >
            {onlineAccounts.length === 0 ? (
              <option value="">（无在线 QQ）</option>
            ) : (
              onlineAccounts.map((a) => (
                <option key={a.uin} value={a.uin}>
                  {a.name || a.uin}（{a.uin}）
                </option>
              ))
            )}
          </select>
        </label>

        <button
          type="button"
          className={`weq-cap-btn is-primary${running ? ' is-pause' : ''}`}
          onClick={() => (running ? pause() : void startOrResume())}
          disabled={busy || (running ? false : onlineAccounts.length === 0)}
          title={running ? '暂停采集（保留已抓到的包）' : session ? '继续采集' : '开始抓包'}
        >
          {busy ? (
            <Loader2 size={13} className="weq-spin" />
          ) : running ? (
            <Pause size={13} />
          ) : (
            <Play size={13} />
          )}
          {primaryLabel}
        </button>

        <button
          type="button"
          className="weq-cap-btn"
          onClick={() => void stopAndClear()}
          disabled={!session}
          title="停止抓包并清空列表（释放网卡）"
        >
          <Square size={12} />
          停止
        </button>

        <button
          ref={exportBtnRef}
          type="button"
          className={`weq-cap-btn${exportAnchor ? ' is-open' : ''}`}
          onClick={() => setExportAnchor((prev) => (prev ? null : exportBtnRef.current))}
          disabled={exporting || visible.length === 0}
          title="导出当前列表（按过滤条件）为 JSON / JSONL 文件"
        >
          {exporting ? <Loader2 size={13} className="weq-spin" /> : <Download size={13} />}
          导出
        </button>

        <button
          type="button"
          className="weq-cap-iconbtn"
          onClick={() => void rediagnose()}
          disabled={diagnosing}
          title="重新检查抓包后端 / 提权状态，并探一次会话是否还活着"
        >
          <RefreshCw size={13} className={diagnosing ? 'weq-spin' : ''} />
        </button>

        <button
          type="button"
          className="weq-cap-iconbtn"
          onClick={clearList}
          disabled={frames.length === 0}
          title="清空当前列表（不影响抓包）"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* 依赖 / 权限 / d2key 提示 */}
      {supportWarn ? (
        <div className="weq-cap-banner is-warn" role="alert" title={support?.hint}>
          <AlertTriangle size={13} aria-hidden />
          <span>
            {support?.hint || '当前平台的抓包后端不可用（Windows 需安装 Npcap）。'}
            {support?.platform === 'win32' ? (
              <button
                type="button"
                className="weq-cap-link"
                onClick={() =>
                  void client.help.openExternal
                    .mutate({ url: 'https://npcap.com/#download' })
                    .catch(() => undefined)
                }
              >
                去安装
              </button>
            ) : null}
          </span>
        </div>
      ) : noKey ? (
        <div className="weq-cap-banner is-warn" role="alert">
          <AlertTriangle size={13} aria-hidden />
          <span>
            本次会话没拿到 <b>d2key</b>：TEA 加密的帧只能看原始密文。请确认该账号的 QQ
            正在运行、且「设置 → 账号基础 → 自动读取 QQ 内存」没有被关掉，然后重新开始抓包。
          </span>
        </div>
      ) : needsElevation ? (
        <div className="weq-cap-banner is-warn" role="alert" title={support?.hint}>
          <AlertTriangle size={13} aria-hidden />
          <span>
            {support?.platform === 'win32'
              ? 'Windows 抓包需要管理员权限（Npcap 驱动默认只允许管理员访问）。若「开始抓包」报权限错误，请以管理员身份重新运行 WeQ。'
              : '抓包需要管理员权限（原始套接字）。WeQ 不能以管理员身份运行，点「开始抓包」时会弹出授权窗口，由临时的管理员子进程完成抓包。'}
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="weq-cap-banner is-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}

      {/* 主体：左表 + 右详情 */}
      <div
        className={`weq-cap-split${dragging ? ' is-dragging' : ''}`}
        ref={splitRef}
        style={{ gridTemplateColumns: `${split}fr 7px ${1 - split}fr` }}
      >
        <section className="weq-cap-list">
          <div className="weq-cap-filter">
            <div className="weq-cap-seg" role="tablist" aria-label="方向过滤">
              {(
                [
                  { key: 'all', label: '全部' },
                  { key: 'c2s', label: '发包' },
                  { key: 's2c', label: '收包' },
                ] as const
              ).map((d) => (
                <button
                  key={d.key}
                  type="button"
                  role="tab"
                  aria-selected={dirFilter === d.key}
                  className={`weq-cap-seg-btn${dirFilter === d.key ? ' is-on' : ''}`}
                  onClick={() => setDirFilter(d.key)}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <input
              className="weq-cap-search"
              type="search"
              value={query}
              placeholder="过滤 命令字 / seq"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="weq-cap-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className="weq-cap-row is-head">
              <span>命令字</span>
              <span>方向</span>
              <span>seq</span>
              <span>时间</span>
              <span>大小</span>
              <span>#</span>
            </div>
            {visible.length === 0 ? (
              <div className="weq-cap-empty">
                {onlineAccounts.length === 0
                  ? '无在线 QQ'
                  : groups.length === 0
                    ? running
                      ? '正在监听网卡，等待 QQ 的包…'
                      : '尚无抓到的包'
                    : '没有符合过滤条件的包'}
              </div>
            ) : (
              visible.map((g) => {
                const cmd = g.c2s?.cmd ?? g.s2c?.cmd ?? null;
                const totalBytes = groupRawBytes(g);
                const failed = [g.c2s, g.s2c].some((f) => f && frameState(f) === 'failed');
                const ts = (g.c2s?.ts ?? g.s2c?.ts ?? 0) || 0;
                return (
                  <button
                    key={g.key}
                    type="button"
                    className={`weq-cap-row${activeKey === g.key ? ' is-sel' : ''}`}
                    onClick={() => setSelectedKey(g.key)}
                  >
                    <span className="is-cmd" title={cmd ?? undefined}>
                      {cmd ?? '（无命令字）'}
                    </span>
                    <span
                      className={`is-dir is-${g.c2s && g.s2c ? 'both' : g.c2s ? 'c2s' : 's2c'}`}
                    >
                      {dirGlyph(g)}
                    </span>
                    <span className="is-seq">{g.seq}</span>
                    <span className="is-time">{fmtClock(ts)}</span>
                    <span className={`is-size${failed ? ' is-bad' : ''}`}>
                      {failed ? '密文 ' : ''}
                      {fmtBytes(totalBytes)}
                    </span>
                    <span className="is-id">{g.order + 1}</span>
                  </button>
                );
              })
            )}
          </div>

          <div className="weq-cap-foot">
            <span>
              共 {visible.length} 项{visible.length !== groups.length ? ` / ${groups.length}` : ''}
              {activeGroup ? '（选择 1 项）' : ''}
            </span>
            <span className="weq-cap-spacer" />
            {selectedKey && selectedKey !== newestKey ? (
              <button
                type="button"
                className="weq-cap-btn is-tiny"
                onClick={() => setSelectedKey(null)}
              >
                回到最新
              </button>
            ) : (
              <span className="weq-cap-hint">{running ? '跟随最新' : ''}</span>
            )}
          </div>
        </section>

        <div
          className="weq-cap-grip"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整列表宽度"
          onPointerDown={(e) => {
            e.preventDefault();
            dragRef.current = true;
            setDragging(true);
          }}
        />

        <section className="weq-cap-detail">
          {activeGroup ? (
            <GroupDetail group={activeGroup} />
          ) : (
            <div className="weq-cap-empty is-detail">
              {groups.length === 0 ? '抓到的包会出现在左侧列表' : '在左侧选一条包查看明细'}
            </div>
          )}
        </section>
      </div>

      {exportAnchor ? (
        <ExportMenu
          anchor={exportAnchor}
          busy={exporting}
          onPick={(format) => void runExport(format)}
          onClose={() => setExportAnchor(null)}
        />
      ) : null}
    </div>
  );
}
