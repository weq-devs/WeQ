/**
 * 设置 → 帮助 → 日志查看。
 *
 * 支持 WeQ 自身日志（`YYYY-MM-DD.log`，JSONL）与 nt_helper / 原生加载日志，
 * 也支持选择历史文件。打开默认定位到文件尾部；勾选「实时更新」时跟随尾部
 * 自动追加；向上滚动可回溯旧内容（到达顶部自动加载更早的分块）。
 *
 * 读取按字节偏移分块进行（大文件安全），行解析按日志格式区分：
 *   - weq        JSONL：{ ts, level, message, context }
 *   - nt_helper  `[millis][LEVEL][target] message`
 *   - native     `[iso][scope] message`
 *   - 其它      原样展示
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  Bug,
  FileText,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { shellBridge } from '../../lib/target';
import { useToast } from '../Toast';
import { useDialog } from '../Dialog';
import { IconPicker, type IconPickerOption } from '../ui/iconPicker';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogLine {
  id: number;
  level: LogLevel;
  /** 本地化显示时间（无则 null）。 */
  ts: string | null;
  /** 消息主体（去除时间/级别前缀）。 */
  message: string;
  /** 上下文摘要（JSON 转 key=value，截断）。 */
  context?: string;
  /** 该行在文件内的字节区间。 */
  byteStart: number;
  byteLen: number;
}

interface LogBuffer {
  startOffset: number;
  endOffset: number;
  lines: LogLine[];
  /** 上一个分块结尾未闭合的半行（跨分块续接）。 */
  partial: string;
}

const CHUNK_BYTES = 256 * 1024;
const TAIL_BYTES = 384 * 1024;
const MAX_LINES = 24000;

const LEVEL_ORDER: LogLevel[] = ['error', 'warn', 'info', 'debug'];

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function fmtBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function fmtClock(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function normalizeLevel(raw: string | undefined | null): LogLevel {
  const v = (raw ?? '').toLowerCase();
  if (v === 'debug' || v === 'trace') return 'debug';
  if (v === 'warn' || v === 'warning') return 'warn';
  if (v === 'error' || v === 'fatal' || v === 'panic') return 'error';
  return 'info';
}

/** 把一行文本解析成 LogLine（不含字节区间信息，由调用方补齐）。 */
function parseLine(raw: string): Omit<LogLine, 'id' | 'byteStart' | 'byteLen'> {
  // WeQ JSONL
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw) as {
        ts?: string;
        level?: string;
        message?: string;
        context?: Record<string, unknown>;
      };
      if (typeof obj.message === 'string') {
        const ctx = obj.context;
        const ctxText =
          ctx && Object.keys(ctx).length > 0
            ? Object.entries(ctx)
                .map(([k, v]) => {
                  const s = typeof v === 'string' ? v : JSON.stringify(v);
                  return `${k}=${s}`;
                })
                .join(' ')
                .slice(0, 220)
            : undefined;
        return {
          level: normalizeLevel(obj.level),
          ts: obj.ts ?? null,
          message: obj.message,
          context: ctxText,
        };
      }
    } catch {
      // fall through to raw
    }
  }
  // nt_helper: [millis][LEVEL][target] message
  const nt = raw.match(/^\[(\d+)\]\[(\w+)\]\[([^\]]*)\] (.*)$/);
  if (nt) {
    const millis = Number(nt[1]);
    const ts = Number.isFinite(millis) ? new Date(millis).toISOString() : null;
    const target = nt[3] ?? '';
    return { level: normalizeLevel(nt[2]), ts, message: nt[4] ?? '', context: target || undefined };
  }
  // native_loader: [iso][scope] message
  const native = raw.match(/^\[([^\]]+)\]\s*\[([^\]]+)\] (.*)$/);
  if (native) {
    const ts = native[1]?.trim() ?? null;
    const scope = native[2]?.trim() ?? '';
    return {
      level: normalizeLevel(scope),
      ts,
      message: native[3] ?? '',
      context: scope || undefined,
    };
  }
  return { level: 'info', ts: null, message: raw };
}

/**
 * 把一段分块文本拆成完整行。
 *  - `partial`：上一分块结尾未闭合的半行（拼到开头再切）
 *  - `atFileStart`：分块起始就是文件头（此时首行是完整行，不丢弃）
 * 返回 { lines, partial: 新的未闭合半行, dropFirstBytes: 因首行残缺而丢弃的字节数 }
 */
