/**
 * 通用 UDP 抓包面板。
 *
 * 与 `CapturePanel`（QQNT / OIDB 抓包）的分工：
 *   - 那个按**账号**选，抓 TCP，用 d2key 解 MSF 帧；
 *   - 这个按**进程**选，抓 UDP，**不解析任何业务协议**，载荷原样 hex。
 *
 * 版式照搬抓包面板（工具条 / 左右分栏 / 拖拽 / 详情 / 导出），但列表是一行一个
 * 数据报 —— UDP 没有请求/应答配对。
 *
 * 两个独立入口（刻意不做在一起）：
 *   1. 「推荐」—— 识别加载了 avsdk 的进程（QQ 的通话媒体进程）；
 *   2. 「选择进程」—— 通用进程列表，手动挑任意进程。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ArrowDown, ArrowUp, Download, Pause, Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import { client } from '../trpc/client';
import { useRenderDocument } from '../lib/renderDocument';
import { useToast } from './Toast';
import { HexDump } from './HexDump';
import { decodeAnyBytes, RvTree } from './ReverseTool';
import { ProcessPicker } from './ProcessPicker';
import '../styles/udp-capture.css';

/** 后端传回的帧（与主进程 `CaptureFrameWire` 同形）。 */
interface UdpFrameWire {
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
  udp?: {
    src: string;
    srcPort: number;
    dst: string;
    dstPort: number;
    payloadHex: string;
  };
}

interface UdpSupportWire {
  available: boolean;
  backend: string;
  elevated: boolean;
  hint: string;
  platform: string;
  processScan: boolean;
}

interface UdpSessionState {
  pid: number;
  sessionId: string;
  iface: string;
  port: string;
  linktype: number;
  elevated: boolean;
}

/** 前端保留上限：UDP 包多，超出裁掉最旧的。 */
const MAX_FRAMES = 4000;
/** 长轮询单次等待。 */
const POLL_WAIT_MS = 1000;

/**
 * 首字节的轻量标注。**不是协议解析** —— 只按通话流量的已知首字节着色，
 * 方便在长列表里一眼找到控制面 / 媒体 / 中继。
 */
