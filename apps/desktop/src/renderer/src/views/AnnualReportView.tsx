/**
 * 年度报告视图 —— 功能即将上线，这里是一张「敬请期待」的占位动画页。
 *
 * 全部颜色取自主题变量（--weq-*），深浅模式自动适配；动效在
 * prefers-reduced-motion 下会降级为静态展示。
 */

import type { ReactElement } from 'react';
import { BarChart3, Sparkles } from 'lucide-react';
import '../styles/annual-report.css';

/** 柱状图每根柱子的高度（百分比），做出「报告数据」的意象。 */
const BARS = [
  { id: 'bar-1', height: 34 },
  { id: 'bar-2', height: 58 },
  { id: 'bar-3', height: 44 },
  { id: 'bar-4', height: 74 },
  { id: 'bar-5', height: 52 },
  { id: 'bar-6', height: 88 },
  { id: 'bar-7', height: 62 },
];

export function AnnualReportView(): ReactElement {
  return (
    <div className="weq-annual">
      <span className="weq-annual-orb weq-annual-orb-a" aria-hidden />
      <span className="weq-annual-orb weq-annual-orb-b" aria-hidden />
      <span className="weq-annual-orb weq-annual-orb-c" aria-hidden />

      <div className="weq-annual-card">
        <div className="weq-annual-icon">
          <BarChart3 size={40} strokeWidth={1.6} aria-hidden />
        </div>

        <div className="weq-annual-chart" aria-hidden>
          {BARS.map(({ id, height }) => (
            <span key={id} className="weq-annual-bar" style={{ height: `${height}%` }} />
          ))}
        </div>

        <h2 className="weq-annual-title">年度报告</h2>
        <p className="weq-annual-desc">年度报告功能即将上线，敬请期待</p>

        <div className="weq-annual-progress" role="presentation" aria-hidden />

        <span className="weq-annual-badge">
          <Sparkles size={13} strokeWidth={2} aria-hidden />
          即将上线 · Coming Soon
        </span>
      </div>
    </div>
  );
}
