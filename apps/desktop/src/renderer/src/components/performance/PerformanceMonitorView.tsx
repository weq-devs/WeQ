import { useEffect, useRef, useState } from 'react';
import { formatDateTimeInput, parseDateTimeInput } from '@weq/time';
import type { MonitorMetric, MonitorPoint } from '@weq/service/performance';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  List,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import { useRenderDocument } from '../../lib/renderDocument';
import { Modal } from '../Dialog';
import { Chart, DetailTree, eventLabels, labels, metricLabels, time } from './PerformanceCharts';
import '../../styles/performance-monitor.css';

const dateInput = (at: number) => formatDateTimeInput(at, 'minute');
const fromInput = (value: string) => parseDateTimeInput(value) ?? Number.NaN;

export default function PerformanceMonitorView() {
  const activity = useQQReadActivity(true, { onlineOnly: false });
  const ownerDocument = useRenderDocument();
  const owner = ownerDocument.defaultView ?? window;
  const plots = useRef<HTMLDivElement>(null);
  const toolbarAnchor = useRef<HTMLButtonElement | null>(null);
  const [size, setSize] = useState({ width: 900, height: 560 });
  const [live, setLive] = useState(true);
  const [hours, setHours] = useState(1);
  const [range, setRange] = useState(() => ({ from: Date.now() - 3600_000, to: Date.now() }));
  const [processKey, setProcessKey] = useState('');
  const [processes, setProcesses] = useState<Array<[string, string]>>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<MonitorPoint | null>(null);
  const [inspector, setInspector] = useState<'sample' | 'events' | null>(null);
  const [category, setCategory] = useState('processes');
  const [metrics, setMetrics] = useState<MonitorMetric[]>([
    'cpuPercent',
    'residentBytes',
    'heapBytes',
    'eventLoopP95Ms',
  ]);
  const [menu, setMenu] = useState<'range' | 'metrics' | 'export' | null>(null);
  const [message, setMessage] = useState('');
  const [customFrom, setCustomFrom] = useState(() => dateInput(Date.now() - 3600_000));
  const [customTo, setCustomTo] = useState(() => dateInput(Date.now()));
  const buckets = Math.max(32, Math.min(1200, Math.ceil(size.width / 128) * 64));
  const status = trpc.performanceMonitor.status.useQuery(undefined, {
    enabled: activity.enabled,
    refetchInterval: activity.enabled ? 10_000 : false,
    refetchOnWindowFocus: false,
  });
  const history = trpc.performanceMonitor.history.useQuery(
    { ...range, buckets, process: processKey || undefined },
    { enabled: activity.enabled, keepPreviousData: false, refetchOnWindowFocus: false },
  );
  const detail = trpc.performanceMonitor.detail.useQuery(
    { id: selected ?? 1 },
    {
      enabled: activity.enabled && selected !== null && inspector === 'sample',
      refetchOnWindowFocus: false,
    },
  );
  const exportHistory = trpc.performanceMonitor.export.useMutation();
  useEffect(() => {
    if (!activity.enabled || !plots.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setSize({
          width: Math.max(220, Math.round(entry.contentRect.width)),
          height: Math.round(entry.contentRect.height),
        });
    });
    observer.observe(plots.current);
    return () => observer.disconnect();
  }, [activity.enabled]);
  useEffect(() => {
    if (!history.data) return;
    const discovered = history.data.points.map((point): [string, string] => [
      point.process,
      point.label,
    ]);
    setProcesses((previous) => {
      const merged = [...new Map([...previous, ...discovered]).entries()];
      return merged.length === previous.length &&
        merged.every(
          ([key, label], index) => previous[index]?.[0] === key && previous[index]?.[1] === label,
        )
        ? previous
        : merged;
    });
  }, [history.data]);
  useEffect(() => {
    if (!activity.enabled || !live) return;
    const update = () => {
      const to = Date.now();
      setRange({ from: to - hours * 3600_000, to });
    };
    update();
    const timer = owner.setInterval(update, 10_000);
    return () => owner.clearInterval(timer);
  }, [activity.enabled, live, hours, owner]);
  const changeRange = (from: number, to: number) => {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to < 0) {
      setMessage('请选择有效时间范围');
      return;
    }
    setLive(false);
    setHover(null);
    setCustomFrom(dateInput(Math.max(0, from)));
    setCustomTo(dateInput(to));
    setRange({ from: Math.max(0, from), to });
    setMenu(null);
    setMessage('');
  };
  const move = (delta: number) => changeRange(range.from + delta, range.to + delta);
  const zoom = (factor: number) => {
    const middle = (range.from + range.to) / 2;
    const half = Math.max(30_000, Math.min(365 * 86400_000, (range.to - range.from) * factor)) / 2;
    changeRange(middle - half, middle + half);
  };
  const exportFile = async (format: 'jsonl' | 'csv') => {
    setMenu(null);
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
        const anchor = ownerDocument.createElement('a');
        anchor.href = result.downloadUrl;
        anchor.download = '';
        anchor.click();
      }
      setMessage(result.downloadUrl ? '导出已准备下载' : `已导出：${result.path}`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const pick = (point: MonitorPoint) => {
    setSelected(point.id);
    setHover(point);
    setInspector('sample');
  };
  const points = history.data?.points ?? [];
  const hovered = hover ?? points.find((point) => point.id === selected);
  const openMenu = (value: typeof menu, button: HTMLButtonElement) => {
    toolbarAnchor.current = button;
    setMenu(value);
  };
  return (
    <div className="weq-perf">
      <div className="weq-perf-toolbar" role="toolbar" aria-label="性能分析">
        <select
          aria-label="时间范围"
          value={live ? String(hours) : 'custom'}
          onChange={(event) => {
            if (event.target.value === 'custom') {
              setCustomFrom(dateInput(range.from));
              setCustomTo(dateInput(range.to));
              setMenu('range');
              toolbarAnchor.current = null;
            } else {
              setHours(Number(event.target.value));
              setLive(true);
            }
          }}
        >
          <option value="1">最近一小时</option>
          <option value="24">最近一天</option>
          <option value="168">最近一周</option>
          <option value="custom">自定义时间</option>
        </select>
        <select
          aria-label="进程"
          value={processKey}
          onChange={(event) => {
            setProcessKey(event.target.value);
            setHover(null);
          }}
        >
          <option value="">全部进程</option>
          {processes.map(([key, label]) => (
            <option key={key} value={key}>
              {label} · {key.split(':')[0]}
            </option>
          ))}
        </select>
        <div className="weq-perf-tools">
          <button
            type="button"
            title="上一时间段"
            aria-label="上一时间段"
            onClick={() => move(range.from - range.to)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            title="下一时间段"
            aria-label="下一时间段"
            onClick={() => move(range.to - range.from)}
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            title="放大时间轴"
            aria-label="放大时间轴"
            onClick={() => zoom(0.5)}
          >
            <ZoomIn size={16} />
          </button>
          <button type="button" title="缩小时间轴" aria-label="缩小时间轴" onClick={() => zoom(2)}>
            <ZoomOut size={16} />
          </button>
          <button
            type="button"
            title={live ? '暂停跟随' : '跟随最新'}
            aria-label={live ? '暂停跟随' : '跟随最新'}
            aria-pressed={live}
            onClick={() => setLive(!live)}
          >
            {live ? <Pause size={16} /> : <Play size={16} />}
          </button>
        </div>
        <div className="weq-perf-tools weq-perf-secondary-tools">
          <button
            type="button"
            title="显示指标"
            aria-label="显示指标"
            onClick={(event) => openMenu('metrics', event.currentTarget)}
          >
            <SlidersHorizontal size={16} />
          </button>
          <button
            type="button"
            title="查看事件"
            aria-label="查看事件"
            aria-pressed={inspector === 'events'}
            onClick={() => setInspector(inspector === 'events' ? null : 'events')}
          >
            <List size={16} />
          </button>
          <button
            type="button"
            title="导出性能记录"
            aria-label="导出性能记录"
            disabled={exportHistory.isLoading}
            onClick={(event) => openMenu('export', event.currentTarget)}
          >
            <Download size={16} />
          </button>
        </div>
      </div>
      <div className="weq-perf-context">
        <span>
          {status.data
            ? `${status.data.host === 'desktop' ? '桌面宿主' : 'Web 服务宿主'} · ${labels[status.data.settings.mode]}`
            : '正在连接宿主'}
        </span>
        <span>
          {time(range.from)} 至 {time(range.to)} · 北京时间{!live ? ' · 已暂停跟随' : ''}
        </span>
      </div>
      {(status.error || status.data?.error) && (
        <p role="alert" className="weq-perf-error">
          记录异常：{status.error?.message ?? status.data?.error}
        </p>
      )}
      {history.data?.pointLimitReached && (
        <p role="status" className="weq-perf-notice">
          超过 8000 个图表点，仅显示前段历史；请选择单一进程或缩小时间范围。
        </p>
      )}
      <div className={`weq-perf-workspace${inspector ? ' has-inspector' : ''}`}>
        <div className="weq-perf-timeline">
          <div className="weq-perf-plots" ref={plots}>
            {history.error ? (
              <div role="alert" className="weq-perf-empty">
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
            ) : history.isLoading ? (
              <div role="status" className="weq-perf-empty">
                正在读取历史…
              </div>
            ) : !points.length ? (
              <div className="weq-perf-empty">此时间范围暂无记录</div>
            ) : (
              metrics.map((metric) => (
                <Chart
                  key={metric}
                  metric={metric}
                  width={size.width}
                  height={Math.max(72, Math.floor(size.height / metrics.length) - 27)}
                  points={points}
                  from={range.from}
                  to={range.to}
                  selected={selected}
                  select={pick}
                  move={move}
                  zoom={zoom}
                  hover={hover}
                  onHover={setHover}
                />
              ))
            )}
          </div>
          <div className="weq-perf-event-strip" aria-label="性能事件时间轴">
            <span>
              事件 {history.data?.events.length ?? 0}
              {history.data?.eventLimitReached ? '+' : ''}
            </span>
            <div>
              {history.data?.events.map((event) => (
                <button
                  key={event.id}
                  type="button"
                  style={{
                    left: `${Math.max(0, Math.min(100, ((event.at - range.from) / (range.to - range.from)) * 100))}%`,
                  }}
                  title={`${time(event.at)} · ${eventLabels[event.event] ?? event.event}`}
                  aria-label={`${eventLabels[event.event] ?? event.event} · ${time(event.at)}`}
                  onClick={() => {
                    setInspector('events');
                    owner.requestAnimationFrame(() =>
                      ownerDocument
                        .getElementById(`perf-event-${event.id}`)
                        ?.scrollIntoView({ block: 'nearest' }),
                    );
                  }}
                />
              ))}
            </div>
          </div>
          <div className="weq-perf-readout">
            {hovered
              ? `${hovered.label} · ${time(hovered.start)} 至 ${time(hovered.end)} · ${hovered.count} 次采样`
              : ''}
          </div>
        </div>
        {inspector && (
          <aside
            className="weq-perf-inspector"
            aria-label={inspector === 'sample' ? '采样明细' : '事件明细'}
          >
            <header>
              <h3>{inspector === 'sample' ? '采样明细' : '事件'}</h3>
              <button
                type="button"
                title="关闭明细"
                aria-label="关闭明细"
                onClick={() => setInspector(null)}
              >
                <X size={15} />
              </button>
            </header>
            {inspector === 'events' ? (
              <div className="weq-perf-event-list">
                {history.data?.eventLimitReached && <p>仅显示前 1000 条事件</p>}
                {history.data?.events.length ? (
                  history.data.events.map((event) => (
                    <article id={`perf-event-${event.id}`} key={event.id}>
                      <time>{time(event.at)}</time>
                      <strong>{eventLabels[event.event] ?? event.event}</strong>
                      {event.reason && <p>{event.reason}</p>}
                    </article>
                  ))
                ) : (
                  <p>此范围暂无事件</p>
                )}
              </div>
            ) : (
              <>
                <select
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
                {detail.isLoading ? (
                  <p>正在读取采样…</p>
                ) : detail.error ? (
                  <p role="alert">{detail.error.message}</p>
                ) : !detail.data ? (
                  <p>该采样已过期或被清除</p>
                ) : (
                  <>
                    <p className="weq-perf-caption">
                      {time(detail.data.at)} · 同步 {detail.data.syncMs?.toFixed(1) ?? '—'} ms ·
                      等待 {detail.data.waitMs?.toFixed(1) ?? '—'} ms
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
                                    (
                                      proc.details?.renderer as Record<string, unknown> | undefined
                                    )?.[category])
                              }
                            />
                          </section>
                        ))}
                    </div>
                  </>
                )}
              </>
            )}
          </aside>
        )}
      </div>
      {message && (
        <p role="status" className="weq-perf-message">
          {message}
        </p>
      )}
      {menu && (
        <Modal
          presentation="popover"
          anchor={toolbarAnchor.current}
          width={menu === 'range' ? 380 : 250}
          onClose={() => setMenu(null)}
          className="weq-perf-menu"
        >
          {menu === 'range' ? (
            <form
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
              <button type="submit" className="weq-set-btn">
                查询
              </button>
            </form>
          ) : menu === 'metrics' ? (
            <div role="group" aria-label="显示指标">
              {Object.entries(metricLabels).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={metrics.includes(key as MonitorMetric)}
                    disabled={metrics.length === 1 && metrics.includes(key as MonitorMetric)}
                    onChange={(event) =>
                      setMetrics((current) =>
                        event.target.checked
                          ? [...current, key as MonitorMetric]
                          : current.filter((value) => value !== key),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          ) : (
            <div className="weq-perf-export-options">
              <button
                type="button"
                className="weq-set-btn"
                onClick={() => void exportFile('jsonl')}
              >
                原始记录 JSONL
              </button>
              <button type="button" className="weq-set-btn" onClick={() => void exportFile('csv')}>
                图表统计 CSV
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
