/** 通用 API 用量：记录范围、请求状态、趋势与功能／服务商明细。 */
import { NumericText } from '../../components/NumericText';
import { useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  Activity,
  ArrowLeftRight,
  ChartLine,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Layers,
  Server,
  UsersRound,
} from 'lucide-react';
import { formatDateTime } from '@weq/time';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../../shared/router';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { SegmentedControl } from '../../components/SegmentedControl';
import { QueryError } from '../../components/settings/controls';
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
const PAGE_SIZE = 50;
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
            <span key={`${tick}-${index}`}>
              <span className="weq-number weq-number-inherit">{fmt(tick)}</span>
            </span>
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
              />
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
              <span>
                <span className="weq-number">{fmt(activeDatum.tokens)}</span> tokens
              </span>
              <span>
                <span className="weq-number">{activeDatum.calls}</span> 次请求
              </span>
              <span>
                用量未知 <span className="weq-number">{activeDatum.unknownCalls ?? 0}</span> 次
              </span>
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

function UsageTableHead({ label }: { label: string }): ReactElement {
  return (
    <thead>
      <tr>
        <th scope="col">{label}</th>
        <th scope="col">请求</th>
        <th scope="col">已知 token</th>
        <th scope="col">用量未知</th>
      </tr>
    </thead>
  );
}

function UsagePagination({
  title,
  count,
  page,
  onChange,
}: {
  title: string;
  count: number;
  page: number;
  onChange: (page: number) => void;
}): ReactElement | null {
  if (count <= PAGE_SIZE) return null;
  return (
    <nav className="weq-usage-pagination" aria-label={`${title}分页`}>
      <span>
        <span className="weq-number weq-number-inherit">{page * PAGE_SIZE + 1}</span>–
        <span className="weq-number weq-number-inherit">
          {Math.min(count, (page + 1) * PAGE_SIZE)}
        </span>{' '}
        / <span className="weq-number weq-number-inherit">{count}</span>
      </span>
      <button
        type="button"
        className="weq-usage-refresh"
        aria-label={`${title}上一页`}
        title="上一页"
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
      >
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="weq-usage-refresh"
        aria-label={`${title}下一页`}
        title="下一页"
        disabled={(page + 1) * PAGE_SIZE >= count}
        onClick={() => onChange(page + 1)}
      >
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </nav>
  );
}

function UsageTable({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const [page, setPage] = useState(0);
  const rows = Array.isArray(children) ? children : [children];
  const lastPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  return (
    <section className="weq-usage-section">
      <h4 className="weq-set-card-title">
        {icon ? (
          <span className="weq-set-card-icon" aria-hidden>
            {icon}
          </span>
        ) : null}
        {title}
      </h4>
      <div className="weq-usage-accounting-table" tabIndex={0} role="region" aria-label={title}>
        <table>
          <UsageTableHead label={title === '克隆体明细' ? '克隆体' : '服务商 / 模型'} />
          <tbody>{rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)}</tbody>
        </table>
      </div>
      <UsagePagination title={title} count={rows.length} page={currentPage} onChange={setPage} />
    </section>
  );
}
function UsageCategory({ row }: { row: UsageStats['byCategory'][number] }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const detailsId = useId();
  const currentPage = Math.min(page, Math.max(0, Math.ceil(row.features.length / PAGE_SIZE) - 1));
  return (
    <>
      <tbody className="weq-usage-category">
        <tr>
          <th scope="row">
            <button
              type="button"
              className="weq-usage-category-toggle"
              aria-expanded={expanded}
              aria-controls={detailsId}
              title={`${expanded ? '收起' : '展开'}${row.label}明细`}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <ChevronDown size={16} aria-hidden="true" />
              ) : (
                <ChevronRight size={16} aria-hidden="true" />
              )}
              <span>{row.label}</span>
            </button>
          </th>
          <UsageCells row={row} />
        </tr>
      </tbody>
      <tbody id={detailsId} hidden={!expanded} className="weq-usage-category-details">
        {expanded
          ? row.features
              .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
              .map((child) => (
                <tr key={child.feature}>
                  <th scope="row">{child.label}</th>
                  <UsageCells row={child} />
                </tr>
              ))
          : null}
        {expanded && row.features.length > PAGE_SIZE ? (
          <tr>
            <td colSpan={4}>
              <UsagePagination
                title={`${row.label}明细`}
                count={row.features.length}
                page={currentPage}
                onChange={setPage}
              />
            </td>
          </tr>
        ) : null}
      </tbody>
    </>
  );
}

