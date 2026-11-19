import { FormSelect } from '../../components/FormSelect';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ContactRound, RefreshCw, Search, Trash2, UserRound, Users } from 'lucide-react';
import { eventTimeFormatter } from '@weq/time';
import { analysisPeriod } from '@weq/service/analysis-report';
import type { AnalysisReportSummary } from '@weq/service';
import { TimeLabel } from '../../components/TimeLabel';
import { client, trpc } from '../../trpc/client';
import { useDialog } from '../../components/Dialog.shared';
import { useTabActive } from '../../components/RetainedTabs.shared';
import { WindowedList } from '../../components/WindowedList';
import { usePageState } from '../../components/PageSnapshots.shared';
import { pageValue } from '../../lib/pageSnapshots';
import { ANALYSIS_LABELS, restoredAnalysisRequest, type AnalysisReportRequest } from './model';
import '../../styles/analysis-reports.css';

const reportStatus = {
  running: '正在分析',
  paused: '待继续',
  completed: '已完成',
  failed: '分析失败',
  cancelled: '已取消',
};
const reportIcons = { buddy: UserRound, group: Users, member: ContactRound };

function reportIdentity(request: AnalysisReportSummary['request']) {
  if (request.kind === 'member')
    return `${request.groupName || '群'}（${request.groupCode}） · ${request.memberUin || request.memberUid}`;
  return request.kind === 'group' ? request.groupCode : request.peerUid;
}

