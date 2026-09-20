/**
 * 分析卡片（群聊 / 私聊 / 成员）的加载骨架屏。
 *
 * 分析要扫群历史，慢一点是常态；空转的转圈让人以为「卡住了」，而骨架屏先把版面
 * 撑出来，数据一到位就原地替换 —— 视觉上不跳。灰块走 `.weq-skeleton` 的
 * shimmer 高光动画（见 chat.css），并尊重 `prefers-reduced-motion`。
 */
/** 占位块的稳定 key —— 骨架屏是静态的，别用数组下标当 key。 */
const STAT_KEYS = ['s1', 's2', 's3', 's4'];
const ROW_KEYS = ['r1', 'r2', 'r3', 'r4', 'r5'];

const LABELS: Record<'group' | 'buddy' | 'member', string> = {
  group: '正在分析群聊…',
  buddy: '正在分析私聊…',
  member: '正在分析这位成员…',
};

export function AnalyticsSkeleton({
  variant = 'group',
}: {
  variant?: 'group' | 'buddy' | 'member';
}) {
  const bars = variant === 'group' ? 5 : 4;
  return (
    <div className="ga-skeleton" role="status" aria-live="polite" aria-label={LABELS[variant]}>
      <span className="ga-skeleton-sr">{LABELS[variant]}</span>

      {/* hero：头像 + 名字/区间 */}
      <div className="ga-sk-hero">
        <span className="weq-skeleton ga-sk-avatar" />
        <div className="ga-sk-hero-lines">
          <span className="weq-skeleton" style={{ width: '38%', height: 15 }} />
          <span className="weq-skeleton" style={{ width: '58%', height: 11 }} />
        </div>
      </div>

      {/* 四个概览数 */}
      <div className="ga-sk-grid">
        {STAT_KEYS.map((key) => (
          <span key={key} className="weq-skeleton ga-sk-stat" />
        ))}
      </div>

      {/* 排行 / 图表块 */}
      <span className="weq-skeleton ga-sk-chart" />
      <span className="weq-skeleton ga-sk-chart is-short" />

      {/* 榜单行 */}
      <div className="ga-sk-rows">
        {ROW_KEYS.slice(0, bars).map((key) => (
          <span key={key} className="ga-sk-row">
            <span className="weq-skeleton ga-sk-row-face" />
            <span className="weq-skeleton" style={{ flex: 1, height: 12 }} />
            <span className="weq-skeleton" style={{ width: 46, height: 12 }} />
          </span>
        ))}
      </div>
    </div>
  );
}
