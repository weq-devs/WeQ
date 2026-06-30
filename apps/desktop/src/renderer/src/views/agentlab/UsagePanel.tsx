/**
 * 主页用量统计：KPI 概览 + 近 24 小时开销折线图 + 输入/输出占比 +
 * 场景圆环图 / 各模型饼图 / 活跃时段雷达图 / 各克隆体条形。
 * 数据来自 account.getAgentLabTokenStats，图表全用纯 SVG / CSS，不引图表库。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { BarChart3, Clock, Coins, Users, Activity } from 'lucide-react';
import { trpc } from '../../trpc/client';

/** WeQ 助手在统计里的占位键（与后端 ASSISTANT_KEY 对齐）。 */
const ASSISTANT_KEY = '__assistant__';

const SCOPE_LABEL: Record<string, string> = {
  build: '构建克隆',
  chat: '与克隆体聊天',
  assistant: 'WeQ 助手',
};

/** 图表配色（与主题强调色协调的固定色板，明暗两套主题都可读）。 */
const PALETTE = ['#0099ff', '#36c5d0', '#53ce90', '#f5a623', '#b56cff', '#ff6b8a', '#7c8cff', '#f06292', '#9ccc65', '#ffb74d'];

interface Slice {
  key: string;
  label: string;
  value: number;
  color: string;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function withColors(rows: Array<{ key: string; label: string; value: number }>): Slice[] {
  return rows.map((r, i) => ({ ...r, color: PALETTE[i % PALETTE.length]! }));
}

/** 极坐标 → 直角坐标（角度自正上方顺时针，单位度）。 */
function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function Kpi({ icon, value, label }: { icon: ReactElement; value: string; label: string }): ReactElement {
  return (
    <div className="weq-usage-kpi">
      <span className="weq-usage-kpi-ico">{icon}</span>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function BarList({ rows }: { rows: Array<{ key: string; label: string; value: number }> }): ReactElement {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <div className="weq-usage-empty">暂无数据</div>;
  return (
    <div className="weq-usage-bars">
      {rows.map((r) => (
        <div key={r.key} className="weq-usage-bar-row">
          <div className="weq-usage-bar-head">
            <span className="weq-usage-bar-label" title={r.label}>{r.label}</span>
            <span className="weq-usage-bar-val">{fmt(r.value)}</span>
          </div>
          <span className="weq-usage-bar-track">
            <span className="weq-usage-bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** 近 24 小时 token 开销折线图（面积 + 折线 + 网格 + 时刻轴）。 */
function HourLine({ data }: { data: Array<{ hour: string; tokens: number; calls: number }> }): ReactElement {
  const W = 560;
  const H = 140;
  const PAD_X = 8;
  const PAD_Y = 8;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.tokens));
  const ticks = [max, Math.round(max * 0.75), Math.round(max * 0.5), Math.round(max * 0.25), 0];
  const stepX = (W - PAD_X * 2) / Math.max(1, data.length - 1);
  const pts = data.map((d, i) => {
    const x = PAD_X + i * stepX;
    const y = PAD_Y + (1 - d.tokens / max) * (H - PAD_Y * 2);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1] ?? [PAD_X, H - PAD_Y];
  const area = `${line} L${last[0].toFixed(1)},${H - PAD_Y} L${PAD_X},${H - PAD_Y} Z`;
  const activePoint = activeIndex == null ? null : pts[activeIndex] ?? null;
  const activeDatum = activeIndex == null ? null : data[activeIndex] ?? null;
  return (
    <div className="weq-usage-line">
      <div className="weq-usage-line-body">
        <div className="weq-usage-line-yaxis" aria-hidden>
          {ticks.map((tick, index) => (
            <span key={`${tick}-${index}`}>{fmt(tick)}</span>
          ))}
        </div>
        <div className="weq-usage-line-plot">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="weq-usage-line-svg" role="img" aria-label="近24小时token折线">
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
            <line x1={PAD_X} x2={PAD_X} y1={PAD_Y} y2={H - PAD_Y} className="weq-usage-grid weq-usage-grid-axis" />
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
                key={`${data[i]!.hour}-${i}`}
                cx={x}
                cy={y}
                r={activeIndex === i ? 4.5 : 3}
                className={`weq-usage-line-dot${activeIndex === i ? ' is-active' : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseLeave={() => setActiveIndex((curr) => (curr === i ? null : curr))}
              >
                <title>{`${data[i]!.hour} · ${fmt(data[i]!.tokens)} tokens · ${data[i]!.calls} 次调用`}</title>
              </circle>
            ))}
          </svg>
          {activePoint && activeDatum ? (
            <div
              className="weq-usage-line-tooltip"
              style={{
                left: `${(activePoint[0] / W) * 100}%`,
                top: `${(activePoint[1] / H) * 100}%`,
              }}
            >
              <strong>{activeDatum.hour}</strong>
              <span>{fmt(activeDatum.tokens)} tokens</span>
              <span>{activeDatum.calls} 次调用</span>
            </div>
          ) : null}
          <div className="weq-usage-line-axis">
            {data.map((d, i) => (
              <span key={`${d.hour}-${i}`}>{i % 3 === 0 ? d.hour.slice(0, 2) : ''}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 饼图 / 圆环图（donut=true 时挖空中心）。 */
function PieChart({ rows, donut }: { rows: Slice[]; donut?: boolean }): ReactElement {
  const live = rows.filter((r) => r.value > 0);
  const total = Math.max(1, live.reduce((s, r) => s + r.value, 0));
  const cx = 60;
  const cy = 60;
  const r = 54;
  let acc = 0;
  return (
    <svg viewBox="0 0 120 120" className="weq-usage-pie" role="img" aria-label="占比图">
      {live.length === 1 ? (
        <circle cx={cx} cy={cy} r={r} fill={live[0]!.color} />
      ) : (
        live.map((row) => {
          const a0 = (acc / total) * 360;
          acc += row.value;
          const a1 = (acc / total) * 360;
          const p0 = polar(cx, cy, r, a0);
          const p1 = polar(cx, cy, r, a1);
          const large = a1 - a0 > 180 ? 1 : 0;
          const d = `M ${cx} ${cy} L ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} Z`;
          return (
            <path key={row.key} d={d} fill={row.color} className="weq-usage-pie-slice">
              <title>{`${row.label} · ${fmt(row.value)} · ${Math.round((row.value / total) * 100)}%`}</title>
            </path>
          );
        })
      )}
      {donut ? <circle cx={cx} cy={cy} r={30} className="weq-usage-pie-hole" /> : null}
    </svg>
  );
}

/** 雷达图：展示一天各时段（每 4 小时一档）的 token 分布。 */
function RadarChart({ axes }: { axes: Array<{ label: string; value: number }> }): ReactElement {
  const N = axes.length;
  const cx = 60;
  const cy = 60;
  const maxR = 42;
  const max = Math.max(1, ...axes.map((a) => a.value));
  const at = (i: number, rr: number): { x: number; y: number } => polar(cx, cy, rr, (i / N) * 360);
  const ring = (f: number): string => axes.map((_, i) => { const p = at(i, maxR * f); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' ');
  const dataPoly = axes.map((a, i) => { const p = at(i, maxR * (a.value / max)); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' ');
  return (
    <svg viewBox="0 0 120 120" className="weq-usage-radar" role="img" aria-label="活跃时段雷达">
      {[1, 0.66, 0.33].map((f) => (
        <polygon key={f} points={ring(f)} className="weq-usage-radar-grid" />
      ))}
      {axes.map((_, i) => { const p = at(i, maxR); return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} className="weq-usage-radar-grid" />; })}
      <polygon points={dataPoly} className="weq-usage-radar-area">
        <title>{axes.map((a) => `${a.label}: ${fmt(a.value)}`).join(' / ')}</title>
      </polygon>
      {axes.map((a, i) => { const p = at(i, maxR + 10); return (
        <text key={i} x={p.x} y={p.y} className="weq-usage-radar-label" textAnchor="middle" dominantBaseline="middle">{a.label}</text>
      ); })}
    </svg>
  );
}

function Legend({ rows }: { rows: Slice[] }): ReactElement {
  const total = Math.max(1, rows.reduce((s, r) => s + r.value, 0));
  return (
    <ul className="weq-usage-legend">
      {rows.map((r) => (
        <li key={r.key}>
          <i style={{ background: r.color }} />
          <span className="weq-usage-legend-label" title={r.label}>{r.label}</span>
          <span className="weq-usage-legend-val">{fmt(r.value)} · {Math.round((r.value / total) * 100)}%</span>
        </li>
      ))}
    </ul>
  );
}

export function UsagePanel({
  resolveName,
  hasPersona,
  personaCount,
}: {
  resolveName: (personaId: string) => string;
  hasPersona: (personaId: string) => boolean;
  personaCount: number;
}): ReactElement {
  const stats = trpc.account.getAgentLabTokenStats.useQuery();
  const d = stats.data;

  const personaRows = useMemo(
    () =>
      (d?.byPersona ?? [])
        .filter((p) => p.personaId === ASSISTANT_KEY || hasPersona(p.personaId))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 5)
        .map((p) => ({
          key: p.personaId,
          label: p.personaId === ASSISTANT_KEY ? 'WeQ 助手' : resolveName(p.personaId),
          value: p.tokens,
        })),
    [d?.byPersona, hasPersona, resolveName],
  );

  const scopeSlices = useMemo(
    () => withColors((d?.byScope ?? []).map((s) => ({ key: s.scope, label: SCOPE_LABEL[s.scope] ?? s.scope, value: s.tokens }))),
    [d?.byScope],
  );
  const modelSlices = useMemo(
    () => withColors((d?.byModel ?? []).map((m) => ({ key: m.model, label: m.model, value: m.tokens }))),
    [d?.byModel],
  );

  // 一天各时段（每 4 小时一档）token 分布，喂给雷达图。
  const radarAxes = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0, 0];
    for (const h of d?.byHour ?? []) {
      const hh = Number.parseInt(h.hour.slice(0, 2), 10);
      if (!Number.isFinite(hh)) continue;
      const idx = Math.min(5, Math.max(0, Math.floor(hh / 4)));
      buckets[idx] = (buckets[idx] ?? 0) + h.tokens;
    }
    return buckets.map((value, i) => ({ label: String(i * 4), value }));
  }, [d?.byHour]);

  if (stats.isLoading) return <div className="weq-agentlab-placeholder"><p>加载用量统计中…</p></div>;
  if (!d || d.totalCalls === 0) {
    return (
      <div className="weq-agentlab-placeholder">
        <BarChart3 size={36} strokeWidth={1.4} />
        <h3>用量统计</h3>
        <p>构建克隆或与克隆体聊天后，这里会展示 token 消耗、近 24 小时开销、场景 / 模型 / 时段 / 克隆体的多维统计。</p>
      </div>
    );
  }

  const avgPerCall = d.totalCalls > 0 ? Math.round(d.totalTokens / d.totalCalls) : 0;
  const inOut = Math.max(1, d.promptTokens + d.completionTokens);

  return (
    <div className="weq-usage">
      <div className="weq-usage-head">
        <Kpi icon={<Coins size={16} />} value={fmt(d.totalTokens)} label="累计 token" />
        <Kpi icon={<Activity size={16} />} value={String(d.totalCalls)} label="调用次数" />
        <Kpi icon={<Users size={16} />} value={String(personaCount)} label="克隆体" />
        <Kpi icon={<BarChart3 size={16} />} value={fmt(avgPerCall)} label="平均每次 token" />
      </div>

      <section className="weq-usage-section">
        <h4><Clock size={13} /> 近 24 小时开销</h4>
        <HourLine data={d.byHour} />
      </section>

      <section className="weq-usage-section">
        <h4>输入 / 输出 token</h4>
        <div className="weq-usage-split">
          <span className="weq-usage-split-in" style={{ flexGrow: Math.max(0.001, d.promptTokens) }} />
          <span className="weq-usage-split-out" style={{ flexGrow: Math.max(0.001, d.completionTokens) }} />
        </div>
        <div className="weq-usage-split-legend">
          <span><i className="weq-usage-dot is-in" /> 输入 {fmt(d.promptTokens)}（{Math.round((d.promptTokens / inOut) * 100)}%）</span>
          <span><i className="weq-usage-dot is-out" /> 输出 {fmt(d.completionTokens)}（{Math.round((d.completionTokens / inOut) * 100)}%）</span>
        </div>
      </section>

      <div className="weq-usage-cols">
        <section className="weq-usage-section">
          <h4>场景占比</h4>
          <div className="weq-usage-chart">
            <PieChart rows={scopeSlices} donut />
            <Legend rows={scopeSlices} />
          </div>
        </section>
        <section className="weq-usage-section">
          <h4>各模型占比</h4>
          <div className="weq-usage-chart">
            <PieChart rows={modelSlices} />
            <Legend rows={modelSlices} />
          </div>
        </section>
      </div>

      <div className="weq-usage-cols">
        <section className="weq-usage-section">
          <h4>活跃时段</h4>
          <div className="weq-usage-chart">
            <RadarChart axes={radarAxes} />
            <div className="weq-usage-radar-hint">按一天 24 小时分 6 档（每 4 小时），看你在哪些时段最常用。</div>
          </div>
        </section>
        <section className="weq-usage-section">
          <h4>各克隆体</h4>
          <BarList rows={personaRows} />
        </section>
      </div>
    </div>
  );
}