const KIND_LABELS: Record<number, { label: string; tone: string }> = {
  40: { label: 'gcs', tone: 'ctl' },
  91: { label: 'media', tone: 'media' },
  2: { label: 'relay', tone: 'relay' },
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function hexToBytes(hex: string): Uint8Array {
  if (!hex) return new Uint8Array(0);
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtClock(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

function frameKind(frame: UdpFrameWire): { label: string; tone: string } | null {
  const payload = frame.udp?.payloadHex;
  if (!payload || payload.length < 2) return null;
  return KIND_LABELS[Number.parseInt(payload.slice(0, 2), 16)] ?? null;
}

function frameBytes(frame: UdpFrameWire): number {
  return Math.floor((frame.udp?.payloadHex.length ?? 0) / 2);
}

/** 单条数据报详情。 */
function DatagramDetail({ frame }: { frame: UdpFrameWire }): ReactElement {
  const [tab, setTab] = useState<'overview' | 'payload' | 'raw'>('overview');
  const udp = frame.udp;
  const payload = useMemo(() => hexToBytes(udp?.payloadHex ?? ''), [udp?.payloadHex]);
  const raw = useMemo(() => hexToBytes(frame.rawHex), [frame.rawHex]);
  const decoded = useMemo(() => (payload.length ? decodeAnyBytes(payload) : null), [payload]);
  const kind = frameKind(frame);

  return (
    <div className="weq-udp-detail">
      <div className="weq-udp-detail-tabs" role="tablist">
        {(
          [
            ['overview', '总览'],
            ['payload', '载荷'],
            ['raw', '原始数据'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`weq-udp-tab${tab === key ? ' is-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="weq-udp-detail-body">
        {tab === 'overview' ? (
          <table className="weq-udp-kv">
            <tbody>
              <tr>
                <th>时间</th>
                <td>{fmtClock(frame.ts)}</td>
              </tr>
              <tr>
                <th>方向</th>
                <td>{frame.direction === 'c2s' ? '本机 → 对端' : '对端 → 本机'}</td>
              </tr>
              <tr>
                <th>源</th>
                <td className="weq-udp-mono">{udp ? `${udp.src}:${udp.srcPort}` : '—'}</td>
              </tr>
              <tr>
                <th>目的</th>
                <td className="weq-udp-mono">{udp ? `${udp.dst}:${udp.dstPort}` : '—'}</td>
              </tr>
              <tr>
                <th>载荷</th>
                <td>{fmtBytes(frameBytes(frame))}</td>
              </tr>
              <tr>
                <th>首字节</th>
                <td>
                  {kind ? (
                    <span className={`weq-udp-kind is-${kind.tone}`}>{kind.label}</span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
              <tr>
                <th>序号</th>
                <td className="weq-udp-mono">#{frame.cursor}</td>
              </tr>
            </tbody>
          </table>
        ) : null}
        {tab === 'payload' ? (
          decoded ? (
            <div className="weq-udp-tree">
              <RvTree nodes={decoded.nodes} detail />
            </div>
          ) : (
            <HexDump bytes={payload} copyText={udp?.payloadHex ?? ''} />
          )
        ) : null}
        {tab === 'raw' ? <HexDump bytes={raw} copyText={frame.rawHex} /> : null}
      </div>
    </div>
  );
}

export function UdpCapturePanel(): ReactElement {
  const document = useRenderDocument();
  const toast = useToast();

  const [support, setSupport] = useState<UdpSupportWire | null>(null);
  const [session, setSession] = useState<UdpSessionState | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [frames, setFrames] = useState<UdpFrameWire[]>([]);
  const [dropped, setDropped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pid, setPid] = useState<number | null>(null);
  const [pidLabel, setPidLabel] = useState('');

  const [dirFilter, setDirFilter] = useState<'all' | 'c2s' | 's2c'>('all');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [portQuery, setPortQuery] = useState('');
  const [selectedCursor, setSelectedCursor] = useState<number | null>(null);

  const cursorRef = useRef<number | undefined>(undefined);
  const ownedSession = useRef<UdpSessionState | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  const refreshSupport = useCallback(async () => {
    try {
      setSupport(await client.udpCapture.support.query());
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void refreshSupport();
  }, [refreshSupport]);

  // 面板卸载时释放会话（窗口关闭 / 切 Tab）。
  useEffect(() => {
    const dispose = () => {
      const owned = ownedSession.current;
      if (!owned) return;
      ownedSession.current = null;
      void client.udpCapture.stop
        .mutate({ pid: owned.pid, sessionId: owned.sessionId })
        .catch(() => undefined);
    };
    document.defaultView?.addEventListener('beforeunload', dispose);
    return () => {
      document.defaultView?.removeEventListener('beforeunload', dispose);
      dispose();
    };
  }, [document]);

  // 长轮询。
  useEffect(() => {
    if (!running || !session) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      while (!cancelled) {
        try {
          const res = await client.udpCapture.poll.query({
            pid: session.pid,
            sessionId: session.sessionId,
            cursor: cursorRef.current,
            waitMs: POLL_WAIT_MS,
          });
          if (cancelled) return;
          cursorRef.current = res.nextCursor;
          setDropped(res.dropped);
          if (res.frames.length > 0) {
            setFrames((prev) => {
              const next = [...prev, ...(res.frames as UdpFrameWire[])];
              return next.length > MAX_FRAMES ? next.slice(next.length - MAX_FRAMES) : next;
            });
          }
        } catch (e) {
          if (cancelled) return;
          setError(errMsg(e));
          setRunning(false);
          return;
        }
      }
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [running, session]);

  const startOrResume = useCallback(async () => {
    if (session) {
      setRunning(true);
      return;
    }
    if (pid === null) {
      setPickerOpen(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!support) await refreshSupport();
      const started = await client.udpCapture.start.mutate({ pid });
      const next: UdpSessionState = {
        pid: started.pid,
        sessionId: started.sessionId,
        iface: started.iface,
        port: started.port,
        linktype: started.linktype,
        elevated: started.elevated,
      };
      ownedSession.current = next;
      cursorRef.current = undefined;
      setFrames([]);
      setDropped(0);
      setSession(next);
      setRunning(true);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [session, pid, support, refreshSupport]);

  const stopAndClear = useCallback(async () => {
    const current = session;
    setRunning(false);
    setSession(null);
    ownedSession.current = null;
    cursorRef.current = undefined;
    if (!current) return;
    try {
      await client.udpCapture.stop.mutate({ pid: current.pid, sessionId: current.sessionId });
    } catch {
      // 幂等停止：会话可能已经没了。
    }
  }, [session]);

  const visible = useMemo(() => {
    const q = portQuery.trim();
    return frames.filter((frame) => {
      if (dirFilter !== 'all' && frame.direction !== dirFilter) return false;
      if (kindFilter !== 'all') {
        const kind = frameKind(frame);
        if (!kind || kind.label !== kindFilter) return false;
      }
      if (q && frame.udp) {
        const text = `${frame.udp.src}:${frame.udp.srcPort} ${frame.udp.dst}:${frame.udp.dstPort}`;
        if (!text.includes(q)) return false;
      }
      return true;
    });
  }, [frames, dirFilter, kindFilter, portQuery]);

  const activeFrame = useMemo(() => {
    if (selectedCursor === null) return visible.length ? visible[visible.length - 1]! : null;
    return visible.find((frame) => frame.cursor === selectedCursor) ?? null;
  }, [visible, selectedCursor]);

  // 跟随最新：用户滚到底部时自动贴住。
  useEffect(() => {
    const node = listRef.current;
    if (!node || !followRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [visible.length]);

  const runExport = useCallback(
    async (format: 'json' | 'jsonl' | 'pcapng') => {
      if (visible.length === 0) {
        toast.push({ tone: 'warning', title: '没有可导出的数据报' });
        return;
      }
      const id = toast.push({
        tone: 'info',
        title: '正在导出…',
        loading: true,
        durationKind: 'long',
      });
      try {
        const result = await client.udpCapture.export.mutate({
          pid: session?.pid,
          iface: session?.iface,
          format,
          frames: visible.map((frame) => ({
            cursor: frame.cursor,
            ts: frame.ts,
            direction: frame.direction,
            src: frame.udp?.src ?? '',
            srcPort: frame.udp?.srcPort ?? 0,
            dst: frame.udp?.dst ?? '',
            dstPort: frame.udp?.dstPort ?? 0,
            payloadHex: frame.udp?.payloadHex ?? '',
            rawHex: frame.rawHex,
          })),
        });
        if (result.saved) {
          toast.update(id, {
            tone: 'success',
            title: `已导出 ${visible.length} 条`,
            detail: result.path ?? undefined,
            loading: false,
          });
        } else if (result.canceled) {
          toast.dismiss(id);
        } else {
          toast.update(id, {
            tone: 'error',
            title: '导出失败',
            detail: result.error,
            loading: false,
          });
        }
      } catch (e) {
        toast.update(id, { tone: 'error', title: '导出失败', detail: errMsg(e), loading: false });
      }
    },
    [visible, session, toast],
  );

  const canStart = support?.available ?? false;
  const primaryLabel = busy ? '正在开启…' : running ? '暂停' : session ? '继续' : '开始抓包';

  return (
    <div className="weq-udp">
      <div className="weq-udp-bar">
        <span className={`weq-udp-led${running ? ' is-live' : ''}`} aria-hidden />
        <span
          className="weq-udp-env"
          title={session ? `${session.iface} · 端口 ${session.port}` : '未开始'}
        >
          {session ? `${session.iface}:${session.port}` : '未连接'}
        </span>
        <span className="weq-udp-metrics">
          <span>数据报 {frames.length}</span>
          <span className={dropped > 0 ? 'is-bad' : undefined}>丢包 {dropped}</span>
        </span>
        <span className="weq-udp-spacer" />
        <button
          type="button"
          className="weq-udp-proc"
          title="选择要抓包的进程"
          onClick={() => setPickerOpen(true)}
          disabled={running}
        >
          {pid === null ? '选择进程…' : `${pidLabel || 'pid'} (${pid})`}
        </button>
        <button
          type="button"
          className="weq-udp-btn is-primary"
          onClick={() => {
            if (running) setRunning(false);
            else void startOrResume();
          }}
          disabled={busy || (!canStart && !session)}
        >
          {running ? <Pause size={14} /> : <Play size={14} />}
          {primaryLabel}
        </button>
        <button
          type="button"
          className="weq-udp-btn"
          onClick={() => void stopAndClear()}
          disabled={!session}
          title="停止并释放会话"
        >
          <Square size={14} />
          停止
        </button>
        <button
          type="button"
          className="weq-udp-btn"
          onClick={() => void runExport('json')}
          disabled={visible.length === 0}
          title="导出为 JSON"
        >
          <Download size={14} />
          导出
        </button>
        <button
          type="button"
          className="weq-udp-btn"
          onClick={() => {
            setFrames([]);
            setDropped(0);
          }}
          disabled={frames.length === 0}
          title="清空列表（不停止抓包）"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {support && !support.available ? (
        <div className="weq-udp-warn">
          <strong>UDP 抓包不可用</strong>
          <span>{support.hint}</span>
          <button type="button" className="weq-udp-btn" onClick={() => void refreshSupport()}>
            <RefreshCw size={12} /> 重新检测
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="weq-udp-warn is-error">
          <strong>出错了</strong>
          <span>{error}</span>
          <button type="button" className="weq-udp-btn" onClick={() => setError(null)}>
            知道了
          </button>
        </div>
      ) : null}
      {dropped > 0 ? (
        <div className="weq-udp-warn is-error">
          <strong>有丢包</strong>
          <span>
            环形缓冲已淘汰 {dropped} 条（前端只留最近 {MAX_FRAMES} 条）。长时间抓包时建议 及时导出。
          </span>
        </div>
      ) : null}

      <div className="weq-udp-body">
        <div className="weq-udp-list-pane">
          <div className="weq-udp-filters">
            <div className="weq-udp-seg" role="group" aria-label="方向">
              {(
                [
                  ['all', '全部'],
                  ['c2s', '↑ 发出'],
                  ['s2c', '↓ 收到'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`weq-udp-seg-btn${dirFilter === key ? ' is-active' : ''}`}
                  onClick={() => setDirFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              className="weq-udp-select"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              aria-label="首字节类型"
            >
              <option value="all">全部类型</option>
              <option value="gcs">gcs (0x28)</option>
              <option value="media">media (0x5b)</option>
              <option value="relay">relay (0x02)</option>
            </select>
            <input
              className="weq-udp-search"
              placeholder="端口 / 地址"
              value={portQuery}
              onChange={(e) => setPortQuery(e.target.value)}
            />
          </div>
          <div
            className="weq-udp-list"
            ref={listRef}
            onScroll={(e) => {
              const node = e.currentTarget;
              followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
            }}
          >
            <div className="weq-udp-row is-head">
              <span>时间</span>
              <span>方向</span>
              <span>源 → 目的</span>
              <span>长度</span>
              <span>类型</span>
            </div>
            {visible.map((frame) => {
              const kind = frameKind(frame);
              const udp = frame.udp;
              return (
                <button
                  type="button"
                  key={frame.cursor}
                  className={`weq-udp-row${
                    activeFrame?.cursor === frame.cursor ? ' is-active' : ''
                  }`}
                  onClick={() => setSelectedCursor(frame.cursor)}
                >
                  <span className="weq-udp-mono">{fmtClock(frame.ts)}</span>
                  <span className={frame.direction === 'c2s' ? 'is-up' : 'is-down'}>
                    {frame.direction === 'c2s' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                  </span>
                  <span className="weq-udp-mono weq-udp-ep">
                    {udp ? `${udp.src}:${udp.srcPort} → ${udp.dst}:${udp.dstPort}` : '—'}
                  </span>
                  <span className="weq-udp-mono">{frameBytes(frame)}</span>
                  <span>
                    {kind ? (
                      <span className={`weq-udp-kind is-${kind.tone}`}>{kind.label}</span>
                    ) : (
                      '—'
                    )}
                  </span>
                </button>
              );
            })}
            {visible.length === 0 ? (
              <div className="weq-udp-empty">
                {session ? '还没有数据报' : '选一个进程并开始抓包'}
              </div>
            ) : null}
          </div>
          <div className="weq-udp-foot">
            共 {visible.length} 项
            {visible.length !== frames.length ? `（已筛选，总计 ${frames.length}）` : ''}
          </div>
        </div>
        <div className="weq-udp-detail-pane">
          {activeFrame ? (
            <DatagramDetail frame={activeFrame} />
          ) : (
            <div className="weq-udp-empty">选中一条数据报查看详情</div>
          )}
        </div>
      </div>

      {pickerOpen ? (
        <ProcessPicker
          onClose={() => setPickerOpen(false)}
          onPick={(entry) => {
            setPid(entry.pid);
            setPidLabel(entry.name || entry.cmdline.slice(0, 40));
            setPickerOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
