/** 通用 API 用量：记录范围、请求状态、趋势与功能／服务商明细。 */
import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Activity, RotateCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDateTime } from '@weq/time';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../../shared/router';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import '../../styles/api-usage.css';

export type UsageStats = inferRouterOutputs<AppRouter>['account']['getAgentLabTokenStats'];
type Period = UsageStats['period'];
type Metric = 'tokens' | 'calls';
const PERIODS: Array<{ value: Period; label: string }> = [
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'retained', label: '全部保留记录' },
];
const FEATURE_LABEL: Record<string, string> = {
  build: '构建克隆',
  chat: '克隆聊天',
  assistant: 'WeQ 助手',
  'intent-analysis': '意图感知',
  'intent-profile': '互动画像',
  'reply-suggestion': '推荐回复',
  'connection-test': '模型连接测试',
  'capability-test': '模型能力检测',
  'assistant-title': '助手会话标题',
  'assistant-summary': '助手摘要',
  'profile-extract': '克隆画像提炼',
  'voice-scenario': '语音场景总结',
  'sticker-description': '表情解读',
  'image-analysis': '图片分析',
  'assistant-image': '助手图片分析',
  'cloneChat-image': '克隆聊天图片分析',
  'cloneTraining-image': '克隆训练图片分析',
  'intent-image': '意图感知图片分析',
  'suggestions-image': '推荐回复图片分析',
  'profile-image': '互动画像图片分析',
  'tts-synthesis': '语音合成',
  'tts-test': '语音测试',
  tts: '语音服务',
  other: '其他 API',
};
const numberFormat = new Intl.NumberFormat('zh-CN');
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return numberFormat.format(n);
}
function knownTokens(row: { calls: number; unknownCalls: number; tokens: number }): string {
  return row.calls > row.unknownCalls ? fmt(row.tokens) : '未知';
}
/** 同一趋势按请求数或已知 token 展示；保留真实绘图区尺寸。 */
export function HourLine({
  data,
  metric = 'tokens',
  daily = false,
}: {
  data: Array<{ hour: string; tokens: number; calls: number; unknownCalls?: number }>;
  metric?: Metric;
  daily?: boolean;
}): ReactElement {
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  useLayoutEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const measure = (): void => setWidth(Math.max(1, plot.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(plot);
    return () => observer.disconnect();
  }, []);
  // 使用真实绘图区尺寸，避免拉伸 SVG 时将圆点变成椭圆。
  const W = width;
  const H = 140;
  const PAD_X = 8;
  const PAD_Y = 8;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d[metric]));
  const ticks = [max, Math.round(max * 0.75), Math.round(max * 0.5), Math.round(max * 0.25), 0];
  const stepX = (W - PAD_X * 2) / Math.max(1, data.length - 1);
  const pts = data.map((d, i) => {
    const x = PAD_X + i * stepX;
    const y = PAD_Y + (1 - d[metric] / max) * (H - PAD_Y * 2);
    return [x, y] as const;
  });
  const line = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const last = pts[pts.length - 1] ?? [PAD_X, H - PAD_Y];
  const area = `${line} L${last[0].toFixed(1)},${H - PAD_Y} L${PAD_X},${H - PAD_Y} Z`;
  const activePoint = activeIndex == null ? null : (pts[activeIndex] ?? null);
  const activeDatum = activeIndex == null ? null : (data[activeIndex] ?? null);
  return (
    <div className="weq-usage-line">
      <div className="weq-usage-line-body">
        <div className="weq-usage-line-yaxis" aria-hidden>
          {ticks.map((tick, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
            <span key={`${tick}-${index}`}>{fmt(tick)}</span>
          ))}
        </div>
        <div className="weq-usage-line-plot" ref={plotRef}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="weq-usage-line-svg"
            role="img"
            aria-label={daily ? '每日用量趋势' : '每小时用量趋势'}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <line
                key={t}
                x1={PAD_X}
                x2={W - PAD_X}
                y1={PAD_Y + (H - PAD_Y * 2) * t}
                y2={PAD_Y + (H - PAD_Y * 2) * t}
                className="weq-usage-grid"
              />
            ))}
            <line
              x1={PAD_X}
              x2={PAD_X}
              y1={PAD_Y}
              y2={H - PAD_Y}
              className="weq-usage-grid weq-usage-grid-axis"
            />
            <path d={area} className="weq-usage-line-area" />
            <path d={line} className="weq-usage-line-stroke" fill="none" />
            {activePoint ? (
              <line
                x1={activePoint[0]}
                x2={activePoint[0]}
                y1={PAD_Y}
                y2={H - PAD_Y}
                className="weq-usage-line-cursor"
              />
            ) : null}
            {pts.map(([x, y], i) => (
              <circle
                key={data[i]!.hour}
                cx={x}
                cy={y}
                r={activeIndex === i ? 4.5 : 3}
                className={`weq-usage-line-dot${activeIndex === i ? ' is-active' : ''}`}
                tabIndex={0}
                role="img"
                aria-label={`${data[i]!.hour} · ${fmt(data[i]!.tokens)} 已知 token · ${data[i]!.calls} 次请求 · 用量未知 ${data[i]!.unknownCalls ?? 0} 次`}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseLeave={() => setActiveIndex((curr) => (curr === i ? null : curr))}
                onFocus={() => setActiveIndex(i)}
                onBlur={() => setActiveIndex(null)}
              >
                <title>{`${data[i]!.hour} · ${fmt(data[i]!.tokens)} 已知 token · ${data[i]!.calls} 次请求`}</title>
              </circle>
            ))}
          </svg>
          {activePoint && activeDatum ? (
            <div
              className="weq-usage-line-tooltip"
              style={{
                left: `clamp(54px, ${(activePoint[0] / W) * 100}%, calc(100% - 54px))`,
                top: activePoint[1],
              }}
            >
              <strong>{activeDatum.hour}</strong>
              <span>{fmt(activeDatum.tokens)} tokens</span>
              <span>{activeDatum.calls} 次请求</span>
              <span>用量未知 {activeDatum.unknownCalls ?? 0} 次</span>
            </div>
          ) : null}
          <div className="weq-usage-line-axis">
            {data.map((d, i) =>
              i % (daily ? Math.max(1, Math.ceil(data.length / (W < 400 ? 4 : 8))) : 3) === 0 ? (
                <span
                  key={d.hour}
                  style={{
                    left: daily
                      ? `clamp(16px, ${(pts[i]![0] / W) * 100}%, calc(100% - 16px))`
                      : `${(pts[i]![0] / W) * 100}%`,
                  }}
                >
                  {daily ? d.hour : d.hour.slice(0, 2)}
                </span>
              ) : null,
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function UsageTable({ title, children }: { title: string; children: ReactNode }): ReactElement {
  const [page, setPage] = useState(0);
  const rows = Array.isArray(children) ? children : [children];
  const pageSize = 50;
  const lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  return (
    <section className="weq-usage-section">
      <h4>{title}</h4>
      <div className="weq-usage-accounting-table" tabIndex={0} role="region" aria-label={title}>
        <table>
          <thead>
            <tr>
              <th scope="col">
                {title === '功能用量'
                  ? '功能'
                  : title === '克隆体明细'
                    ? '克隆体'
                    : '服务商 / 模型'}
              </th>
              <th scope="col">请求</th>
              <th scope="col">已知 token</th>
              <th scope="col">用量未知</th>
            </tr>
          </thead>
          <tbody>{rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize)}</tbody>
        </table>
      </div>
      {rows.length > pageSize ? (
        <nav className="weq-usage-pagination" aria-label={`${title}分页`}>
          <span>
            {currentPage * pageSize + 1}–{Math.min(rows.length, (currentPage + 1) * pageSize)} /{' '}
            {rows.length}
          </span>
          <button
            type="button"
            className="weq-usage-refresh"
            aria-label={`${title}上一页`}
            title="上一页"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="weq-usage-refresh"
            aria-label={`${title}下一页`}
            title="下一页"
            disabled={currentPage === lastPage}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </nav>
      ) : null}
    </section>
  );
}
function UsageCells({
  row,
}: {
  row: { calls: number; unknownCalls: number; tokens: number };
}): ReactElement {
  return (
    <>
      <td>{numberFormat.format(row.calls)}</td>
      <td title={numberFormat.format(row.tokens)}>{knownTokens(row)}</td>
      <td>{numberFormat.format(row.unknownCalls)}</td>
    </>
  );
}
function PersonaUsage({ rows }: { rows: UsageStats['byPersona'] }): ReactElement {
  const refresh = useQQAutoRefresh(true, { onlineOnly: false });
  const personas = trpc.account.listAgentLabPersonas.useQuery(undefined, refresh);
  const names = new Map((personas.data ?? []).map((p) => [p.id, p.name]));
  return (
    <UsageTable title="克隆体明细">
      {rows.map((row) => (
        <tr key={row.personaId}>
          <th scope="row">
            {names.get(row.personaId) ?? '已删除或不可用的克隆'}
            <small>{row.personaId}</small>
          </th>
          <UsageCells row={row} />
        </tr>
      ))}
    </UsageTable>
  );
}

export function UsageReport({ data: d }: { data: UsageStats }): ReactElement {
  const [metric, setMetric] = useState<Metric>('tokens');
  const [personasOpen, setPersonasOpen] = useState(false);
  const clones = d.byPersona.filter(
    (row) => !['__assistant__', '__unassigned__'].includes(row.personaId),
  );
  const firstRecord = d.ledgers.reduce<number | null>(
    (first, ledger) =>
      ledger.firstRecordAt === null
        ? first
        : first === null
          ? ledger.firstRecordAt
          : Math.min(first, ledger.firstRecordAt),
    null,
  );
  const start = d.range.since ?? firstRecord;
  const points =
    d.period === '24h' ? d.byHour : d.byDay.map((day) => ({ ...day, hour: day.day.slice(5) }));
  const success =
    d.totalCalls - d.failedCalls - d.cancelledCalls - d.pendingCalls - d.interruptedCalls;
  return (
    <>
      <div className="weq-usage-scope">
        <p>
          {start === null ? (
            '暂无保留记录'
          ) : (
            <>
              {formatDateTime(start)} 至 {formatDateTime(d.range.until)}（北京时间）
            </>
          )}
        </p>
        <p>
          当前账号 {d.accountCalls} 次 · 应用全局 {d.globalCalls} 次（模型测试与语音服务）
        </p>
      </div>
      <details className="weq-usage-retention">
        <summary>
          每份账本最多保留 {d.ledgers[0]?.limit ?? 5000} 条
          {d.ledgers.some((ledger) => ledger.atCapacity) ? ' · 已达保留上限' : ''}
        </summary>
        {d.ledgers.map((ledger) => (
          <p key={ledger.source}>
            {ledger.source === 'account' ? '当前账号' : '应用全局'}：保留 {ledger.retainedCalls} /{' '}
            {ledger.limit} 条
            {ledger.firstRecordAt !== null ? (
              <>，最早 {formatDateTime(ledger.firstRecordAt)}</>
            ) : null}
            {ledger.atCapacity ? '。已达保留上限，可能已有更早记录被移出。' : '。'}
          </p>
        ))}
        <p>总量仅汇总保留记录；本地推理不计入。未知用量不按零估算，token 不换算费用。</p>
      </details>
      {d.totalCalls === 0 ? (
        <div className="weq-usage-placeholder">
          <Activity size={28} aria-hidden="true" />
          <h4>所选时段暂无 API 请求</h4>
        </div>
      ) : (
        <>
          <dl className="weq-usage-summary">
            <div>
              <dt>已知 token</dt>
              <dd title={numberFormat.format(d.totalTokens)}>
                {d.knownCalls > 0 ? fmt(d.totalTokens) : '未知'}
              </dd>
            </div>
            <div>
              <dt>请求次数</dt>
              <dd>{numberFormat.format(d.totalCalls)}</dd>
            </div>
            <div>
              <dt>用量已返回</dt>
              <dd>
                {d.knownCalls} / {d.totalCalls}
              </dd>
            </div>
            <div>
              <dt>用量未知</dt>
              <dd>{numberFormat.format(d.unknownCalls)}</dd>
            </div>
          </dl>
          <dl className="weq-usage-status" aria-label="请求状态">
            {(
              [
                ['成功', success],
                ['失败', d.failedCalls],
                ['取消', d.cancelledCalls],
                ['进行中', d.pendingCalls],
                ['中断', d.interruptedCalls],
              ] as const
            ).map(([label, count]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{count}</dd>
              </div>
            ))}
          </dl>
          <section className="weq-usage-section">
            <div className="weq-usage-section-heading">
              <h4>{d.period === 'retained' ? '近 30 天趋势' : '用量趋势'}</h4>
              <fieldset className="weq-usage-segments">
                <legend className="sr-only">趋势指标</legend>
                {(
                  [
                    ['tokens', '已知 token'],
                    ['calls', '请求次数'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="usage-metric"
                      value={value}
                      checked={metric === value}
                      onChange={() => setMetric(value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
            </div>
            <HourLine data={points} metric={metric} daily={d.period !== '24h'} />
          </section>
          <UsageTable key={`features-${d.period}`} title="功能用量">
            {d.byFeature.map((row) => (
              <tr key={row.feature}>
                <th scope="row">{FEATURE_LABEL[row.feature] ?? row.feature}</th>
                <UsageCells row={row} />
              </tr>
            ))}
          </UsageTable>
          <UsageTable key={`models-${d.period}`} title="服务商与模型">
            {d.byModel.map((row) => (
              <tr key={row.key}>
                <th scope="row">
                  <span>{row.providerName || (row.providerId ? '未命名配置' : '未知服务商')}</span>
                  <small title={row.providerId ?? '旧记录或未标识请求'}>
                    {row.providerKind === 'tts' ? 'TTS' : 'API'}
                    {row.providerId ? ` · ${row.providerId.slice(-8)}` : ' · 未记录归属'}
                  </small>
                  <span className="weq-usage-model-name">{row.model}</span>
                </th>
                <UsageCells row={row} />
              </tr>
            ))}
          </UsageTable>
          <section className="weq-usage-section">
            <h4>已知输入 / 输出 token</h4>
            <dl className="weq-usage-io">
              <div>
                <dt>输入</dt>
                <dd>{d.totalCalls > d.promptUnknownCalls ? fmt(d.promptTokens) : '未知'}</dd>
                <small>未返回 {d.promptUnknownCalls} 次</small>
              </div>
              <div>
                <dt>输出</dt>
                <dd>
                  {d.totalCalls > d.completionUnknownCalls ? fmt(d.completionTokens) : '未知'}
                </dd>
                <small>未返回 {d.completionUnknownCalls} 次</small>
              </div>
            </dl>
          </section>
          {clones.length > 0 ? (
            <details
              className="weq-usage-personas"
              onToggle={(event) => setPersonasOpen(event.currentTarget.open)}
            >
              <summary>克隆体明细</summary>
              {personasOpen ? <PersonaUsage rows={clones} /> : null}
            </details>
          ) : null}
        </>
      )}
    </>
  );
}

export function UsagePanel(): ReactElement {
  const [period, setPeriod] = useState<Period>('7d');
  const autoRefresh = useQQAutoRefresh(true, { onlineOnly: false });
  const stats = trpc.account.getAgentLabTokenStats.useQuery(
    { period },
    {
      ...autoRefresh,
      refetchInterval: autoRefresh.enabled ? 5000 : false,
      refetchIntervalInBackground: false,
    },
  );
  return (
    <div className="weq-usage weq-api-usage" aria-busy={stats.isFetching}>
      <div className="weq-usage-toolbar">
        <fieldset className="weq-usage-segments">
          <legend className="sr-only">统计范围</legend>
          {PERIODS.map(({ value, label }) => (
            <label key={value}>
              <input
                type="radio"
                name="usage-period"
                value={value}
                checked={period === value}
                onChange={() => setPeriod(value)}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className="weq-usage-refresh"
          aria-label="刷新用量"
          title="刷新用量"
          disabled={stats.isFetching}
          onClick={() => void stats.refetch()}
        >
          <RotateCw size={16} aria-hidden="true" />
        </button>
      </div>
      {stats.isError ? (
        <div className="weq-usage-error" role="alert">
          用量读取失败：{stats.error.message}。请刷新重试。
          {stats.data ? '当前显示上次读取的记录。' : ''}
        </div>
      ) : null}
      {stats.data ? (
        <UsageReport data={stats.data} />
      ) : stats.isLoading ? (
        <p role="status">加载用量统计中…</p>
      ) : null}
    </div>
  );
}
