import { useEffect, useState, type ReactElement } from 'react';
import type { OverviewPageData } from '@weq/service';
import { isAllTimeYear, reportEraLabel, reportSinceLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer, usePrefersReducedMotion } from '../Odometer';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/**
 * 日均条数的显示形式。`toFixed` 在低值区会退化成没有信息量的「0.0」/「0.00」
 * （例如全年只发过 1 条：0.004），所以低于 0.1 条/天时改用「<0.1」，
 * 明确表达「有但极少」而不是「没有」。
 */
function formatPerDay(perDay: number): string {
  if (perDay >= 10) return fmt(Math.round(perDay));
  if (perDay >= 1) return perDay.toFixed(1);
  if (perDay >= 0.1) return perDay.toFixed(2);
  return perDay > 0 ? '<0.1' : '0';
}

/**
 * 年度总览 —— 报告开篇。整页只有一个主角：这一年你发出的消息总数，
 * 用里程表式巨型数字砸在正中；其余全部退到发丝线以下的数据带里。
 *
 * 刻意不做卡片、不做仪表盘：一个巨数 + 一条私聊/群聊分割轨 + 一行小字数据带，
 * 加上出血的描边年份衬底。「历史以来」口径下衬底字换成 ALL，文案由
 * `reportEraLabel` 统一给出，日均的分母用服务端下发的 `spanDays`。
 */
export function OverviewPage({
  page,
  data,
  active,
}: ReportPageProps<OverviewPageData>): ReactElement {
  const { year, totalSent, totalReceived, c2cSent, groupSent, spanDays, firstMessageTime } = data;
  const reduce = usePrefersReducedMotion();
  const [railOpen, setRailOpen] = useState(false);

  useEffect(() => {
    if (!active) {
      setRailOpen(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setRailOpen(true), reduce ? 0 : 620);
    return () => window.clearTimeout(timer);
  }, [active, reduce]);

  const eraLabel = reportEraLabel(year);
  const sinceLabel = reportSinceLabel(year, firstMessageTime);
  const sentSum = Math.max(1, c2cSent + groupSent);
  const c2cPct = Math.round((c2cSent / sentSum) * 100);
  const groupPct = 100 - c2cPct;
  const perDay = totalSent / Math.max(1, spanDays);
  /** 你每说 100 句，朋友们回了多少句。 */
  const echo = totalSent > 0 ? Math.round((totalReceived / totalSent) * 100) : 0;

  return (
    <PageFrame
      page={page}
      active={active}
      eyebrow={
        <>
          年度总览<span className="weq-report-eyebrow-en">OVERVIEW</span>
        </>
      }
      ghost={isAllTimeYear(year) ? 'ALL' : year}
    >
      <div className="weq-ov">
        <p className="weq-ov-lede weq-report-line" style={{ '--i': 1 } as React.CSSProperties}>
          {eraLabel}
          {sinceLabel ? <span className="weq-ov-since">（{sinceLabel}）</span> : null}，你一共说出了
        </p>

        <div className="weq-ov-hero weq-report-line" style={{ '--i': 2 } as React.CSSProperties}>
          <Odometer value={totalSent} active={active} className="weq-ov-hero-num" />
          <span className="weq-ov-hero-unit">条消息</span>
        </div>

        <div className="weq-ov-rail weq-report-line" style={{ '--i': 3 } as React.CSSProperties}>
          <div className="weq-ov-rail-track" data-open={railOpen ? 'yes' : 'no'}>
            <span
              className="weq-ov-rail-fill is-c2c"
              style={{ width: railOpen ? `${c2cPct}%` : '0%' }}
            />
            <span
              className="weq-ov-rail-fill is-group"
              style={{ width: railOpen ? `${groupPct}%` : '0%' }}
            />
          </div>
          <div className="weq-ov-rail-legend">
            <span className="weq-ov-rail-side">
              <em className="weq-ov-rail-pct weq-number">{c2cPct}%</em>
              <span className="weq-ov-rail-name">私聊</span>
              <span className="weq-ov-rail-count weq-number">{fmt(c2cSent)}</span>
            </span>
            <span className="weq-ov-rail-side is-right">
              <span className="weq-ov-rail-count weq-number">{fmt(groupSent)}</span>
              <span className="weq-ov-rail-name">群聊</span>
              <em className="weq-ov-rail-pct weq-number">{groupPct}%</em>
            </span>
          </div>
        </div>

        <dl className="weq-ov-band weq-report-line" style={{ '--i': 4 } as React.CSSProperties}>
          <div className="weq-ov-band-cell">
            <dt>日均</dt>
            <dd>
              <span className="weq-number">{formatPerDay(perDay)}</span>
              <i>条</i>
            </dd>
          </div>
          <div className="weq-ov-band-cell">
            <dt>收到</dt>
            <dd>
              <span className="weq-number">{fmt(totalReceived)}</span>
              <i>条</i>
            </dd>
          </div>
          <div className="weq-ov-band-cell">
            <dt>你说 100 句，回声</dt>
            <dd>
              <span className="weq-number">{fmt(echo)}</span>
              <i>句</i>
            </dd>
          </div>
        </dl>
      </div>
    </PageFrame>
  );
}
