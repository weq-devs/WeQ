import { useEffect, useRef, type ReactElement } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { ReportManifest } from '@weq/service';
import { isAllTimeYear } from '@weq/service/report-time';

/**
 * 报告入口 —— 一块海报，不是一张表单。
 *
 * 巨型年份占据画面中轴，年份用横向刻度轨选择：选中的那一年放大、其余缩到
 * 边缘。底部只留一句手写体式的引子和一个下沉式的进入按钮（按钮说的是「向下
 * 滚动查看报告」—— 进报告后第一步就是一次向下滚）。
 *
 * 轨上只有「真的能生成报告」的口径：发出过至少一条消息的年份，左小右大、
 * 「历史以来」单独钉在最右端 —— 不是最早到今天的连续区间，所以不会有
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
}: {
  manifest: ReportManifest | null;
  loading: boolean;
  isFetching: boolean;
  error: string | null;
  selectedYear: number;
  onSelectYear: (year: number) => void;
  onGenerate: () => void;
}): ReactElement {
  /**
   * 服务端的顺序就是「左小右大、历史以来钉在最右」（`2024 2025 2026 历史以来`），
   * 直接用 —— 列表内容不随选中年份变化，切换只是改选中态。
   */
  const availableYears = manifest?.availableYears ?? [];
  const pages = manifest?.pages ?? [];
  const canGenerate = pages.length > 0 && !loading && !isFetching;
  /**
   * 没数据看 `availableYears`，不看 `pages`：切年份的过渡期 manifest 还是上一份
   * （keepPreviousData），pages 可能空了一拍；而可选年份列表不随年份变化，始终可靠。
   */
  const noData = !loading && !error && manifest != null && availableYears.length === 0;
  const allTime = isAllTimeYear(selectedYear);
  /**
   * 选中的年份不在可选列表里 = 这一年一条都没发过。列表本身不随年份切换变化，
   * 所以过渡期（manifest 还是上一份）这个判定也可靠。
   */
  const yearEmpty = !noData && !allTime && !availableYears.includes(selectedYear);
  const stripRef = useRef<HTMLDivElement>(null);

  // 选中的年份自动滚到刻度轨中央。
  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>('[data-active="yes"]');
    active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [selectedYear, availableYears.length]);

  return (
    <div className="weq-entry">
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
          {noData
            ? '这台电脑上还没有你发出过的消息 —— 先聊几句，再回来看。'
            : yearEmpty
              ? '这一年你一条消息都没发出过 —— 换个年份试试。'
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
          {isFetching ? (allTime ? '正在读取全部记录' : '正在读取这一年') : '向下滚动查看报告'}
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