function splitChunk(
  text: string,
  partial: string,
  atFileStart: boolean,
  boundaryKnown: boolean,
): { lines: string[]; nextPartial: string; dropFirstBytes: number } {
  let combined = partial + text;
  let nextPartial = '';
  if (combined.length > 0 && !combined.endsWith('\n')) {
    const idx = combined.lastIndexOf('\n');
    nextPartial = combined.slice(idx + 1);
    combined = combined.slice(0, idx + 1);
  }
  const lines = combined.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let dropFirstBytes = 0;
  // 分块起点未知（从任意字节偏移切入）、没有跨分块的半行可续接 → 首行是残缺行，丢弃。
  // 追加模式（boundaryKnown）起点是上一分块结尾，永远不丢。
  if (!boundaryKnown && !atFileStart && partial === '' && lines.length > 0) {
    const first = lines.shift() ?? '';
    dropFirstBytes = utf8ByteLength(first) + 1;
  }
  return { lines, nextPartial, dropFirstBytes };
}

/** 把一个分块解析成 LogLine[]，补齐字节区间。 */
function chunkToLines(
  text: string,
  baseOffset: number,
  partial: string,
  atFileStart: boolean,
  boundaryKnown: boolean,
  seqRef: { n: number },
): { lines: LogLine[]; nextPartial: string; consumed: number } {
  const { lines, nextPartial, dropFirstBytes } = splitChunk(
    text,
    partial,
    atFileStart,
    boundaryKnown,
  );
  let cursor = baseOffset + dropFirstBytes;
  // 有跨分块半行时，首行的字节起点要前移 partial 的长度
  const firstOffsetAdjust = partial.length > 0 ? -utf8ByteLength(partial) : 0;
  const out: LogLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const parsed = parseLine(raw);
    const byteLen = utf8ByteLength(raw);
    seqRef.n += 1;
    out.push({
      ...parsed,
      id: seqRef.n,
      byteStart: cursor + (i === 0 ? firstOffsetAdjust : 0),
      byteLen,
    });
    cursor += byteLen + 1;
  }
  return {
    lines: out,
    nextPartial,
    consumed: cursor - (partial.length > 0 ? utf8ByteLength(partial) : 0),
  };
}

