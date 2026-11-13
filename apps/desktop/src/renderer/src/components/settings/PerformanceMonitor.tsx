import { formatDateTimeInput, parseDateTimeInput } from '@weq/time';
import {
  preciseTimeFormatter as eventTimeFormatter,
  dateFormatter,
  clockFormatter,
} from '@weq/time';
import { useEffect, useMemo, useRef, useState } from 'react';
import { area, line, scaleLinear, scaleTime } from 'd3';
import {
  Activity,
  Download,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import type {
  MonitorHistory,
  MonitorMetric,
  MonitorPoint,
  MonitorSettings,
} from '@weq/service/performance';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { SectionHeader } from './controls';
import { useDialog } from '../Dialog';
import { SegmentedControl } from '../SegmentedControl';
import '../../styles/performance-monitor.css';

const labels = { off: '关闭', light: '轻量记录', full: '完整记录' } as const;
const metricLabels: Record<MonitorMetric, string> = {
  cpuPercent: 'CPU · 整机容量',
  residentBytes: '进程驻留内存',
  heapBytes: 'JS 堆',
  externalBytes: 'JS 外部内存',
  eventLoopP95Ms: '事件循环 P95',
};
const time = (at: number) => eventTimeFormatter.format(new Date(at));
const dateInput = (at: number) => formatDateTimeInput(at, 'minute');
const fromInput = (value: string) => parseDateTimeInput(value) ?? Number.NaN;
function valueLabel(value: number | null | undefined, metric: MonitorMetric) {
  if (value === null || value === undefined) return '不可用';
  if (metric === 'cpuPercent') return `${value.toFixed(1)}%`;
  if (metric === 'eventLoopP95Ms') return `${value.toFixed(1)} ms`;
  return `${(value / 1048576).toFixed(1)} MiB`;
}
const eventLabels: Record<string, string> = {
  startup: '宿主启动',
  shutdown: '正常退出',
  'sampling-gap': '采样中断',
  'sample-unavailable': '采样不可用',
  'renderer-exit': '渲染进程退出',
  'renderer-unavailable': '渲染进程不可用',
  'mode-off': '关闭记录',
  'mode-light': '轻量记录',
  'mode-full': '完整记录',
};
const fieldLabels: Record<string, string> = {
  ...metricLabels,
  resources: '资源缓存',
  renderer: '渲染资源',
  privateBytes: '私有内存',
  retainedImages: '受管图片',
  retainedBytes: '受管图片内存',
  pinnedImages: '使用中图片',
  reservedBytes: '预留内存',
  activeDecodes: '正在解码',
  pendingImages: '等待解码',
  totalPendingImages: '在途图片',
  cancelledJobs: '已取消任务',
  managedFonts: '受管字体',
  loadingFonts: '加载中字体',
  images: '图片',
  videos: '视频',
  canvases: '画布',
  sampledImages: '受检图片',
  completeImages: '已加载图片',
  emptyCompleteImages: '空图片',
  naturalPixels: '图片原始像素',
  maxNaturalPixels: '最大图片像素',
  playingVideos: '播放中视频',
  frames: '内嵌页面',
  styles: '样式',
  sheets: '样式表',
  rules: '规则',
  styleElements: '样式节点',
  inaccessibleSheets: '不可读样式表',
  count: '数量',
  sampled: '受检数量',
  omitted: '未受检数量',
  mounted: '已挂载',
  rendered: '有布局区域',
  descendantElements: '后代节点',
  hiddenByAttribute: '隐藏节点',
  states: '状态',
  running: '运行中',
  paused: '已暂停',
  finished: '已完成',
  idle: '空闲',
  byKind: '按动画类型',
  bySurface: '按页面区域',
  hiddenTargets: '隐藏目标',
  detachedTargets: '已脱离目标',
  unknownTargets: '未知目标',
  requests: '服务请求',
  database: '数据库任务',
  active: '进行中',
  completed: '已完成',
  failed: '失败',
  durationMs: '累计耗时（ms）',
  maxMs: '最大耗时（ms）',
  queued: '排队中',
  inFlight: '在途任务',
  oldestWaitMs: '最长等待（ms）',
  peakQueued: '最高排队数',
  returnedRows: '累计返回行',
  caches: 'Chromium 缓存',
  scripts: '脚本',
  cssStyleSheets: 'CSS',
  fonts: '字体',
  other: '其他',
  sizeBytes: '大小',
  liveSizeBytes: '已解码大小',
  processMemory: '原生进程内存',
  heap: 'V8 堆（KiB）',
};
function DetailTree({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <span className="weq-perf-caption">不可用</span>;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  return (
    <dl className="weq-perf-values">
      {Object.entries(value).map(([key, item]) => {
        const label = fieldLabels[key] ?? key;
        if (item && typeof item === 'object')
          return (
            <div key={key} className="weq-perf-value-group">
              <dt>{label}</dt>
              <dd>
                <details>
                  <summary>查看明细</summary>
                  <DetailTree value={item} />
                </details>
              </dd>
            </div>
          );
        const text =
          item === null || item === undefined
            ? '不可用'
            : typeof item === 'boolean'
              ? item
                ? '是'
                : '否'
              : typeof item === 'number'
                ? key in metricLabels
                  ? valueLabel(item, key as MonitorMetric)
                  : key.endsWith('Bytes')
                    ? `${(item / 1048576).toFixed(2)} MiB`
                    : item.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
                : String(item);
        return (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{text}</dd>
          </div>
        );
      })}
    </dl>
  );
}
function Chart({
  metric,
  points,
  from,
  to,
  select,
  selected,
  events,
  move,
  zoom,
  width,
}: {
  metric: MonitorMetric;
  points: MonitorPoint[];
  from: number;
  to: number;
  select(point: MonitorPoint): void;
  selected: number | null;
  events: MonitorHistory['events'];
  move(delta: number): void;
  zoom(factor: number): void;
  width: number;
}) {
  const height = 172,
    left = 64,
    bottom = 25;
  const [hover, setHover] = useState<MonitorPoint | null>(null);
  const drag = useRef<number | null>(null);
  const max = Math.max(
    metric === 'cpuPercent' ? 100 : 1,
    ...points.map((point) => point.metrics[metric].max ?? 0),
  );
  const x = scaleTime()
    .domain([new Date(from), new Date(to)])
    .range([left, width - 12]);
  const y = scaleLinear()
    .domain([0, max * (metric === 'cpuPercent' ? 1 : 1.08)])
    .range([height - bottom, 12]);
  const groups = new Map<string, MonitorPoint[][]>();
  for (const point of points) {
    const key = `${point.process}/${point.segment}`;
    let runs = groups.get(key);
    if (!runs) {
      runs = [[]];
      groups.set(key, runs);
    }
    const run = runs.at(-1)!;
    if (run.length && point.firstAt - run.at(-1)!.lastAt > point.intervalMs * 2.5) runs.push([]);
    runs.at(-1)!.push(point);
  }
  const paths = [...groups.values()].flat();
  const processColors = new Map(
    [...new Set(points.map((point) => point.process))].map((key, index) => [key, index % 4]),
  );
  const nearest = (clientX: number, element: SVGSVGElement) => {
    const bounds = element.getBoundingClientRect();
    const at = Number(x.invert(((clientX - bounds.left) / bounds.width) * width));
    return points.reduce<MonitorPoint | null>(
      (best, point) =>
        !best || Math.abs(point.lastAt - at) < Math.abs(best.lastAt - at) ? point : best,
      null,
    );
  };
  const highlighted = hover ?? points.find((point) => point.id === selected) ?? null;
  return (
    <section className="weq-perf-chart">
      <header>
        <h3>{metricLabels[metric]}</h3>
        <span>
          {highlighted ? valueLabel(highlighted.metrics[metric].mean, metric) : '均值 / 峰值范围'}
        </span>
      </header>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${metricLabels[metric]}历史曲线`}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            setHover(null);
            const samples = [...new Map(points.map((point) => [point.id, point])).values()];
            const index = samples.findIndex((point) => point.id === selected);
            const point =
              samples[
                Math.max(
                  0,
                  Math.min(samples.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)),
                )
              ];
            if (point) select(point);
          }
          if (event.key === '+' || event.key === '=') zoom(0.5);
          if (event.key === '-') zoom(2);
        }}
        onPointerMove={(event) => setHover(nearest(event.clientX, event.currentTarget))}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(event) => {
          drag.current = event.clientX;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => {
          const delta = event.clientX - (drag.current ?? event.clientX);
          drag.current = null;
          if (Math.abs(delta) > 8)
            move((-delta / event.currentTarget.getBoundingClientRect().width) * (to - from));
          else {
            const point = nearest(event.clientX, event.currentTarget);
            if (point) select(point);
          }
        }}
      >
        {y.ticks(3).map((tick) => (
          <g key={tick}>
            <line x1={left} x2={width - 12} y1={y(tick)} y2={y(tick)} className="weq-perf-grid" />
            <text x={left - 6} y={y(tick) + 4} textAnchor="end">
              {metric.endsWith('Bytes') ? `${Math.round(tick / 1048576)}M` : tick.toFixed(0)}
            </text>
          </g>
        ))}
        {paths.map((run) => {
          const valid = run.filter((point) => point.metrics[metric].mean !== null);
          return (
            <g
              key={`${run[0]?.process}-${run[0]?.segment}-${run[0]?.firstAt}`}
              className={`weq-perf-series weq-perf-series-${processColors.get(run[0]?.process ?? '') ?? 0}`}
            >
              <path
                className="weq-perf-band"
                d={
                  area<MonitorPoint>()
                    .defined((point) => point.metrics[metric].mean !== null)
                    .x((point) => x(point.lastAt))
                    .y0((point) => y(point.metrics[metric].min ?? 0))
                    .y1((point) => y(point.metrics[metric].max ?? 0))(run) ?? ''
                }
              />
              <path
                className="weq-perf-line"
                d={
                  line<MonitorPoint>()
                    .defined((point) => point.metrics[metric].mean !== null)
                    .x((point) => x(point.lastAt))
                    .y((point) => y(point.metrics[metric].mean ?? 0))(run) ?? ''
                }
              />
              {valid.length === 1 ? (
                <circle cx={x(valid[0]!.lastAt)} cy={y(valid[0]!.metrics[metric].mean!)} r={3} />
              ) : null}
              {valid.length === 1 ? (
                <line
                  x1={x(valid[0]!.lastAt)}
                  x2={x(valid[0]!.lastAt)}
                  y1={y(valid[0]!.metrics[metric].min!)}
                  y2={y(valid[0]!.metrics[metric].max!)}
                  className="weq-perf-line"
                />
              ) : null}
            </g>
          );
        })}
        {events.map((event) => (
          <line
            key={event.id}
            x1={x(event.at)}
            x2={x(event.at)}
            y1={12}
            y2={height - bottom}
            className="weq-perf-event"
          >
            <title>
              {time(event.at)} · {eventLabels[event.event] ?? event.event}
            </title>
          </line>
        ))}
        {highlighted ? (
          <line
            x1={x(highlighted.lastAt)}
            x2={x(highlighted.lastAt)}
            y1={8}
            y2={height - bottom}
            className="weq-perf-cursor"
          />
        ) : null}
        {x.ticks(width < 400 ? 3 : 4).map((tick) => (
          <text key={+tick} x={x(tick)} y={height - 5} textAnchor="middle">
            {to - from > 86400_000
              ? dateFormatter.format(tick).slice(5)
              : clockFormatter.format(tick).slice(0, 5)}
          </text>
        ))}
      </svg>
      <div className="weq-perf-caption">
        {highlighted
          ? `${highlighted.label} · ${time(highlighted.start)} 至 ${time(highlighted.end)} · ${highlighted.count} 次 · 最低 ${valueLabel(highlighted.metrics[metric].min, metric)} / 最高 ${valueLabel(highlighted.metrics[metric].max, metric)}`
          : points.some((point) => point.metrics[metric].mean !== null)
            ? '\u00a0'
            : '此范围没有可用指标'}
      </div>
    </section>
  );
}

export default function PerformanceMonitor() {
  const active = useTabActive();
  const dialog = useDialog();
  const container = useRef<HTMLDivElement>(null);
  const [buckets, setBuckets] = useState(400);
  const [chartWidth, setChartWidth] = useState(720);
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const [live, setLive] = useState(true),
    [hours, setHours] = useState(1);
  const [range, setRange] = useState(() => ({ from: Date.now() - 3600_000, to: Date.now() }));
  const [processKey, setProcessKey] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [category, setCategory] = useState('processes');
  const [draft, setDraft] = useState<MonitorSettings | null>(null);
  const [duration, setDuration] = useState('60');
  const [durationDirty, setDurationDirty] = useState(false);
  const [message, setMessage] = useState('');
  const [customFrom, setCustomFrom] = useState(() => dateInput(Date.now() - 3600_000));
  const [customTo, setCustomTo] = useState(() => dateInput(Date.now()));
  const utils = trpc.useUtils();
  const enabled = active && visible;
  useEffect(() => {
    if (!active || !container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setChartWidth(Math.max(240, Math.round(entry.contentRect.width)));
        setBuckets(Math.max(32, Math.min(1200, Math.ceil(entry.contentRect.width / 128) * 64)));
      }
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    if (!enabled || !live) return;
    const update = () => {
      const to = Date.now();
      setRange({ from: to - hours * 3600_000, to });
    };
    update();
    const timer = setInterval(update, 10_000);
    return () => clearInterval(timer);
  }, [enabled, live, hours]);
  const status = trpc.performanceMonitor.status.useQuery(undefined, {
    enabled,
    refetchInterval: enabled && live ? 10_000 : false,
    refetchOnWindowFocus: false,
  });
  const history = trpc.performanceMonitor.history.useQuery(
    { ...range, buckets, process: processKey || undefined },
    { enabled, keepPreviousData: false, refetchOnWindowFocus: false },
  );
  const detail = trpc.performanceMonitor.detail.useQuery(
    { id: selected ?? 1 },
    { enabled: enabled && selected !== null, refetchOnWindowFocus: false },
  );
  const configure = trpc.performanceMonitor.configure.useMutation();
  const clear = trpc.performanceMonitor.clear.useMutation();
  const exportHistory = trpc.performanceMonitor.export.useMutation();
  const settings = draft ?? status.data?.settings;
  const processes = useMemo(
    () => [
      ...new Map(
        (history.data?.points ?? []).map((point) => [point.process, point.label]),
      ).entries(),
    ],
    [history.data],
  );
  const changeRange = (from: number, to: number) => {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      setMessage('请选择有效时间范围');
      return;
    }
    setLive(false);
    setCustomFrom(dateInput(Math.max(0, from)));
    setCustomTo(dateInput(to));
    setRange({ from: Math.max(0, from), to });
  };
  const freeze = () => {
    setCustomFrom(dateInput(range.from));
    setCustomTo(dateInput(range.to));
    setLive(false);
  };
  const move = (delta: number) => changeRange(range.from + delta, range.to + delta);
  const zoom = (factor: number) => {
    const middle = (range.from + range.to) / 2,
      half = Math.max(30_000, Math.min(365 * 86400_000, (range.to - range.from) * factor)) / 2;
    changeRange(middle - half, middle + half);
  };
  const apply = async (mode = settings?.mode) => {
    if (!settings || !mode) return;
    const current = status.data?.settings;
    const smaller =
      current &&
      (settings.retentionDays < current.retentionDays ||
        settings.capacityMiB < current.capacityMiB);
    if (smaller) {
      const ok = await dialog.confirm(
        '应用更小的保存策略？',
        `保存后会删除超出 ${settings.retentionDays} 天或 ${settings.capacityMiB} MiB 的最旧历史。当前最早记录：${status.data?.oldest ? time(status.data.oldest) : '无'}。`,
        { okLabel: '应用并删除', cancelLabel: '取消', tone: 'warning' },
      );
      if (!ok) return;
    }
    try {
      await configure.mutateAsync({
        mode,
        retentionDays: settings.retentionDays,
        capacityMiB: settings.capacityMiB,
        fullDurationMinutes:
          mode === 'full' && (current?.mode !== 'full' || durationDirty)
            ? duration === 'continuous'
              ? null
              : (Number(duration) as 15 | 60 | 240)
            : undefined,
        confirmPrune: !!smaller,
      });
      setDraft(null);
      setDurationDirty(false);
      setMessage('设置已保存');
      await utils.performanceMonitor.invalidate();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const exportFile = async (format: 'jsonl' | 'csv') => {
    setMessage('正在导出…');
    try {
      const result = await exportHistory.mutateAsync({
        range: { ...range, buckets, process: processKey || undefined },
        format,
      });
      if (!result) {
        setMessage('已取消导出');
        return;
      }
      if (result.downloadUrl) {
        const anchor = document.createElement('a');
        anchor.href = result.downloadUrl;
        anchor.download = '';
        anchor.click();
      }
      setMessage(result.downloadUrl ? '导出已准备下载' : `已导出：${result.path}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const pick = (point: MonitorPoint) => setSelected(point.id);
  const busy = configure.isLoading || clear.isLoading;
  return (
    <div ref={container} className="weq-perf weq-set" data-setting-id="performance-monitor">
      <SectionHeader title="性能监视" icon={<Activity size={16} />} />
      <div className="weq-perf-status">
        <strong>
          {status.data?.host === 'desktop'
            ? '桌面宿主'
            : status.data?.host === 'web'
              ? 'Web 服务宿主'
              : '正在连接宿主'}
        </strong>
        <span>
          {status.data
            ? `${labels[status.data.settings.mode]} · ${status.data.settings.fullUntil ? `剩余约 ${Math.max(0, Math.ceil((status.data.settings.fullUntil - Date.now()) / 60_000))} 分钟 · 至 ${time(status.data.settings.fullUntil)}` : status.data.settings.mode === 'full' ? '持续记录' : status.data.lastSampleAt ? `最近采样 ${time(status.data.lastSampleAt)}` : '尚无采样'}`
            : ''}
        </span>
      </div>
      {processes.length > 1 ? (
        <div className="weq-perf-legend">
          {processes.map(([key, label], index) => (
            <button
              type="button"
              className={`weq-perf-series-${index % 4}`}
              key={key}
              onClick={() => setProcessKey(key)}
            >
              <span aria-hidden />
              {label} · {key.split(':')[0]}
            </button>
          ))}
        </div>
      ) : null}
      <div className="weq-perf-toolbar">
        <SegmentedControl<'off' | 'light' | 'full'>
          label="记录档位"
          value={status.data?.settings.mode ?? null}
          disabled={busy || !settings}
          onChange={(mode) => void apply(mode)}
          options={[
            { value: 'off', label: labels.off },
            { value: 'light', label: labels.light },
            { value: 'full', label: labels.full },
          ]}
        />
        <label>
          完整档时长
          <SegmentedControl<string>
            label="完整档时长"
            value={duration}
            onChange={(value) => {
              setDuration(value);
              setDurationDirty(true);
              if (settings?.mode === 'full') setDraft({ ...settings, mode: 'full' });
            }}
            options={[
              { value: '15', label: '15 分钟' },
              { value: '60', label: '一小时' },
              { value: '240', label: '四小时' },
              { value: 'continuous', label: '持续' },
            ]}
          />
        </label>
        {durationDirty && settings?.mode === 'full' ? (
          <button type="button" disabled={busy} onClick={() => void apply()}>
            应用
          </button>
        ) : null}
      </div>
      {status.error || status.data?.error ? (
        <p role="alert" className="weq-perf-error">
          记录异常：{status.error?.message ?? status.data?.error}
        </p>
      ) : null}
      <div className="weq-perf-toolbar">
        <SegmentedControl<string>
          label="时间范围"
          value={live ? String(hours) : 'custom'}
          onChange={(value) => {
            if (value === 'custom') {
              freeze();
              return;
            }
            setHours(Number(value));
            setLive(true);
          }}
          options={[
            { value: '1', label: '最近一小时' },
            { value: '24', label: '最近一天' },
            { value: '168', label: '最近一周' },
            { value: 'custom', label: '自定义' },
          ]}
        />
        <label>
          进程
          <select
            className="weq-set-input"
            aria-label="进程"
            value={processKey}
            onChange={(event) => setProcessKey(event.target.value)}
          >
            <option value="">全部进程</option>
            {processes.map(([key, label]) => (
              <option key={key} value={key}>
                {label} · {key.split(':')[0]}
              </option>
            ))}
            {processKey && !processes.some(([key]) => key === processKey) ? (
              <option value={processKey}>{processKey}</option>
            ) : null}
          </select>
        </label>
        <div className="weq-perf-tools">
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            title="上一时间段"
            aria-label="上一时间段"
            onClick={() => move(range.from - range.to)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            title="下一时间段"
            aria-label="下一时间段"
            onClick={() => move(range.to - range.from)}
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            title="放大时间轴"
            aria-label="放大时间轴"
            onClick={() => zoom(0.5)}
          >
            <ZoomIn size={16} />
          </button>
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            title="缩小时间轴"
            aria-label="缩小时间轴"
            onClick={() => zoom(2)}
          >
            <ZoomOut size={16} />
          </button>
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            title={live ? '暂停跟随' : '跟随最新'}
            aria-label={live ? '暂停跟随' : '跟随最新'}
            onClick={() => (live ? freeze() : setLive(true))}
          >
            {live ? <Pause size={16} /> : <Play size={16} />}
          </button>
        </div>
      </div>
      {!live ? (
        <form
          className="weq-perf-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            changeRange(fromInput(customFrom), fromInput(customTo));
          }}
        >
          <label>
            开始（北京）
            <input
              aria-label="开始时间"
              type="datetime-local"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
            />
          </label>
          <label>
            结束（北京）
            <input
              aria-label="结束时间"
              type="datetime-local"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
            />
          </label>
          <button type="submit">查询</button>
        </form>
      ) : null}
      <p className="weq-perf-caption">
        {time(range.from)} 至 {time(range.to)} · 北京时间
      </p>
      {history.data?.pointLimitReached ? (
        <p role="status">
          此范围超过 8000 个图表点，仅显示前段历史；请选择单一进程或缩小时间范围。
        </p>
      ) : null}
      {history.isLoading ? (
        <p role="status">正在读取历史…</p>
      ) : history.error ? (
        <div role="alert">
          历史读取失败：{history.error.message}
          <button
            type="button"
            title="重试"
            aria-label="重试"
            onClick={() => void history.refetch()}
          >
            <RotateCcw size={16} />
          </button>
        </div>
      ) : !history.data?.points.length ? (
        <p className="weq-perf-empty">此时间范围暂无记录</p>
      ) : (
        <div>
          {(['cpuPercent', 'residentBytes', 'heapBytes', 'eventLoopP95Ms'] as const).map(
            (metric) => (
              <Chart
                key={metric}
                metric={metric}
                width={chartWidth}
                points={history.data.points}
                from={range.from}
                to={range.to}
                events={history.data.events}
                selected={selected}
                select={pick}
                move={move}
                zoom={zoom}
              />
            ),
          )}
        </div>
      )}
      <section className="weq-perf-details">
        <div className="weq-perf-toolbar">
          <h3>采样明细</h3>
          <select
            className="weq-set-input"
            aria-label="明细类别"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            {[
              ['processes', '进程'],
              ['resources', '缓存'],
              ['media', '媒体'],
              ['animationDetails', '动画'],
              ['surfaces', '页面与 DOM'],
              ['styles', '样式'],
              ['requests', '服务请求'],
              ['database', '数据库任务'],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {selected === null ? (
          <p>尚未选择采样</p>
        ) : detail.isLoading ? (
          <p>正在读取采样…</p>
        ) : detail.error ? (
          <p role="alert">{detail.error.message}</p>
        ) : !detail.data ? (
          <p>该采样已过期或被清除</p>
        ) : (
          <>
            <p className="weq-perf-caption">
              {time(detail.data.at)} · 同步 {detail.data.syncMs?.toFixed(1) ?? '—'} ms · 等待{' '}
              {detail.data.waitMs?.toFixed(1) ?? '—'} ms
            </p>
            <div className="weq-perf-detail-list">
              {detail.data.processes
                ?.filter((proc) => !processKey || proc.key === processKey)
                .map((proc) => (
                  <section key={proc.key}>
                    <h4>
                      {proc.label} · {proc.pid}
                    </h4>
                    <DetailTree
                      value={
                        category === 'processes'
                          ? proc.metrics
                          : (proc.details?.[category] ??
                            (proc.details?.renderer as Record<string, unknown> | undefined)?.[
                              category
                            ])
                      }
                    />
                  </section>
                ))}
            </div>
          </>
        )}
      </section>
      {history.data?.events.length ? (
        <details className="weq-perf-events">
          <summary>
            事件 · {history.data.events.length}
            {history.data.eventLimitReached ? '（仅显示前 1000 条）' : ''}
          </summary>
          <ul>
            {history.data.events.map((event) => (
              <li key={event.id}>
                {time(event.at)} · {eventLabels[event.event] ?? event.event}
                {event.reason ? ` · ${event.reason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <section className="weq-perf-retention">
        <h3>历史保存</h3>
        <div className="weq-perf-toolbar">
          <label>
            保存时长
            <SegmentedControl<string>
              label="保存时长"
              value={
                settings && [1, 3, 7, 14, 30].includes(settings.retentionDays)
                  ? String(settings.retentionDays)
                  : 'custom'
              }
              onChange={(value) =>
                settings &&
                setDraft({
                  ...settings,
                  retentionDays: value === 'custom' ? 8 : Number(value),
                })
              }
              options={[
                ...[1, 3, 7, 14, 30].map((days) => ({
                  value: String(days),
                  label: `${days} 天`,
                })),
                { value: 'custom', label: '自定义' },
              ]}
            />
          </label>
          {settings && ![1, 3, 7, 14, 30].includes(settings.retentionDays) ? (
            <label>
              天数
              <input
                type="number"
                aria-label="保存天数"
                min={1}
                max={365}
                value={settings.retentionDays}
                onChange={(event) =>
                  setDraft({ ...settings, retentionDays: Number(event.target.value) })
                }
              />
            </label>
          ) : null}
          <label>
            容量上限
            <SegmentedControl<string>
              label="容量上限"
              value={String(settings?.capacityMiB ?? 128)}
              onChange={(value) =>
                settings &&
                setDraft({
                  ...settings,
                  capacityMiB: Number(value) as MonitorSettings['capacityMiB'],
                })
              }
              options={[64, 128, 256, 512].map((size) => ({
                value: String(size),
                label: `${size} MiB`,
              }))}
            />
          </label>
          <button type="button" disabled={busy || !draft} onClick={() => void apply()}>
            应用
          </button>
        </div>
        <p>
          {status.data
            ? `${(status.data.bytes / 1048576).toFixed(2)} MiB · ${status.data.records} 条 · 最早 ${status.data.oldest ? time(status.data.oldest) : '无记录'}`
            : '正在读取占用…'}
        </p>
        <p className="weq-perf-caption">
          {status.data
            ? `${status.data.collecting ? '正在采样' : status.data.settings.mode === 'off' ? '采样已关闭' : '等待采样'} · ${status.data.error ? '写入暂停' : status.data.writing ? '正在写入' : '写入正常'} · 队列 ${status.data.queued} · 丢弃 ${status.data.dropped} · 延期 ${status.data.deferred}${status.data.detailBackoffUntil ? ` · 详细采样退避至 ${time(status.data.detailBackoffUntil)}，间隔 ${status.data.detailIntervalMs / 1000} 秒` : ''}`
            : ''}
        </p>
        <div className="weq-perf-toolbar">
          <button
            type="button"
            disabled={exportHistory.isLoading}
            onClick={() => void exportFile('jsonl')}
          >
            <Download size={15} />
            JSONL
          </button>
          <button
            type="button"
            disabled={exportHistory.isLoading}
            onClick={() => void exportFile('csv')}
          >
            <Download size={15} />
            CSV
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              const ok = await dialog.confirm(
                '清空性能历史？',
                '会删除此宿主的全部性能采样记录，此操作不可撤销。',
                { okLabel: '清空历史', cancelLabel: '取消', tone: 'error' },
              );
              if (!ok) return;
              try {
                await clear.mutateAsync(true);
                setSelected(null);
                await utils.performanceMonitor.invalidate();
                setMessage('历史已清空');
              } catch (error) {
                setMessage(String(error));
              }
            }}
          >
            <Trash2 size={15} />
            清空历史
          </button>
        </div>
      </section>
      <p role="status" className="weq-perf-message">
        {message}
      </p>
    </div>
  );
}
