import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, LoaderCircle, RefreshCw } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { AnnualReportStage } from './AnnualReportStage';
import { renderReportPage } from './pageRegistry';
import '../../styles/annual-report.css';

type PageState = { status: 'idle' | 'loading' | 'ok' | 'error'; data?: unknown; error?: string };

export function AnnualReportView({ onBack }: { onBack: () => void }): ReactElement {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const manifestQuery = trpc.account.annualReport.getManifest.useQuery(
    { year },
    {
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    },
  );
  const pages = manifestQuery.data?.pages ?? [];
  const [index, setIndex] = useState(0);
  const [states, setStates] = useState<Record<string, PageState>>({});
  const generationRef = useRef(0);
  const cacheRef = useRef(new Map<string, unknown>());

  useEffect(() => {
    setIndex(0);
    setStates({});
    cacheRef.current.clear();
    generationRef.current += 1;
  }, [year]);

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

  useEffect(() => {
    const active = pages[index];
    if (!active) return;
    void loadPage(active.id);
    const next = pages[index + 1];
    const previous = pages[index - 1];
    if (next) void loadPage(next.id);
    if (previous) void loadPage(previous.id);
  }, [index, loadPage, pages]);

  const moveTo = useCallback(
    (next: number) => {
      setIndex(Math.max(0, Math.min(Math.max(0, pages.length - 1), next)));
    },
    [pages.length],
  );

  const activePage = pages[index];
  const activeState = activePage ? states[activePage.id] : undefined;
  const availableYears = manifestQuery.data?.availableYears ?? [year];
  const scopeLabel = useMemo(() => {
    const scope = manifestQuery.data?.scope;
    if (!scope) return '';
    return [scope.includeC2c && '私聊', scope.includeGroups && '群聊'].filter(Boolean).join(' + ');
  }, [manifestQuery.data?.scope]);

  if (manifestQuery.isLoading) {
    return (
      <div className="weq-report-root weq-report-loading">
        <LoaderCircle className="weq-report-spin" size={32} aria-label="正在加载年度报告" />
      </div>
    );
  }
  if (manifestQuery.error) {
    return (
      <div className="weq-report-root weq-report-error">
        <p>年度报告目录加载失败：{manifestQuery.error.message}</p>
        <button type="button" onClick={() => void manifestQuery.refetch()}>
          <RefreshCw size={16} />
          重试
        </button>
      </div>
    );
  }
  if (!pages.length) {
    return (
      <div className="weq-report-root weq-report-empty">
        <p>当前没有可显示的年度报告页面。</p>
        <button type="button" onClick={onBack}>
          返回
        </button>
      </div>
    );
  }

  return (
    <div className="weq-report-root">
      <div className="weq-report-chrome">
        <button className="weq-report-back" type="button" onClick={onBack}>
          <ArrowLeft size={18} />
          返回
        </button>
        <div className="weq-report-heading">
          <strong>{year} 年度报告</strong>
          <span>{scopeLabel}</span>
        </div>
        <label className="weq-report-year">
          年份
          <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
            {availableYears.map((availableYear) => (
              <option key={availableYear} value={availableYear}>
                {availableYear}
              </option>
            ))}
          </select>
        </label>
      </div>
      <AnnualReportStage index={index} count={pages.length} onIndexChange={moveTo}>
        {pages.map((page, pageIndex) => {
          const state = states[page.id] ?? { status: 'idle' as const };
          return (
            <div className="weq-report-slide" key={page.id} aria-hidden={pageIndex !== index}>
              {state.status === 'loading' || state.status === 'idle' ? (
                <div className="weq-report-page-status">
                  <LoaderCircle className="weq-report-spin" size={32} />
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
              {state.status === 'ok' ? renderReportPage(page, state.data) : null}
            </div>
          );
        })}
      </AnnualReportStage>
      <div className="weq-report-controls">
        <button
          type="button"
          onClick={() => moveTo(index - 1)}
          disabled={index === 0}
          aria-label="上一页"
        >
          <ChevronUp size={18} />
        </button>
        <div className="weq-report-dots" aria-label="报告页码">
          {pages.map((page, pageIndex) => (
            <button
              key={page.id}
              type="button"
              className={pageIndex === index ? 'active' : ''}
              onClick={() => moveTo(pageIndex)}
              aria-label={`第 ${pageIndex + 1} 页：${page.title}`}
            />
          ))}
        </div>
        <span>
          {index + 1} / {pages.length}
        </span>
        <button
          type="button"
          onClick={() => moveTo(index + 1)}
          disabled={index === pages.length - 1}
          aria-label="下一页"
        >
          <ChevronDown size={18} />
        </button>
      </div>
      <div className="weq-report-hint">滚轮 / 触摸 / ↑↓ 翻页</div>
    </div>
  );
}