function FeatureUsage({ rows }: { rows: UsageStats['byCategory'] }): ReactElement {
  return (
    <section className="weq-usage-section">
      <h4 className="weq-set-card-title">
        <span className="weq-set-card-icon" aria-hidden>
          <Layers size={15} strokeWidth={1.8} />
        </span>
        功能用量
      </h4>
      <div className="weq-usage-accounting-table" tabIndex={0} role="region" aria-label="功能用量">
        <table>
          <UsageTableHead label="功能 / 用途" />
          {rows.map((row) => (
            <UsageCategory key={row.category} row={row} />
          ))}
        </table>
      </div>
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
      <td>
        {<span className="weq-number weq-number-inherit">{numberFormat.format(row.calls)}</span>}
      </td>
      <td title={numberFormat.format(row.tokens)}>
        <NumericText>{knownTokens(row)}</NumericText>
      </td>
      <td>
        {
          <span className="weq-number weq-number-inherit">
            {numberFormat.format(row.unknownCalls)}
          </span>
        }
      </td>
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
      <div className="weq-usage-records">
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
            当前账号 <span className="weq-number weq-number-inherit">{d.accountCalls}</span> 次 ·
            应用全局 <span className="weq-number weq-number-inherit">{d.globalCalls}</span>{' '}
            次（模型测试与语音服务）
          </p>
        </div>
        <details className="weq-usage-retention">
          <summary>
            每份账本最多保留{' '}
            <span className="weq-number weq-number-inherit">{d.ledgers[0]?.limit ?? 5000}</span> 条
            {d.ledgers.some((ledger) => ledger.atCapacity) ? ' · 已达保留上限' : ''}
          </summary>
          {d.ledgers.map((ledger) => (
            <p key={ledger.source}>
              {ledger.source === 'account' ? '当前账号' : '应用全局'}：保留{' '}
              <span className="weq-number weq-number-inherit">{ledger.retainedCalls}</span> /{' '}
              <span className="weq-number weq-number-inherit">{ledger.limit}</span> 条
              {ledger.firstRecordAt !== null ? (
                <>，最早 {formatDateTime(ledger.firstRecordAt)}</>
              ) : null}
              {ledger.atCapacity ? '。已达保留上限，可能已有更早记录被移出。' : '。'}
            </p>
          ))}
          <p>总量仅汇总保留记录；本地推理不计入。未知用量不按零估算，token 不换算费用。</p>
        </details>
      </div>
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
                <NumericText>{d.knownCalls > 0 ? fmt(d.totalTokens) : '未知'}</NumericText>
              </dd>
            </div>
            <div>
              <dt>请求次数</dt>
              <dd>
                {
                  <span className="weq-number weq-number-inherit">
                    {numberFormat.format(d.totalCalls)}
                  </span>
                }
              </dd>
            </div>
            <div>
              <dt>用量已返回</dt>
              <dd>
                <span className="weq-number weq-number-inherit">{d.knownCalls}</span> /{' '}
                <span className="weq-number weq-number-inherit">{d.totalCalls}</span>
              </dd>
            </div>
            <div>
              <dt>用量未知</dt>
              <dd>
                {
                  <span className="weq-number weq-number-inherit">
                    {numberFormat.format(d.unknownCalls)}
                  </span>
                }
              </dd>
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
                <dd>
                  <span className="weq-number weq-number-inherit">{count}</span>
                </dd>
              </div>
            ))}
          </dl>
          <section className="weq-usage-section">
            <div className="weq-usage-section-heading">
              <h4 className="weq-set-card-title">
                <span className="weq-set-card-icon" aria-hidden>
                  <ChartLine size={15} strokeWidth={1.8} />
                </span>
                {d.period === 'retained' ? '近 30 天趋势' : '用量趋势'}
              </h4>
              <SegmentedControl
                label="趋势指标"
                value={metric}
                options={[
                  { value: 'tokens', label: '已知 token' },
                  { value: 'calls', label: '请求次数' },
                ]}
                onChange={setMetric}
              />
            </div>
            <HourLine data={points} metric={metric} daily={d.period !== '24h'} />
          </section>
          <FeatureUsage key={`features-${d.period}`} rows={d.byCategory} />
          <UsageTable
            key={`models-${d.period}`}
            title="服务商与模型"
            icon={<Server size={15} strokeWidth={1.8} />}
          >
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
            <h4 className="weq-set-card-title">
              <span className="weq-set-card-icon" aria-hidden>
                <ArrowLeftRight size={15} strokeWidth={1.8} />
              </span>
              已知输入 / 输出 token
            </h4>
            <dl className="weq-usage-io">
              <div>
                <dt>输入</dt>
                <dd>
                  <NumericText>
                    {d.totalCalls > d.promptUnknownCalls ? fmt(d.promptTokens) : '未知'}
                  </NumericText>
                </dd>
                <small>
                  未返回{' '}
                  <span className="weq-number weq-number-inherit">{d.promptUnknownCalls}</span> 次
                </small>
              </div>
              <div>
                <dt>输出</dt>
                <dd>
                  <NumericText>
                    {d.totalCalls > d.completionUnknownCalls ? fmt(d.completionTokens) : '未知'}
                  </NumericText>
                </dd>
                <small>
                  未返回{' '}
                  <span className="weq-number weq-number-inherit">{d.completionUnknownCalls}</span>{' '}
                  次
                </small>
              </div>
            </dl>
          </section>
          {clones.length > 0 ? (
            <details
              className="weq-usage-personas"
              onToggle={(event) => setPersonasOpen(event.currentTarget.open)}
            >
              <summary>
                <span className="weq-set-card-title">
                  <span className="weq-set-card-icon" aria-hidden>
                    <UsersRound size={15} strokeWidth={1.8} />
                  </span>
                  克隆体明细
                </span>
              </summary>
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
        <SegmentedControl label="统计范围" value={period} options={PERIODS} onChange={setPeriod} />
      </div>
      {stats.isError ? (
        <QueryError
          message={`用量读取失败：${stats.error.message}。${stats.data ? '当前显示上次读取的记录。' : ''}`}
          retryLabel="重试读取用量"
          retrying={!autoRefresh.enabled || stats.isFetching}
          onRetry={() => void stats.refetch()}
        />
      ) : null}
      {stats.data ? (
        <UsageReport data={stats.data} />
      ) : stats.isLoading ? (
        <p className="weq-set-note" role="status">
          加载用量统计中…
        </p>
      ) : null}
    </div>
  );
}