export function AnalysisReportsTool({
  onOpenReport,
}: {
  onOpenReport: (request: AnalysisReportRequest) => void;
}) {
  const enabled = useTabActive();
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled });
  const binding = {
    expectedAccountUin: config.data?.uin ?? '',
    expectedAccountConfigId: config.data?.configId ?? '',
  };
  const query = trpc.account.analysisReports.list.useQuery(binding, {
    enabled: enabled && Boolean(config.data),
    refetchOnWindowFocus: false,
  });
  trpc.account.analysisReports.onChange.useSubscription(binding, {
    enabled: enabled && Boolean(config.data),
    onData: () => void query.refetch(),
  });
  const dialog = useDialog();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [search, setSearch] = usePageState('analysis-reports:search', '', pageValue.string);
  const [kind, setKind] = usePageState('analysis-reports:kind', 'all', pageValue.string);
  const [status, setStatus] = usePageState('analysis-reports:status', 'all', pageValue.string);
  const viewport = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(560);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setHeight(element.clientHeight || 560);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const needle = search.trim().toLocaleLowerCase();
  const reports = useMemo(
    () =>
      (query.data ?? []).filter((report) => {
        const request = report.request;
        return (
          (kind === 'all' || request.kind === kind) &&
          (status === 'all' || report.status === status) &&
          (!needle ||
            [
              request.name,
              reportIdentity(request),
              ANALYSIS_LABELS[request.kind],
              analysisPeriod(request),
              report.resultRequest ? analysisPeriod(report.resultRequest) : '',
            ]
              .join('\n')
              .toLocaleLowerCase()
              .includes(needle))
        );
      }),
    [query.data, kind, status, needle],
  );
  const loadError = config.error?.message || query.error?.message;
  const loading = config.isLoading || (Boolean(config.data) && query.isLoading);
  async function act(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="weq-analysis-reports" aria-label="分析报告列表" aria-busy={loading}>
      <div className="weq-analysis-reports-toolbar">
        <label className="weq-analysis-reports-search">
          <Search size={16} aria-hidden />
          <input
            type="search"
            aria-label="搜索分析报告"
            placeholder="名称、号码或日期"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <FormSelect
          aria-label="筛选报告类型"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="all">全部类型</option>
          {(['group', 'buddy', 'member'] as const).map((value) => (
            <option key={value} value={value}>
              {ANALYSIS_LABELS[value]}
            </option>
          ))}
        </FormSelect>
        <FormSelect
          aria-label="筛选报告状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">全部状态</option>
          {Object.entries(reportStatus).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </FormSelect>
        <button
          className="weq-set-iconbtn"
          type="button"
          title="刷新报告列表"
          aria-label="刷新报告列表"
          disabled={query.isFetching || config.isFetching}
          onClick={() => {
            setError('');
            if (config.error) void config.refetch();
            else void query.refetch();
          }}
        >
          <RefreshCw size={16} aria-hidden />
        </button>
      </div>
      {error || loadError ? (
        <p className="weq-analysis-reports-error" role="alert">
          {error || loadError}
        </p>
      ) : null}
      <div className="weq-analysis-reports-viewport" ref={viewport}>
        {loading && !query.data ? (
          <p className="weq-analysis-reports-empty" role="status">
            正在读取分析报告…
          </p>
        ) : reports.length ? (
          <WindowedList
            items={reports}
            rowHeight={132}
            height={height}
            resetKey={JSON.stringify([needle, kind, status])}
            itemKey={(report) => report.request.id}
            label="已保存的分析记录"
            renderItem={(report) => {
              const request = report.request;
              const Icon = reportIcons[request.kind];
              const period = analysisPeriod(request);
              const resultPeriod = report.resultRequest
                ? analysisPeriod(report.resultRequest)
                : period;
              const hasResult = report.resultRevision > 0;
              return (
                <div className="weq-analysis-report-row">
                  <button
                    type="button"
                    className="weq-analysis-report-open"
                    aria-label={`查看报告 ${request.name}`}
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const saved = await client.account.analysisReports.get.query({
                          ...binding,
                          id: request.id,
                        });
                        const restored = restoredAnalysisRequest(saved.request);
                        if (!restored) throw new Error('报告对象信息不完整，无法打开。');
                        if (mounted.current) onOpenReport(restored);
                      })
                    }
                  >
                    <span className="weq-analysis-report-name">
                      <Icon size={16} aria-hidden />
                      <strong title={request.name}>{request.name}</strong>
                      <span>{ANALYSIS_LABELS[request.kind]}</span>
                    </span>
                    <span className="weq-analysis-report-detail" title={reportIdentity(request)}>
                      {reportIdentity(request)}
                    </span>
                    <span className="weq-analysis-report-detail" title={resultPeriod}>
                      {hasResult ? '结果范围' : '分析范围'}：{hasResult ? resultPeriod : period}
                    </span>
                    {hasResult && resultPeriod !== period ? (
                      <span className="weq-analysis-report-detail" title={period}>
                        本次范围：{period}
                      </span>
                    ) : null}
                    <span className="weq-analysis-report-meta">
                      <span>
                        {hasResult ? `已保存 · 版本 ${report.resultRevision}` : '暂无已保存结果'}
                        {report.status !== 'completed' ? ` · ${reportStatus[report.status]}` : ''}
                      </span>
                      <span>
                        更新于{' '}
                        <TimeLabel value={report.updatedAt}>
                          {eventTimeFormatter.format(new Date(report.updatedAt))}
                        </TimeLabel>
                      </span>
                    </span>
                  </button>
                  <button
                    data-danger="outline"
                    type="button"
                    className="weq-set-iconbtn"
                    title="删除报告"
                    aria-label={`删除报告 ${request.name}`}
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        if (
                          !(await dialog.confirm(
                            '删除报告',
                            `删除「${request.name}」的分析报告及全部结果版本？${report.status === 'running' ? '正在进行的分析也会停止。' : ''}聊天记录不变。`,
                            { danger: 'outline' },
                          ))
                        )
                          return;
                        await client.account.analysisReports.remove.mutate({
                          ...binding,
                          id: request.id,
                        });
                        await query.refetch();
                      })
                    }
                  >
                    <Trash2 size={16} aria-hidden />
                  </button>
                </div>
              );
            }}
          />
        ) : !loadError ? (
          <p className="weq-analysis-reports-empty">
            {query.data?.length ? '没有匹配的分析报告' : '暂无分析报告'}
          </p>
        ) : null}
      </div>
      <footer className="weq-analysis-reports-footer">
        <span role="status">
          {reports.length} / {query.data?.length ?? 0} 份
        </span>
        <span>按更新时间倒序</span>
      </footer>
    </section>
  );
}
