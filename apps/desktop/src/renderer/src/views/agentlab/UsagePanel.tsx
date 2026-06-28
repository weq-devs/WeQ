/**
 * 主页用量统计：总量 + 各模型 / 各克隆体 / 场景 的柱状条，加最近 30 天 token 趋势折线。
 * 数据来自 account.getAgentLabTokenStats；图表用纯 SVG / CSS，不引图表库。
 */

import { useMemo, type ReactElement } from 'react';
import { BarChart3 } from 'lucide-react';
import { trpc } from '../../trpc/client';

/** WeQ 助手在统计里的占位键（与后端 ASSISTANT_KEY 对齐）。 */
const ASSISTANT_KEY = '__assistant__';

const SCOPE_LABEL: Record<string, string> = {
  build: '构建克隆',
  chat: '与克隆体聊天',
  assistant: 'WeQ 助手',
};

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function BarList({
  rows,
}: {
  rows: Array<{ key: string; label: string; value: number }>;
}): ReactElement {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <div className="weq-usage-empty">暂无数据</div>;
  return (
    <div className="weq-usage-bars">
      {rows.map((r) => (
        <div key={r.key} className="weq-usage-bar-row">
          <span className="weq-usage-bar-label" title={r.label}>{r.label}</span>
          <span className="weq-usage-bar-track">
            <span className="weq-usage-bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="weq-usage-bar-val">{fmt(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function TrendChart({ data }: { data: Array<{ day: string; tokens: number }> }): ReactElement {
  const W = 640;
  const H = 120;
  const PAD = 6;
  const max = Math.max(1, ...data.map((d) => d.tokens));
  const stepX = (W - PAD * 2) / Math.max(1, data.length - 1);
  const points = data.map((d, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - (d.tokens / max) * (H - PAD * 2);
    return [x, y] as const;
  });
  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${points[points.length - 1]?.[0].toFixed(1) ?? PAD},${H - PAD} L${PAD},${H - PAD} Z`;
  return (
    <svg className="weq-usage-trend" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="最近30天 token 趋势">
      <path d={area} className="weq-usage-trend-area" />
      <path d={line} className="weq-usage-trend-line" fill="none" />
    </svg>
  );
}

export function UsagePanel({ resolveName }: { resolveName: (personaId: string) => string }): ReactElement {
  const stats = trpc.account.getAgentLabTokenStats.useQuery();
  const d = stats.data;

  const personaRows = useMemo(
    () =>
      (d?.byPersona ?? []).map((p) => ({
        key: p.personaId,
        label: p.personaId === ASSISTANT_KEY ? 'WeQ 助手' : resolveName(p.personaId),
        value: p.tokens,
      })),
    [d?.byPersona, resolveName],
  );

  if (stats.isLoading) return <div className="weq-agentlab-placeholder"><p>加载用量统计中…</p></div>;
  if (!d || d.totalCalls === 0) {
    return (
      <div className="weq-agentlab-placeholder">
        <BarChart3 size={36} strokeWidth={1.4} />
        <h3>用量统计</h3>
        <p>构建克隆或与克隆体聊天后，这里会展示 token 消耗、各模型 / 各克隆体 / 时间维度的统计。</p>
      </div>
    );
  }

  return (
    <div className="weq-usage">
      <div className="weq-usage-head">
        <div className="weq-usage-kpi">
          <strong>{fmt(d.totalTokens)}</strong>
          <span>累计 token</span>
        </div>
        <div className="weq-usage-kpi">
          <strong>{d.totalCalls}</strong>
          <span>调用次数</span>
        </div>
      </div>

      <section className="weq-usage-section">
        <h4>最近 30 天</h4>
        <TrendChart data={d.byDay} />
      </section>

      <div className="weq-usage-cols">
        <section className="weq-usage-section">
          <h4>各模型</h4>
          <BarList rows={d.byModel.map((m) => ({ key: m.model, label: m.model, value: m.tokens }))} />
        </section>
        <section className="weq-usage-section">
          <h4>各克隆体</h4>
          <BarList rows={personaRows} />
        </section>
      </div>

      <section className="weq-usage-section">
        <h4>场景</h4>
        <BarList rows={d.byScope.map((s) => ({ key: s.scope, label: SCOPE_LABEL[s.scope] ?? s.scope, value: s.tokens }))} />
      </section>
    </div>
  );
}
