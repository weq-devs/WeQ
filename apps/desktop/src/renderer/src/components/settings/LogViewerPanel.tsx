import * as timeFormat from '@weq/time';
import { TimeLabel } from '../TimeLabel';
/**
 * 设置 → 关于 WeQ → 日志与性能 → 日志查看。
 *
 * 支持 WeQ 分段日志（JSONL 与 gzip 归档）和 nt_helper / 原生加载日志。
 * 打开默认定位到文件尾部；跟随最新时跟随当前分段的尾部
 * 自动追加；向上滚动可回溯旧内容（到达顶部自动加载更早的分块）。
 *
 * 读取按字节偏移分块进行（大文件安全），行解析按日志格式区分：
 *   - weq        JSONL：{ ts, level, message, context }
 *   - nt_helper  `[millis][LEVEL][target] message`
 *   - native     `[iso][scope] message`
 *   - 其它      原样展示
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import { ArrowDownToLine, FileText, Loader2, Pause, Play } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useToast } from '../Toast.shared';
import { useRenderDocument } from '../../lib/renderDocument';
import { IconPicker } from '../ui/iconPicker';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogLine {
  id: number;
  level: LogLevel;
  /** 本地化显示时间（无则 null）。 */
  ts: string | null;
  /** 消息主体（去除时间/级别前缀）。 */
  message: string;
  scope?: string;
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
const LOG_SOURCES = [
  { value: 'weq', label: 'WeQ 应用' },
  { value: 'nt_helper', label: 'nt_helper' },
  { value: 'native', label: '原生加载器' },
  { value: 'other', label: '其他来源' },
] as const;
const NO_FILES: [] = [];

