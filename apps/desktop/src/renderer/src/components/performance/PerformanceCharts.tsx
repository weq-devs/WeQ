import {
  preciseTimeFormatter as eventTimeFormatter,
  dateFormatter,
  clockFormatter,
} from '@weq/time';
import { useId, useMemo, useRef, useState } from 'react';
import { area, curveMonotoneX, line, scaleLinear, scaleTime } from 'd3';
import type { MonitorMetric, MonitorPoint } from '@weq/service/performance';
export const labels = { off: '关闭', light: '轻量记录', full: '完整记录' } as const;
export const metricLabels: Record<MonitorMetric, string> = {
  cpuPercent: 'CPU · 整机容量',
  residentBytes: '进程驻留内存',
  heapBytes: 'JS 堆',
  externalBytes: 'JS 外部内存',
  eventLoopP95Ms: '事件循环 P95',
};
export const time = (at: number) => eventTimeFormatter.format(new Date(at));
export function valueLabel(value: number | null | undefined, metric: MonitorMetric) {
  if (value === null || value === undefined) return '不可用';
  if (metric === 'cpuPercent') return `${value.toFixed(1)}%`;
  if (metric === 'eventLoopP95Ms') return `${value.toFixed(1)} ms`;
  const [divisor, unit] =
    Math.abs(value) >= 1073741824
      ? [1073741824, 'GiB']
      : Math.abs(value) >= 1048576
        ? [1048576, 'MiB']
        : Math.abs(value) >= 1024
          ? [1024, 'KiB']
          : [1, 'B'];
  return `${(value / divisor).toFixed(divisor === 1 ? 0 : 1)} ${unit}`;
}
export const eventLabels: Record<string, string> = {
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
export function DetailTree({ value }: { value: unknown }) {
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
export function Chart({
  metric,
  points,
  from,
  to,
  select,
  selected,
  hover,
  onHover,
  height,
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
  hover: MonitorPoint | null;
  onHover(point: MonitorPoint | null): void;
  height: number;
  move(delta: number): void;
  zoom(factor: number): void;
  width: number;
}) {
  const left = 76,
    bottom = 25;
  const clip = useId();
  const [inspecting, setInspecting] = useState(false);
  const drag = useRef<number | null>(null);
  const { x, y, paths } = useMemo(() => {
    const max = Math.max(1, ...points.map((point) => point.metrics[metric].max ?? 0));
    const x = scaleTime()
      .domain([new Date(from), new Date(to)])
      .range([left, width - 12]);
    const y = scaleLinear()
      .domain([0, max * 1.12])
      .nice(3)
      .range([height - bottom, 10]);
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
    return { x, y, paths };
  }, [metric, points, from, to, width, height]);
  const series = useMemo(
    () =>
      paths.map((run) => {
        const valid = run.filter((point) => point.metrics[metric].mean !== null);
        return (
          <g
            key={`${run[0]?.process}-${run[0]?.segment}-${run[0]?.firstAt}`}
            className="weq-perf-series"
          >
            <path
              className="weq-perf-area"
              d={
                area<MonitorPoint>()
                  .curve(curveMonotoneX)
                  .defined((point) => point.metrics[metric].mean !== null)
                  .x((point) => x(point.lastAt))
                  .y0(height - bottom)
                  .y1((point) => y(point.metrics[metric].mean ?? 0))(run) ?? ''
              }
            />
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
                  .curve(curveMonotoneX)
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
      }),
    [paths, metric, x, y, height],
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
  const current = highlighted ?? points.at(-1);
  const currentValue = current?.metrics[metric];
  const peak = useMemo(() => {
    const values = points.flatMap((point) => point.metrics[metric].max ?? []);
    return values.length ? Math.max(...values) : null;
  }, [points, metric]);
  return (
    <section className="weq-perf-chart" data-metric={metric}>
      <header>
        <h3 title={metric === 'eventLoopP95Ms' ? '同次采样取各进程 P95 最大值' : undefined}>
          {metricLabels[metric]}
        </h3>
        <div className="weq-perf-chart-summary">
          <strong>{valueLabel(currentValue?.mean, metric)}</strong>
          <span>
            {highlighted ? '所选均值' : '最新均值'} · 峰值 {valueLabel(peak, metric)}
          </span>
        </div>
      </header>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ height }}
        role="img"
        aria-label={`${metricLabels[metric]}历史曲线，${current?.label ?? ''}，${valueLabel(currentValue?.mean, metric)}`}
        tabIndex={0}
        onFocus={() => setInspecting(true)}
        onBlur={() => setInspecting(false)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            onHover(null);
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
        onPointerMove={(event) => {
          setInspecting(true);
          onHover(nearest(event.clientX, event.currentTarget));
        }}
        onPointerLeave={() => {
          setInspecting(false);
          onHover(null);
        }}
        onPointerDown={(event) => {
          drag.current = event.clientX;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
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
        <defs>
          <clipPath id={clip}>
            <rect
              x={left}
              y={0}
              width={Math.max(0, width - left - 12)}
              height={height - bottom + 2}
            />
          </clipPath>
        </defs>
        {y.ticks(3).map((tick) => (
          <g key={tick}>
            <line x1={left} x2={width - 12} y1={y(tick)} y2={y(tick)} className="weq-perf-grid" />
            <text x={left - 6} y={y(tick) + 4} textAnchor="end">
              {valueLabel(tick, metric)}
            </text>
          </g>
        ))}
        <g clipPath={`url(#${clip})`}>{series}</g>
        {highlighted ? (
          <g clipPath={`url(#${clip})`}>
            <line
              x1={x(highlighted.lastAt)}
              x2={x(highlighted.lastAt)}
              y1={8}
              y2={height - bottom}
              className="weq-perf-cursor"
            />
            {highlighted.metrics[metric].mean !== null && (
              <circle
                cx={x(highlighted.lastAt)}
                cy={y(highlighted.metrics[metric].mean!)}
                r={4}
                className="weq-perf-highlight"
              />
            )}
          </g>
        ) : null}
        {x.ticks(Math.max(2, Math.floor((width - left) / 140))).map((tick) => (
          <text key={+tick} x={x(tick)} y={height - 5} textAnchor="middle">
            {to - from > 86400_000
              ? dateFormatter.format(tick).slice(5)
              : clockFormatter.format(tick).slice(0, 5)}
          </text>
        ))}
      </svg>
      {inspecting && highlighted && currentValue?.mean !== null && (
        <div className="weq-perf-chart-tooltip" role="status">
          <time>{time(highlighted.lastAt)}</time>
          <span>{highlighted.label}</span>
          <strong>{valueLabel(currentValue?.mean, metric)}</strong>
          {highlighted.count > 1 && (
            <span className="weq-perf-chart-tooltip-range">
              范围 {valueLabel(currentValue?.min, metric)} 至 {valueLabel(currentValue?.max, metric)}
            </span>
          )}
        </div>
      )}
      {!points.some((point) => point.metrics[metric].mean !== null) && (
        <span className="weq-perf-no-metric">此范围没有可用指标</span>
      )}
    </section>
  );
}
