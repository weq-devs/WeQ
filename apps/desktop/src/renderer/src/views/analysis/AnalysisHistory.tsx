import { useState } from 'react';
import { FolderOpen, Trash2 } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useDialog } from '../../components/Dialog';

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
  const [visible, setVisible] = useState(20);
  if (!query.data?.length && !query.error) return null;
  return (
    <section className="weq-analysis-history" aria-label="历史分析报告">
      <h3>历史报告</h3>
      {error || query.error ? <p role="alert">{error || query.error?.message}</p> : null}
      {query.data?.slice(0, visible).map((report) => (
        <div className="weq-saved-analysis-status" key={report.request.id}>
          <button
            type="button"
            className="weq-set-btn"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('weq:open-saved-analysis', { detail: report.request.id }),
              )
            }
          >
            <FolderOpen size={16} />
            {report.request.name} · {report.request.period}
          </button>
          <time>
            {new Date(report.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
          </time>
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
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      {(query.data?.length ?? 0) > visible ? (
        <button
          type="button"
          className="weq-set-btn"
          onClick={() => setVisible((value) => value + 20)}
        >
          加载更多
        </button>
      ) : null}
    </section>
  );
}
