/**
 * 互动画像 Dialog —— 好感度胶囊点击打开。
 *
 * 内容：好感度数字 + 档位、近期走势条形、MBTI 四维（左极占比条）、互动风格
 * 雷达（纯 SVG，五边形网格 + 数据面 + 标签，动画同 agentlab UsagePanel 的
 * 手法）、常见话题 pills。全部数据来自 intentSense.getProfile（本地统计 +
 * 引擎增强），画像为启发式推断 —— 底部固定一行「仅供娱乐参考」。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { BrainCircuit, RefreshCw, X } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { OverlayLayer } from '../OverlayLayer';
import { AnalyticsSkeleton } from '../AnalyticsSkeleton';
import { useIntentSenseStatus } from './context';
import '../../styles/intent-sense.css';

const MBTI_LABELS: Record<string, [string, string]> = {
  EI: ['外向 E', '内向 I'],
  SN: ['实感 S', '直觉 N'],
  TF: ['思考 T', '情感 F'],
  JP: ['判断 J', '感知 P'],
};

const TIER_LABELS = ['初识', '熟络', '亲近', '挚友', '羁绊'];

/** 五轴雷达（纯 SVG；中心 0 分、外圈 100 分）。 */
function Radar({ axes }: { axes: Array<{ axis: string; value: number }> }) {
  const width = 340;
  const height = 280;
  const cx = width / 2;
  const cy = height / 2;
  const r = 78;
  const n = Math.max(3, axes.length);
  const point = (i: number, ratio: number): [number, number] => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + Math.cos(angle) * r * ratio, cy + Math.sin(angle) * r * ratio];
  };
  const ring = (ratio: number): string => axes.map((_, i) => point(i, ratio).join(',')).join(' ');
  const dataPoly = axes.map((a, i) => point(i, Math.max(0.04, a.value / 100)).join(',')).join(' ');
  return (
    <svg
      className="weq-int-radar"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="互动风格雷达"
    >
      {[0.25, 0.5, 0.75, 1].map((ratio) => (
        <polygon
          key={ratio}
          points={ring(ratio)}
          fill="none"
          stroke="var(--weq-border-strong)"
          strokeWidth="1"
        />
      ))}
      {axes.map((a, i) => (
        <line
          key={a.axis}
          x1={cx}
          y1={cy}
          x2={point(i, 1)[0]}
          y2={point(i, 1)[1]}
          stroke="var(--weq-border-strong)"
          strokeWidth="1"
        />
      ))}
      <polygon
        points={dataPoly}
        fill="color-mix(in srgb, var(--weq-accent-effective) 22%, transparent)"
        stroke="var(--weq-accent-effective)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      {axes.map((a, i) => {
        const [x, y] = point(i, 1.24);
        return (
          <text
            key={a.axis}
            x={x}
            y={y}
            textAnchor={x < cx - 6 ? 'end' : x > cx + 6 ? 'start' : 'middle'}
            dominantBaseline="middle"
            fontSize="11"
            fill="var(--weq-fg-secondary)"
          >
            <tspan x={x}>{a.axis}</tspan>
            <tspan x={x} dy="14">
              {Math.round(a.value)}
            </tspan>
          </text>
        );
      })}
    </svg>
  );
}

export function IntentProfileDialog({
  peerUid,
  peerName,
  onClose,
}: {
  peerUid: string;
  peerName: string;
  onClose: () => void;
}): ReactElement {
  const [refreshing, setRefreshing] = useState(false);
  const status = useIntentSenseStatus();
  const profile = trpc.account.intentSense.getProfile.useQuery(
    { peerUid },
    {
      refetchOnWindowFocus: false,
      staleTime: (status.data?.profileCacheSeconds ?? 60) * 1000,
      retry: false,
    },
  );

  const data = profile.data;
  const mbtiDims = useMemo(
    () =>
      (data?.mbti.dims ?? [])
        .filter((d) => d.key in MBTI_LABELS)
        .sort(
          (a, b) =>
            ['EI', 'SN', 'TF', 'JP'].indexOf(a.key) - ['EI', 'SN', 'TF', 'JP'].indexOf(b.key),
        ),
    [data?.mbti.dims],
  );

  return (
    <OverlayLayer
      presentation="modal"
      className="weq-int-profile-layer"
      onClose={onClose}
      role="presentation"
    >
      <section
        className="group-keyword-dialog weq-int-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`互动画像：${peerName}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div className="group-keyword-title">
            <span className="group-keyword-title-icon">
              <BrainCircuit size={17} />
            </span>
            <div>
              <strong>互动画像</strong>
              <span>{peerName}</span>
            </div>
          </div>
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <button
              type="button"
              className="icon-button"
              title="重新计算"
              aria-label="重新计算"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  await profile.refetch();
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              <RefreshCw size={16} className={refreshing ? 'weq-spin' : undefined} />
            </button>
            <button
              className="icon-button"
              type="button"
              title="关闭"
              aria-label="关闭"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </span>
        </header>
        <div className="group-keyword-body">
          {profile.error ? (
            <p className="weq-int-note" role="alert">
              画像读取失败：{profile.error.message}
            </p>
          ) : profile.isLoading ? (
            <AnalyticsSkeleton variant="buddy" />
          ) : !data ? (
            <p className="weq-int-note" role="status">
              暂无可分析的对方消息，未生成互动画像。
            </p>
          ) : (
            <div className="weq-int-profile">
              <section>
                <h4>
                  好感度 <strong className="weq-int-affinity-num">{data.affinity}</strong>
                  <span className="weq-int-topic">{TIER_LABELS[Math.min(4, data.tier)]}</span>
                </h4>
                {data.trend.length > 1 ? (
                  <div
                    className="weq-int-trend"
                    title={data.trend.map((t) => `${t.date}：${t.score}`).join('\n')}
                  >
                    {data.trend.map((t) => (
                      <div
                        key={t.date}
                        className="weq-int-trend-bar"
                        style={{ height: `${Math.max(6, t.score)}%` }}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="weq-int-note">样本不足，暂无走势。</p>
                )}
              </section>

              <section>
                <h4>
                  MBTI 倾向
                  <span className="weq-int-note">
                    {data.mbti.heuristic
                      ? '（启发式估算）'
                      : `（${data.engine === 'local' ? '本地模型' : 'API'} 推断）`}
                  </span>
                </h4>
                <div className="weq-int-profile-letters">
                  <strong>{data.mbti.letters || '—'}</strong>
                </div>
                <div className="weq-int-mbti-dims">
                  {mbtiDims.map((d) => (
                    <div key={d.key} className="weq-int-mbti-dim">
                      <span>{MBTI_LABELS[d.key]?.[0]}</span>
                      <span className="weq-int-mbti-track">
                        <span style={{ width: `${Math.round(d.leftPct)}%` }} />
                      </span>
                      <span style={{ textAlign: 'right' }}>{MBTI_LABELS[d.key]?.[1]}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <h4>互动风格</h4>
                <Radar axes={data.radar} />
              </section>

              <section>
                <h4>常见话题</h4>
                {data.topics.length > 0 ? (
                  <div className="weq-int-topics">
                    {data.topics.map((t) => (
                      <span key={t.topic} className="weq-int-topic" title={`${t.count} 次`}>
                        {t.topic}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="weq-int-note">暂无足够文本样本。</p>
                )}
              </section>

              <p className="weq-int-note">
                基于 {data.sampled} 条消息（引擎分析 {data.analyzedSamples} 条）
                的启发式推断，仅供娱乐参考。
              </p>
            </div>
          )}
        </div>
      </section>
    </OverlayLayer>
  );
}