function logRangeLabel(file: { name: string; start: number | null; end: number | null }): string {
  const { start, end } = file;
  if (start === null && end === null) return file.name;
  const first = start === null ? '起始时间未知' : timeFormat.formatDateTime(start);
  if (end === null) return `${first} – 结束时间未知`;
  const last =
    start !== null && timeFormat.formatDate(start) === timeFormat.formatDate(end)
      ? timeFormat.formatClock(end)
      : timeFormat.formatDateTime(end);
  return `${first} – ${last}`;
}

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
  return ts ? timeFormat.formatClock(ts, /:\d{2}\.\d+/.test(ts) ? 'millisecond' : 'second') : '';
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
        const { scope, ...ctx } = obj.context ?? {};
        if (scope !== undefined && typeof scope !== 'string') ctx.scope = scope;
        const ctxText =
          Object.keys(ctx).length > 0
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
          scope: typeof scope === 'string' ? scope : undefined,
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
    return { level: normalizeLevel(nt[2]), ts, message: nt[4] ?? '', scope: target || undefined };
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
      scope: scope || undefined,
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
  const { enabled: active } = useQQReadActivity(true, { onlineOnly: false });
  const ownerDocument = useRenderDocument();
  const owner = ownerDocument.defaultView ?? window;
  const activity = useRef(active);
  activity.current = active;
  const generation = useRef(0);
  const loadedPath = useRef('');
  const followCurrentFile = useRef(true);
  const scrollFrame = useRef<number | null>(null);
  const pushToast = useToast((s) => s.push);
  const list = trpc.help.listLogFiles.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: active ? 4000 : false,
  });
  const files = list.data?.files ?? NO_FILES;
  const activePath = list.data?.activePath;

  const [selectedPath, setSelectedPath] = useState<string>('');
  const [scope, setScope] = useState('');
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
  const selectedFile = files.find((file) => file.path === selectedPath);
  const liveFile = files.find((file) => file.path === activePath);
  const archived = selectedFile?.archived ?? false;
  const source = selectedFile?.kind;
  const sources = useMemo(
    () => LOG_SOURCES.filter(({ value }) => files.some((file) => file.kind === value)),
    [files],
  );
  const fileOptions = useMemo(
    () =>
      files
        .filter((file) => file.kind === source)
        .map((file) => ({
          value: file.path,
          label: logRangeLabel({ ...file, start: file.start ?? null, end: file.end ?? null }),
          detail: file.path === activePath ? '写入中' : fmtBytes(file.size),
        })),
    [files, source, activePath],
  );
  const selectFile = (path: string) => {
    followCurrentFile.current = path === activePath;
    setSelectedPath(path);
  };

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef({ n: 0 });
  const busyRef = useRef(false);
  const selectedRef = useRef('');
  selectedRef.current = selectedPath;

  useEffect(() => {
    activity.current = active;
    generation.current++;
    busyRef.current = false;
    setLoading(false);
    setLoadingOlder(false);
    return () => {
      activity.current = false;
      generation.current++;
      busyRef.current = false;
      if (scrollFrame.current !== null) owner.cancelAnimationFrame(scrollFrame.current);
    };
  }, [active, selectedPath, owner]);

  // 只在跟随当前 WeQ 分段时自动跨段，保留主动选择的历史文件。
  useEffect(() => {
    if (!active || files.length === 0) return;
    if (!selectedFile) {
      const fallback = liveFile ?? files.find((file) => file.kind === 'weq') ?? files[0];
      if (fallback) setSelectedPath(fallback.path);
    } else if (
      followCurrentFile.current &&
      followTail &&
      liveFile &&
      liveFile.path !== selectedPath
    ) {
      setSelectedPath(liveFile.path);
    }
  }, [active, files, followTail, liveFile, selectedFile, selectedPath]);

  /** 载入文件尾部（初始 / 切换文件）。 */
  const loadTail = useCallback(
    async (path: string, resetFollow = true): Promise<void> => {
      if (!activity.current || selectedRef.current !== path || busyRef.current) return;
      const request = ++generation.current;
      const current = () =>
        activity.current && selectedRef.current === path && generation.current === request;
      busyRef.current = true;
      setLoading(true);
      if (loadedPath.current !== path) {
        loadedPath.current = '';
        setBuffer({ startOffset: 0, endOffset: 0, lines: [], partial: '' });
      }
      try {
        const info = await client.help.logFileInfo.query({ path });
        if (!current()) return;
        const start = Math.max(0, info.size - TAIL_BYTES);
        const chunk =
          info.size > 0
            ? await client.help.readLogChunk.query({
                path,
                offset: start,
                bytes: info.size - start,
              })
            : { text: '', nextOffset: 0 };
        if (!current()) return;
        const { lines, nextPartial } = chunkToLines(
          chunk.text,
          start,
          '',
          start === 0,
          false,
          seqRef.current,
        );
        loadedPath.current = path;
        // 历史游标取首行的真实字节位置，不能用分块末尾的位置。
        setBuffer({
          startOffset: lines[0]?.byteStart ?? start,
          endOffset: chunk.nextOffset,
          lines,
          partial: nextPartial,
        });
        if (resetFollow) setFollowTail(true);
      } catch (e) {
        if (!current()) return;
        pushToast({
          tone: 'error',
          title: '读取日志失败',
          detail: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (generation.current === request) {
          busyRef.current = false;
          setLoading(false);
        }
      }
    },
    [pushToast],
  );

  // 切换文件
  useEffect(() => {
    if (!active || !selectedPath || loadedPath.current === selectedPath) return;
    seqRef.current.n = 0;
    void loadTail(selectedPath);
  }, [active, selectedPath, loadTail, owner]);

  /** 轮询追加尾部（跟随模式）。 */
  useEffect(() => {
    if (!active || !selectedPath || archived) return;
    let timer: number | undefined;
    const tick = async (): Promise<void> => {
      const path = selectedRef.current;
      if (!activity.current || !path || loadedPath.current !== path || busyRef.current) return;
      const request = ++generation.current;
      const current = () =>
        activity.current && selectedRef.current === path && generation.current === request;
      busyRef.current = true;
      try {
        const info = await client.help.logFileInfo.query({ path });
        if (!current()) return;
        const cur = bufferRef.current;
        if (info.size < cur.endOffset) {
          busyRef.current = false;
          void loadTail(path, false);
          return;
        }
        if (info.size > cur.endOffset) {
          const chunk = await client.help.readLogChunk.query({
            path,
            offset: cur.endOffset,
            bytes: Math.min(CHUNK_BYTES, info.size - cur.endOffset),
          });
          if (!current()) return;
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
            if (!current()) return prev;
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
        }
      } catch {
        // 轮询失败静默，下个周期再试
      } finally {
        if (generation.current === request) busyRef.current = false;
      }
    };
    void tick();
    timer = owner.setInterval(() => void tick(), 1200);
    return () => {
      if (timer) owner.clearInterval(timer);
    };
  }, [active, selectedPath, archived, loadTail, owner]);

  // 让轮询回调能读到最新 buffer（ref 镜像）
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;

  // 跟随模式：追加后滚动到底部
  useEffect(() => {
    if (!active || !followTail) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active, buffer.lines.length, followTail]);

  /** 向上翻页：加载更早的分块。 */
  const loadOlder = useCallback(async (): Promise<void> => {
    const path = selectedRef.current;
    if (!activity.current || !path || busyRef.current || loadingOlder) return;
    const cur = bufferRef.current;
    if (cur.startOffset <= 0) return;
    const request = ++generation.current;
    const current = () =>
      activity.current && selectedRef.current === path && generation.current === request;
    busyRef.current = true;
    setLoadingOlder(true);
    try {
      const readStart = Math.max(0, cur.startOffset - CHUNK_BYTES);
      const chunk = await client.help.readLogChunk.query({
        path,
        offset: readStart,
        bytes: cur.startOffset - readStart,
      });
      if (!current()) return;
      const { lines } = chunkToLines(
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
        if (!current()) return prev;
        // 丢弃新分块末尾的残缺行（续接进现有首行）
        const keep = lines.slice();
        const merged = [...keep, ...prev.lines];
        return {
          ...prev,
          startOffset: lines[0]?.byteStart ?? readStart,
          lines: merged,
        };
      });
      scrollFrame.current = owner.requestAnimationFrame(() => {
        scrollFrame.current = null;
        if (!current()) return;
        const node = scrollRef.current;
        if (node) node.scrollTop = node.scrollHeight - prevHeight;
      });
    } catch (e) {
      if (!current()) return;
      pushToast({
        tone: 'error',
        title: '加载历史日志失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (generation.current === request) {
        busyRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [loadingOlder, pushToast, owner]);

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

  const moduleOptions = useMemo(() => {
    const scopes = new Set<string>();
    if (scope) scopes.add(scope);
    for (const line of buffer.lines) {
      if (line.scope) scopes.add(line.scope);
    }
    return [
      { value: '', label: '全部模块' },
      ...[...scopes].sort().map((value) => ({ value, label: value })),
    ];
  }, [buffer.lines, scope]);
  const visibleLines = useMemo(
    () => buffer.lines.filter((line) => levels[line.level] && (!scope || line.scope === scope)),
    [buffer.lines, levels, scope],
  );

  const levelSelection = useMultiSelection({
    ids: LEVEL_ORDER,
    selected: new Set(LEVEL_ORDER.filter((level) => levels[level])),
    onChange: (next) =>
      setLevels({
        debug: next.has('debug'),
        info: next.has('info'),
        warn: next.has('warn'),
        error: next.has('error'),
      }),
  });

  const allOff = LEVEL_ORDER.every((lv) => !levels[lv]);

  return (
    <div className="weq-help-log">
      <div className="weq-help-log-toolbar">
        <div className="weq-help-log-source">
          <IconPicker
            width="100%"
            ariaLabel="日志来源"
            placeholder="日志来源"
            value={source ?? ''}
            options={sources}
            disabled={sources.length === 0}
            onChange={(kind) => {
              const file =
                (liveFile?.kind === kind ? liveFile : undefined) ??
                files.find((entry) => entry.kind === kind);
              if (!file || file.path === selectedPath) return;
              setScope('');
              selectFile(file.path);
            }}
          />
        </div>
        <div className="weq-help-log-file">
          <IconPicker
            width="100%"
            maxHeight={220}
            triggerIcon={<FileText size={14} aria-hidden />}
            ariaLabel="选择日志文件"
            placeholder={list.isLoading ? '正在读取文件列表…' : '暂无日志文件'}
            disabled={fileOptions.length === 0}
            value={selectedPath}
            onChange={selectFile}
            options={fileOptions}
          />
        </div>
      </div>

      {/* 等级筛选 + 跟随开关 */}
      <div className="weq-help-log-tools">
        <div className="weq-help-log-module">
          <IconPicker
            width="100%"
            ariaLabel="日志模块"
            options={moduleOptions}
            value={scope}
            onChange={setScope}
            disabled={moduleOptions.length === 1}
          />
        </div>
        <div
          className="weq-help-log-levels"
          role="group"
          aria-label="日志等级筛选"
          {...levelSelection.rootProps}
        >
          {LEVEL_ORDER.map((lv) => (
            <button
              key={lv}
              type="button"
              className={`weq-log-lv-chip is-${lv}${levels[lv] ? ' is-on' : ''}`}
              role="checkbox"
              aria-checked={levels[lv]}
              {...levelSelection.itemProps(lv)}
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
            {followTail ? '跟随最新' : '已暂停跟随'}
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
            {loading ? '正在读取日志…' : buffer.lines.length ? '当前筛选无匹配记录' : '无日志内容'}
          </div>
        ) : (
          visibleLines.map((line) => (
            <div key={line.id} className={`weq-log-line is-${line.level}`}>
              {line.ts ? (
                <TimeLabel
                  className="weq-log-ts"
                  value={line.ts}
                  precision={/:\d{2}\.\d+/.test(line.ts) ? 'millisecond' : 'second'}
                >
                  {fmtClock(line.ts)}
                </TimeLabel>
              ) : null}
              <span className="weq-log-lv">{line.level.toUpperCase()}</span>
              <span className="weq-log-msg">
                {line.scope ? <span className="weq-log-scope">{line.scope} · </span> : null}
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
    </div>
  );
}
