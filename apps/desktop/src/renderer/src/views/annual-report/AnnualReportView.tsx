import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, LoaderCircle, RefreshCw } from 'lucide-react';
import type { ReportManifest } from '@weq/service';
import { ALL_TIME_YEAR, reportEraLabel, reportPeriodLabel } from '@weq/service/report-time';
import { client, trpc } from '../../trpc/client';
import { AnnualReportStage } from './AnnualReportStage';
import { AnnualReportEntry } from './AnnualReportEntry';
import { renderReportPage } from './pageRegistry';
import { applyReportFont, clearReportFont } from './reportFont';
import {
  ReportViewContext,
  type PageTurnGuard,
  type ReportViewContextValue,
} from './reportContext';
import '../../styles/annual-report.css';

type PageState = { status: 'idle' | 'loading' | 'ok' | 'error'; data?: unknown; error?: string };

const SLIDE_TRANSITION =
  'opacity 900ms cubic-bezier(0.16, 1, 0.3, 1), transform 1000ms cubic-bezier(0.16, 1, 0.3, 1), filter 900ms cubic-bezier(0.16, 1, 0.3, 1)';

/**
 * 相邻页做「景深退场」：往后压一点、糊掉、压暗。翻页时前一页像被推进暗处，
 * 而不是两张卡片并排滑动 —— 这是报告的电影感来源之一。
 *
 * 上下两侧刻意**不对称**：已翻过的页（delta < 0）往上退进景深，还没到的页
 * （delta > 0）从下方抬起来，位移幅度比退场那侧大一档。对称的话翻上翻下看起来
 * 一模一样，方向感就丢了 —— 这一点位移差正是「往下翻」的实感来源。
 */
function slideStyle(pageIndex: number, index: number): CSSProperties {
  const delta = pageIndex - index;
  const distance = Math.abs(delta);
  const shift = delta < 0 ? distance * -4 : distance * 7;
  return {
    opacity: distance > 1 ? 0 : 1 - distance * 0.82,
    transform: `scale(${1 - distance * 0.08}) translateY(${shift}%)`,
    filter: distance > 0 ? 'blur(14px)' : 'none',
    transition: SLIDE_TRANSITION,
    zIndex: distance === 0 ? 2 : 1,
    pointerEvents: distance === 0 ? 'auto' : 'none',
  };
}

export function AnnualReportView({ onBack }: { onBack: () => void }): ReactElement {
  const [phase, setPhase] = useState<'entry' | 'report'>('entry');
  /**
   * `null` = 还没选过，让服务端决定开屏口径（最近一个真的有数据的年份）。
   * 不再默认 `new Date().getFullYear()` —— 今年可能一条都没发过，那样开屏
   * 就落在一个空报告上。选定之后才带上 `year` 查询。
   */
  const [year, setYear] = useState<number | null>(null);
  const manifestQuery = trpc.account.annualReport.getManifest.useQuery(
    year == null ? {} : { year },
    {
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    },
  );
  /** 服务端回填的口径 —— 首次加载时它就是「开屏该看哪一段」的答案。 */
  const effectiveYear = year ?? manifestQuery.data?.year ?? ALL_TIME_YEAR;

  if (phase === 'entry') {
    return (
      <div className="weq-report-root is-entry">
        <AnnualReportEntry
          manifest={manifestQuery.data ?? null}
          loading={manifestQuery.isLoading}
          isFetching={manifestQuery.isFetching}
          error={manifestQuery.error?.message ?? null}
          selectedYear={effectiveYear}
          onSelectYear={setYear}
          onGenerate={() => setPhase('report')}
          onBack={onBack}
        />
      </div>
    );
  }

  return (
    <ReportDeckView
      year={effectiveYear}
      manifest={manifestQuery.data ?? null}
      manifestLoading={manifestQuery.isLoading}
      onBackToEntry={() => setPhase('entry')}
    />
  );
}

