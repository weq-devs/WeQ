import { useState } from 'react';
import { FolderOpen, Trash2 } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useDialog } from '../../components/Dialog';
import { WindowedList } from '../../components/WindowedList';

const reportStatus = {
  running: '正在分析',
  paused: '待继续',
  completed: '已保存',
  failed: '分析失败',
  cancelled: '已取消',
};

export function AnalysisHistory({ enabled }: { enabled: boolean }) {
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
    onData: () => {
      void query.refetch();
    },
  });
  const dialog = useDialog();
  const [error, setError] = useState('');
  if (!query.data?.length && !query.error) return null;
  return (
    <section className="weq-analysis-history" aria-label="历史分析报告">
      <h3>历史报告</h3>
      {error || query.error ? <p role="alert">{error || query.error?.message}</p> : null}
      <WindowedList
        items={query.data ?? []}
        rowHeight={58}
        height={Math.min(174, (query.data?.length ?? 0) * 58)}
        itemKey={(report) => report.request.id}
        className="weq-analysis-history-list"
        label="历史分析报告列表"
        renderItem={(report) => (
          <div className="weq-analysis-history-row">
            <button
              type="button"
              className="weq-analysis-choice"
              aria-label={`查看报告 ${report.request.name}`}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('weq:open-saved-analysis', { detail: report.request.id }),
                )
              }
            >
              <FolderOpen size={16} aria-hidden />
              <span className="weq-analysis-choice-body">
                <span className="weq-analysis-choice-name">
                  <strong>{report.request.name}</strong>
                </span>
                <small>
                  {report.request.period} ·{' '}
                  <time dateTime={new Date(report.updatedAt).toISOString()}>
                    {new Date(report.updatedAt).toLocaleString('zh-CN', {
                      timeZone: 'Asia/Shanghai',
                    })}
                  </time>
                </small>
              </span>
              <span className="weq-analysis-choice-time">{reportStatus[report.status]}</span>
            </button>
            <button
              type="button"
              className="weq-set-iconbtn"
              title="删除报告"
              aria-label={`删除报告 ${report.request.name}`}
              onClick={async () => {
                if (
                  !(await dialog.confirm(
                    '删除报告',
                    `删除「${report.request.name}」的分析报告及结果？聊天记录不变。`,
                  ))
                )
                  return;
                try {
                  await client.account.analysisReports.remove.mutate({
                    ...binding,
                    id: report.request.id,
                  });
                  await query.refetch();
                } catch (reason) {
                  setError(String(reason));
                }
              }}
            >
              <Trash2 size={16} aria-hidden />
            </button>
          </div>
        )}
      />
    </section>
  );
}
