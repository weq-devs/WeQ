import { useEffect, useRef, type ReactElement } from 'react';
import { ArrowLeft, LoaderCircle } from 'lucide-react';
import type { ReportManifest } from '@weq/service';
import { isAllTimeYear } from '@weq/service/report-time';

/**
 * 报告入口 —— 一块海报，不是一张表单。
 *
 * 巨型年份占据画面中轴，年份用横向刻度轨选择：选中的那一年放大、其余缩到
 * 边缘。底部只留一句手写体式的引子和一个下沉式的进入按钮。
 *
 * 轨上只有「真的能生成报告」的口径：`ALL_TIME_YEAR`（历史以来）打头，
 * 后面是发出过至少一条消息的年份 —— 不是最早到今天的连续区间，所以不会有
 * 点进去只看到「没有可展示的卡片」的年份。
 */
export function AnnualReportEntry({
  manifest,
  loading,
  isFetching,
  error,
  selectedYear,
  onSelectYear,
  onGenerate,
  onBack,
}: {
  manifest: ReportManifest | null;
  loading: boolean;
  isFetching: boolean;
  error: string | null;
  selectedYear: number;
  onSelectYear: (year: number) => void;
  onGenerate: () => void;
  onBack: () => void;
}): ReactElement {
  const availableYears = manifest?.availableYears ?? [];
  const pages = manifest?.pages ?? [];
  const canGenerate = pages.length > 0 && !loading && !isFetching;
  const noData = !loading && !error && manifest != null && pages.length === 0;
  /** 一条都没发过的账号：整个选择器都没有意义，只留一句说明。 */
  const emptyAccount = !loading && !error && manifest != null && availableYears.length === 0;
  const allTime = isAllTimeYear(selectedYear);
  const stripRef = useRef<HTMLDivElement>(null);

  // 选中的年份自动滚到刻度轨中央。
  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>('[data-active="yes"]');
    active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [selectedYear, availableYears.length]);

  return (
    <div className="weq-entry">
      <button className="weq-entry-back" type="button" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden />
        返回
      </button>

      <div className="weq-entry-brand">
        <span className="weq-entry-brand-rule" aria-hidden />
        WEQ CHAT WRAPPED
      </div>

      <div className="weq-entry-stage">
        <p className="weq-entry-kicker">
          {allTime ? '从第一条消息到今天，你都和谁说了话' : '这一年，你都和谁说了话'}
        </p>
        <div className="weq-entry-year" key={selectedYear}>
          <span className={`weq-entry-year-num${allTime ? ' is-all-time' : ' weq-number'}`}>
            {allTime ? '历史以来' : selectedYear}
          </span>
        </div>
        <p className="weq-entry-lede">
          {emptyAccount
            ? '这台电脑上还没有你发出过的消息 —— 先聊几句，再回来看。'
            : noData
              ? allTime
                ? '这台电脑上还没有你发出过的消息。'
                : '这一年你一条消息都没发出过 —— 换个年份试试。'
              : '从这台电脑上的聊天记录里，把它读出来。'}
        </p>
      </div>

      <div className="weq-entry-picker">
        {loading ? (
          <div className="weq-entry-strip is-loading" aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <span className="weq-entry-strip-skeleton" key={i} />
            ))}
          </div>
        ) : (
          <div
            className="weq-entry-strip"
            ref={stripRef}
            role="radiogroup"
            aria-label="选择报告年份"
          >
            {availableYears.map((year) => {
              const isAll = isAllTimeYear(year);
              return (
                <button
                  key={year}
                  type="button"
                  role="radio"
                  aria-checked={year === selectedYear}
                  aria-label={isAll ? '历史以来（全部时间）' : `${year} 年`}
                  data-active={year === selectedYear ? 'yes' : 'no'}
                  className={`weq-entry-strip-year${isAll ? ' is-all-time' : ''}`}
                  onClick={() => onSelectYear(year)}
                >
                  <span className={isAll ? undefined : 'weq-number'}>
                    {isAll ? '历史以来' : year}
                  </span>
                  <span className="weq-entry-strip-mark" aria-hidden />
                </button>
              );
            })}
          </div>
        )}
        {error ? <p className="weq-entry-error">目录加载失败：{error}</p> : null}
      </div>

      <button type="button" className="weq-entry-cta" disabled={!canGenerate} onClick={onGenerate}>
        <span className="weq-entry-cta-text">
          {isFetching ? (allTime ? '正在读取全部记录' : '正在读取这一年') : '开始播放'}
        </span>
        {isFetching ? (
          <LoaderCircle className="weq-report-spin" size={16} aria-hidden />
        ) : (
          <span className="weq-entry-cta-arrow" aria-hidden />
        )}
      </button>

      <p className="weq-entry-foot">私聊 + 群聊 · 不含数据线与服务号 · 全部在本机计算</p>
    </div>
  );
}