function ReportDeckView({
  year,
  manifest,
  manifestLoading,
  onBackToEntry,
}: {
  year: number;
  manifest: ReportManifest | null;
  manifestLoading: boolean;
  onBackToEntry: () => void;
}): ReactElement {
  const pages = manifest?.pages ?? [];
  const [index, setIndex] = useState(0);
  const [states, setStates] = useState<Record<string, PageState>>({});
  const generationRef = useRef(0);
  const cacheRef = useRef(new Map<string, unknown>());
  /**
   * 报告主字体。装扮页选中「最爱字体」后写在这里，作用于整份报告 —— 已经翻过的
   * 总览页、这一页、结尾页，以及之后加入的任何一页。换年份 / 离开报告时还原。
   */
  const [reportFontId, setReportFontIdState] = useState(0);
  /**
   * 当前页注册的翻页守卫。装扮页用它让「滚到底」先刷出抽屉、再滚一次才翻页。
   * 存在 ref 里而不是 state：注册/注销发生在页面的 effect 里，用 state 会让
   * context value 变化再触发页面重渲，绕回来又重新注册。
   */
  const guardRef = useRef<PageTurnGuard | null>(null);
  const registerPageGuard = useCallback((guard: PageTurnGuard) => {
    guardRef.current = guard;
    return () => {
      // 只清掉自己那个 —— 翻页时新页可能已经先注册上来了。
      if (guardRef.current === guard) guardRef.current = null;
    };
  }, []);
  const runPageGuard = useCallback(
    (direction: 1 | -1) => guardRef.current?.(direction) ?? false,
    [],
  );

  const setReportFontId = useCallback((itemId: number | null) => {
    // applyReportFont 会先把 ttf 加载好再落 CSS；失败时静默还原（返回 false），
    // 所以 state 以它的返回值为准，不以点击意图为准。
    void applyReportFont(itemId).then((ok) => {
      setReportFontIdState(ok && itemId ? itemId : 0);
    });
  }, []);

  useEffect(() => {
    setIndex(0);
    setStates({});
    cacheRef.current.clear();
    generationRef.current += 1;
    setReportFontIdState(0);
    clearReportFont();
  }, [year]);

  // 离开报告时把注入的换字样式收干净，别影响应用其余部分。
  useEffect(() => clearReportFont, []);

  /** 加载一页；成功/失败都 resolve，让顺序队列继续往下走。 */
  const loadPage = useCallback(
    async (pageId: string, force = false): Promise<void> => {
      const currentGeneration = generationRef.current;
      const key = `${year}:${pageId}`;
      if (!force && cacheRef.current.has(key)) {
        setStates((current) => ({
          ...current,
          [pageId]: { status: 'ok', data: cacheRef.current.get(key) },
        }));
        return;
      }
      setStates((current) => ({ ...current, [pageId]: { status: 'loading' } }));
      try {
        const result = await client.account.annualReport.getPageData.query({ year, pageId });
        if (generationRef.current !== currentGeneration) return;
        if (result.status === 'ok') {
          cacheRef.current.set(key, result.data);
          setStates((current) => ({ ...current, [pageId]: { status: 'ok', data: result.data } }));
        } else {
          setStates((current) => ({
            ...current,
            [pageId]: { status: 'error', error: result.error?.message ?? '页面加载失败' },
          }));
        }
      } catch (error) {
        if (generationRef.current !== currentGeneration) return;
        setStates((current) => ({
          ...current,
          [pageId]: {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
    [year],
  );

  // 顺序加载：第 1 页好了立即显示，然后 2、3、4… 依次补齐。
  useEffect(() => {
    if (pages.length === 0) return;
    let cancelled = false;
    const generation = generationRef.current;
    (async () => {
      for (const page of pages) {
        if (cancelled || generation !== generationRef.current) return;
        await loadPage(page.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pages, loadPage]);

  // 翻到还没加载的页时立即加载（不用等队列轮到）。
  useEffect(() => {
    const active = pages[index];
    if (!active) return;
    void loadPage(active.id);
  }, [index, pages, loadPage]);

  const moveTo = useCallback(
    (next: number) => {
      setIndex(Math.max(0, Math.min(Math.max(0, pages.length - 1), next)));
    },
    [pages.length],
  );

  const scopeLabel = useMemo(() => {
    const scope = manifest?.scope;
    if (!scope) return '';
    return [scope.includeC2c && '私聊', scope.includeGroups && '群聊'].filter(Boolean).join(' + ');
  }, [manifest?.scope]);

  const contextValue = useMemo<ReportViewContextValue>(
    () => ({
      year,
      scopeLabel,
      slides: pages
        .filter((page) => states[page.id]?.status === 'ok')
        .map((page) => ({ page, data: states[page.id]?.data })),
      reportFontId,
      setReportFontId,
      registerPageGuard,
    }),
    [year, scopeLabel, pages, states, reportFontId, setReportFontId, registerPageGuard],
  );

  if (manifestLoading && !manifest) {
    return (
      <div className="weq-report-root weq-report-loading">
        <LoaderCircle className="weq-report-spin" size={32} aria-label="正在加载年度报告" />
      </div>
    );
  }
  if (!manifest) {
    return (
      <div className="weq-report-root weq-report-error">
        <p>年度报告目录加载失败</p>
        <button type="button" onClick={onBackToEntry}>
          <RefreshCw size={16} />
          返回重试
        </button>
      </div>
    );
  }
  if (pages.length === 0) {
    return (
      <div className="weq-report-root weq-report-empty">
        <p>
          {reportEraLabel(year)}没有可展示的卡片 —— 至少需要发出过一条私聊或群聊消息，报告才会出现。
        </p>
        <button type="button" onClick={onBackToEntry}>
          换个年份
        </button>
      </div>
    );
  }

  return (
    <div className="weq-report-root is-deck">
      <div className="weq-report-chrome">
        <button className="weq-report-back" type="button" onClick={onBackToEntry}>
          <ArrowLeft size={16} aria-hidden />
          <span>年份</span>
        </button>
        <div className="weq-report-brand">
          <span
            className={`weq-report-brand-year${year === ALL_TIME_YEAR ? ' is-all-time' : ' weq-number'}`}
          >
            {reportPeriodLabel(year)}
          </span>
          <span className="weq-report-brand-name">
            {year === ALL_TIME_YEAR ? '全部记录' : '年度报告'}
          </span>
          {scopeLabel ? <span className="weq-report-brand-scope">{scopeLabel}</span> : null}
        </div>
        <div className="weq-report-progress">
          <span className="weq-number">{String(index + 1).padStart(2, '0')}</span>
          <span className="weq-report-progress-slash" aria-hidden>
            /
          </span>
          <span className="weq-report-progress-total weq-number">
            {String(pages.length).padStart(2, '0')}
          </span>
        </div>
      </div>

      <ReportViewContext.Provider value={contextValue}>
        <AnnualReportStage
          index={index}
          count={pages.length}
          onIndexChange={moveTo}
          guard={runPageGuard}
        >
          {pages.map((page, pageIndex) => {
            const state = states[page.id] ?? { status: 'idle' as const };
            const active = pageIndex === index;
            return (
              <div
                className={`weq-report-slide${active ? ' is-active' : ''}`}
                key={page.id}
                style={slideStyle(pageIndex, index)}
                aria-hidden={!active}
              >
                {state.status === 'loading' || state.status === 'idle' ? (
                  <div className="weq-report-page-status">
                    <LoaderCircle className="weq-report-spin" size={30} aria-hidden />
                    <span>正在整理这一页…</span>
                  </div>
                ) : null}
                {state.status === 'error' ? (
                  <div className="weq-report-page-status">
                    <p>{state.error}</p>
                    <button type="button" onClick={() => void loadPage(page.id, true)}>
                      <RefreshCw size={16} />
                      重试
                    </button>
                  </div>
                ) : null}
                {state.status === 'ok' ? renderReportPage(page, state.data, active) : null}
              </div>
            );
          })}
        </AnnualReportStage>
      </ReportViewContext.Provider>

      <div className="weq-report-rail" aria-label="报告翻页">
        <button
          type="button"
          className="weq-report-rail-arrow"
          onClick={() => moveTo(index - 1)}
          disabled={index === 0}
          aria-label="上一页"
        >
          <ChevronUp size={16} aria-hidden />
        </button>
        <div className="weq-report-ticks">
          {pages.map((page, pageIndex) => (
            <button
              key={page.id}
              type="button"
              className={`weq-report-tick${pageIndex === index ? ' is-active' : ''}`}
              onClick={() => moveTo(pageIndex)}
              aria-label={`第 ${pageIndex + 1} 页：${page.title}`}
              aria-current={pageIndex === index}
            >
              <span className="weq-report-tick-mark" aria-hidden />
              <span className="weq-report-tick-name" aria-hidden>
                {page.title}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="weq-report-rail-arrow"
          onClick={() => moveTo(index + 1)}
          disabled={index === pages.length - 1}
          aria-label="下一页"
        >
          <ChevronDown size={16} aria-hidden />
        </button>
      </div>
      <div className="weq-report-hint" data-visible={index === 0 ? 'yes' : 'no'}>
        <span className="weq-report-hint-arrow" aria-hidden />
        向下滑动继续
      </div>
    </div>
  );
}