export function LogViewerPanel(): ReactElement {
  const pushToast = useToast((s) => s.push);
  const dialog = useDialog();
  const utils = trpc.useUtils();
  const debugState = trpc.help.getNativeDebugLog.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    // 调试开关是运行时状态，唯一真相源在主进程（nt_helper 的 AtomicBool）。
    // 每次重新打开帮助弹窗都 refetch 一次对齐，避免吃到上次关闭时的旧缓存
    // （provider 默认 refetchOnMount:false 会让重挂载直接命中缓存）。
    refetchOnMount: 'always',
  });
  const [debugBusy, setDebugBusy] = useState(false);
  // 直接以查询结果为准（每次挂载都会对齐主进程），不再另存一份局部 state，
  // 否则重新打开弹窗时会与真实状态不同步。
  const debugOn = debugState.data?.enabled ?? false;
  const list = trpc.help.listLogFiles.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const files = list.data?.files ?? [];

  const [selectedPath, setSelectedPath] = useState<string>('');
  const [levels, setLevels] = useState<Record<LogLevel, boolean>>({
    debug: true,
    info: true,
    warn: true,
    error: true,
  });
  const [followTail, setFollowTail] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [buffer, setBuffer] = useState<LogBuffer>({
    startOffset: 0,
    endOffset: 0,
    lines: [],
    partial: '',
  });
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [size, setSize] = useState(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef({ n: 0 });
  const busyRef = useRef(false);
  const selectedRef = useRef('');

  // 首次列出后默认选最新一份 WeQ 日志
  useEffect(() => {
    if (selectedPath || files.length === 0) return;
    const weq = files.filter((f) => f.kind === 'weq').sort((a, b) => b.mtime - a.mtime);
    const fallback = weq[0] ?? files[0];
    if (fallback) setSelectedPath(fallback.path);
  }, [files, selectedPath]);

  // 记录当前文件，供轮询使用（避免闭包过期）
  useEffect(() => {
    selectedRef.current = selectedPath;
  }, [selectedPath]);

  /** 载入文件尾部（初始 / 切换文件）。 */
  const loadTail = useCallback(
    async (path: string): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setLoading(true);
      try {
        const info = await client.help.logFileInfo.query({ path });
        const start = Math.max(0, info.size - TAIL_BYTES);
        const chunk = await client.help.readLogChunk.query({
          path,
          offset: start,
          bytes: info.size - start,
        });
        const { lines, nextPartial, consumed } = chunkToLines(
          chunk.text,
          start,
          '',
          start === 0,
          false,
          seqRef.current,
        );
        setSize(info.size);
        setBuffer({
          startOffset: start + consumed,
          endOffset: chunk.nextOffset,
          lines,
          partial: nextPartial,
        });
        setLastUpdated(Date.now());
        setFollowTail(true);
      } catch (e) {
        pushToast({
          tone: 'error',
          title: '读取日志失败',
          detail: e instanceof Error ? e.message : String(e),
        });
      } finally {
        busyRef.current = false;
        setLoading(false);
      }
    },
    [pushToast],
  );

  // 切换文件
  useEffect(() => {
    if (!selectedPath) return;
    seqRef.current.n = 0;
    void loadTail(selectedPath);
  }, [selectedPath, loadTail]);

  /** 轮询追加尾部（跟随模式）。 */
  useEffect(() => {
    let timer: number | undefined;
    const tick = async (): Promise<void> => {
      const path = selectedRef.current;
      if (!path || busyRef.current) return;
      busyRef.current = true;
      try {
        const info = await client.help.logFileInfo.query({ path });
        setSize(info.size);
        const cur = bufferRef.current;
        if (info.size > cur.endOffset) {
          const chunk = await client.help.readLogChunk.query({
            path,
            offset: cur.endOffset,
            bytes: Math.min(CHUNK_BYTES, info.size - cur.endOffset),
          });
          const baseOffset = cur.endOffset;
          const { lines, nextPartial, consumed } = chunkToLines(
            chunk.text,
            baseOffset,
            cur.partial,
            false,
            true,
            seqRef.current,
          );
          setBuffer((prev) => {
            let merged = [...prev.lines, ...lines];
            // 防止无限增长：从头部裁掉最旧的
            const excess = merged.length - MAX_LINES;
            if (excess > 0) {
              merged = merged.slice(excess);
              const newStart = merged[0]?.byteStart ?? prev.startOffset;
              return {
                startOffset: newStart,
                endOffset: chunk.nextOffset,
                lines: merged,
                partial: nextPartial,
              };
            }
            return {
              ...prev,
              endOffset: chunk.nextOffset,
              lines: merged,
              partial: nextPartial,
            };
          });
          // 记录本次消费的字节数用于 startOffset 修正
          void consumed;
          setLastUpdated(Date.now());
        }
      } catch {
        // 轮询失败静默，下个周期再试
      } finally {
        busyRef.current = false;
      }
    };
    timer = window.setInterval(() => void tick(), 1200);
    return () => {
      if (timer) window.clearInterval(timer);
    };
  }, []);

  // 让轮询回调能读到最新 buffer（ref 镜像）
  const bufferRef = useRef(buffer);
  useEffect(() => {
    bufferRef.current = buffer;
  }, [buffer]);

  // 跟随模式：追加后滚动到底部
  useEffect(() => {
    if (!followTail) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [buffer.lines.length, followTail]);

  /** 向上翻页：加载更早的分块。 */
  const loadOlder = useCallback(async (): Promise<void> => {
    const path = selectedRef.current;
    if (!path || busyRef.current || loadingOlder) return;
    const cur = bufferRef.current;
    if (cur.startOffset <= 0) return;
    busyRef.current = true;
    setLoadingOlder(true);
    try {
      const readStart = Math.max(0, cur.startOffset - CHUNK_BYTES);
      const chunk = await client.help.readLogChunk.query({
        path,
        offset: readStart,
        bytes: cur.startOffset - readStart,
      });
      const { lines, consumed } = chunkToLines(
        chunk.text,
        readStart,
        '',
        readStart === 0,
        false,
        seqRef.current,
      );
      if (lines.length === 0) {
        setBuffer((prev) => ({ ...prev, startOffset: 0 }));
        return;
      }
      const el = scrollRef.current;
      const prevHeight = el?.scrollHeight ?? 0;
      setBuffer((prev) => {
        // 丢弃新分块末尾的残缺行（续接进现有首行）
        const keep = lines.slice();
        const merged = [...keep, ...prev.lines];
        return {
          ...prev,
          startOffset: readStart + consumed,
          lines: merged,
        };
      });
      requestAnimationFrame(() => {
        const node = scrollRef.current;
        if (node) node.scrollTop = node.scrollHeight - prevHeight;
      });
      setLastUpdated(Date.now());
    } catch (e) {
      pushToast({
        tone: 'error',
        title: '加载历史日志失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      busyRef.current = false;
      setLoadingOlder(false);
    }
  }, [loadingOlder, pushToast]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>): void => {
      const el = e.currentTarget;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (atBottom) {
        setFollowTail(true);
      } else {
        setFollowTail(false);
        if (el.scrollTop < 48) void loadOlder();
      }
    },
    [loadOlder],
  );

  const visibleLines = useMemo(() => {
    return buffer.lines.filter((l) => levels[l.level]);
  }, [buffer.lines, levels]);

  const selectedFile = files.find((f) => f.path === selectedPath);

  const toggleLevel = (lv: LogLevel): void => {
    setLevels((prev) => ({ ...prev, [lv]: !prev[lv] }));
  };

  const allOff = LEVEL_ORDER.every((lv) => !levels[lv]);

  /**
   * 切换 nt_helper 底层调试模式。
   *
   * 开启前先弹确认：调试模式会把收发包的完整原始字节写进日志，体积会迅速膨胀，
   * 只能临时用。关闭不需要确认。
   */
  const toggleDebug = useCallback(async (): Promise<void> => {
    if (debugBusy) return;
    if (!debugOn) {
      const ok = await dialog.confirm(
        '开启底层调试模式',
        '开启后 nt_helper 会把收发包等原始数据（含 hex）完整写进当天的 nt_helper 日志，日志体积会迅速膨胀，长时间开启可能占满磁盘。仅在排查协议问题时临时开启，用完请立刻关闭。确认开启？',
        { okLabel: '开启调试', tone: 'warning' },
      );
      if (!ok) return;
    }
    setDebugBusy(true);
    try {
      const res = await client.help.setNativeDebugLog.mutate({ enabled: !debugOn });
      if (!res.ok) {
        pushToast({
          tone: 'error',
          title: '切换调试模式失败',
          detail: res.error ?? '未知错误',
        });
        return;
      }
      // 把权威结果写回查询缓存（唯一真相源），重开弹窗 / 重挂载都能读到正确状态。
      utils.help.getNativeDebugLog.setData(undefined, {
        enabled: res.enabled,
        available: debugState.data?.available ?? true,
      });
      pushToast({
        tone: res.enabled ? 'warning' : 'success',
        title: res.enabled ? '底层调试模式已开启' : '底层调试模式已关闭',
        detail: res.enabled
          ? '从现在起收发包数据会写入 nt_helper 日志，请勿长时间开启。'
          : '已恢复正常日志级别。',
      });
    } catch (e) {
      pushToast({
        tone: 'error',
        title: '切换调试模式失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDebugBusy(false);
    }
  }, [debugBusy, debugOn, debugState.data?.available, dialog, pushToast, utils]);

  const openLogDir = (): void => {
    void shellBridge()
      ?.openLogDir()
      .then(() => {
        pushToast({
          tone: 'success',
          title: '已打开日志目录',
          detail: '反馈问题时，可把该目录中的最新日志一并附上。',
        });
      })
      .catch((e) => {
        pushToast({ tone: 'error', title: '打开日志目录失败', detail: String(e) });
      });
  };

  return (
    <div className="weq-help-log">
      {/* 工具条：文件选择 + 打开目录 */}
      <div className="weq-help-log-toolbar">
        <div className="weq-help-log-file">
          <IconPicker
            width="100%"
            maxHeight={220}
            triggerIcon={<FileText size={14} aria-hidden />}
            ariaLabel="选择日志文件"
            placeholder={files.length === 0 ? '（暂无日志文件）' : '选择日志文件'}
            value={selectedPath}
            onChange={setSelectedPath}
            options={(() => {
              const opts: IconPickerOption[] = [];
              for (const kind of ['weq', 'nt_helper', 'native', 'other'] as const) {
                const group = files
                  .filter((f) => f.kind === kind)
                  .sort((a, b) => b.mtime - a.mtime);
                if (group.length === 0) continue;
                const label =
                  kind === 'weq'
                    ? 'WeQ 日志'
                    : kind === 'nt_helper'
                      ? 'nt_helper 日志'
                      : kind === 'native'
                        ? '原生加载日志'
                        : '其它日志';
                for (const f of group) {
                  opts.push({
                    value: f.path,
                    label: f.name,
                    detail: fmtBytes(f.size),
                    group: label,
                    icon: <FileText size={13} aria-hidden />,
                  });
                }
              }
              return opts;
            })()}
          />
        </div>
        <div className="weq-help-log-toolbar-right">
          <span className="weq-help-log-meta" title={selectedFile?.path ?? ''}>
            {selectedFile ? `${fmtBytes(size)} · ${selectedFile.name}` : ''}
            {lastUpdated ? <span className="weq-help-log-live" aria-hidden /> : null}
          </span>
          <button
            type="button"
            className={`weq-set-btn weq-set-btn-sm${debugOn ? ' weq-set-btn-danger' : ' weq-set-btn-soft'}`}
            onClick={() => void toggleDebug()}
            disabled={debugBusy || debugState.data?.available === false}
            title={
              debugOn
                ? '关闭底层调试模式（收发包原始数据不再写入日志）'
                : '开启底层调试：把收发包的完整原始数据写进日志，仅用于排查问题'
            }
          >
            {debugBusy ? (
              <Loader2 size={12} className="weq-help-log-spin" aria-hidden />
            ) : (
              <Bug size={12} aria-hidden />
            )}
            {debugOn ? '调试模式已开启' : '开启调试模式'}
          </button>
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            onClick={openLogDir}
          >
            <FolderOpen size={12} aria-hidden />
            打开目录
          </button>
        </div>
      </div>

      {/* 调试模式警示：开启时显著提醒，避免用户放着不管把磁盘写满 */}
      {debugOn ? (
        <div className="weq-help-log-debug-warn" role="alert">
          <AlertTriangle size={13} aria-hidden />
          <span>
            底层调试模式已开启：nt_helper 正在把收发包的完整原始数据写入日志，
            <strong>日志会快速增长</strong>。排查完成后请点右上角按钮关闭。
          </span>
        </div>
      ) : null}

      {/* 等级筛选 + 跟随开关 */}
      <div className="weq-help-log-tools">
        <div className="weq-help-log-levels" role="group" aria-label="日志等级筛选">
          {LEVEL_ORDER.map((lv) => (
            <button
              key={lv}
              type="button"
              className={`weq-log-lv-chip is-${lv}${levels[lv] ? ' is-on' : ''}`}
              role="checkbox"
              aria-checked={levels[lv]}
              onClick={() => toggleLevel(lv)}
            >
              {lv.toUpperCase()}
            </button>
          ))}
          {allOff ? <span className="weq-help-log-empty-hint">全部关闭，无内容显示</span> : null}
        </div>
        <div className="weq-help-log-tools-right">
          {loading ? <Loader2 size={13} className="weq-help-log-spin" aria-hidden /> : null}
          <button
            type="button"
            className={`weq-set-btn weq-set-btn-soft weq-set-btn-sm${followTail ? ' is-live' : ''}`}
            onClick={() => setFollowTail((v) => !v)}
            title={followTail ? '暂停跟随，可向上滚动查看历史' : '恢复跟随文件尾部'}
          >
            {followTail ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />}
            {followTail ? '实时更新中' : '已暂停'}
          </button>
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            onClick={() => setFollowTail(true)}
            disabled={followTail}
            title="回到文件尾部"
          >
            <ArrowDownToLine size={12} aria-hidden />
            回到最新
          </button>
        </div>
      </div>

      {/* 日志内容 */}
      <div className="weq-help-log-view" ref={scrollRef} onScroll={handleScroll}>
        {loadingOlder ? (
          <div className="weq-help-log-more">
            <Loader2 size={12} className="weq-help-log-spin" aria-hidden />
            加载更早的日志…
          </div>
        ) : buffer.startOffset > 0 ? (
          <div className="weq-help-log-more" onClick={() => void loadOlder()}>
            向上滚动加载更早的日志
          </div>
        ) : null}
        {visibleLines.length === 0 ? (
          <div className="weq-help-log-empty">
            {allOff ? '已关闭全部等级筛选' : '（无日志内容）'}
          </div>
        ) : (
          visibleLines.map((line) => (
            <div key={line.id} className={`weq-log-line is-${line.level}`}>
              {line.ts ? <span className="weq-log-ts">{fmtClock(line.ts)}</span> : null}
              <span className="weq-log-lv">{line.level.toUpperCase()}</span>
              <span className="weq-log-msg">
                {line.message}
                {line.context ? <span className="weq-log-ctx"> · {line.context}</span> : null}
              </span>
            </div>
          ))
        )}
        {!followTail ? (
          <div className="weq-help-log-scrollhint">已离开最新位置，点击「回到最新」继续跟随</div>
        ) : null}
      </div>

      <div className="weq-help-log-foot">
        <RefreshCw size={11} aria-hidden />每 1.2s 自动检查新日志；拖动或滚动即可暂停跟随
      </div>
    </div>
  );
}
