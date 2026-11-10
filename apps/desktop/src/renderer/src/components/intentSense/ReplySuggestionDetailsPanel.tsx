import { useId, useMemo, useState } from 'react';
import { ChevronDown, RefreshCw, X } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { Modal } from '../Dialog';
import { TaskLogConsole, type TaskLogLine } from '../TaskLogConsole';
import '../../styles/reply-suggestion-details.css';

const timestamp = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`);

export function ReplySuggestionDetailsPanel({
  kind,
  conv,
  id,
  anchor,
  onClose,
}: {
  kind: 'c2c' | 'group';
  conv: string;
  id: string;
  anchor: HTMLButtonElement;
  onClose: () => void;
}) {
  const headingId = useId();
  const [logOpen, setLogOpen] = useState(false);
  const details = trpc.account.intentSense.getSuggestionDetails.useQuery(
    { kind, conv, id },
    {
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      cacheTime: 0,
      retry: false,
    },
  );
  const value = details.data;
  const generation = value?.entry.generation;
  const lines = useMemo((): TaskLogLine[] => {
    if (!value?.trace) return [];
    const ts = value.entry.generation?.startedAt ?? value.entry.createdAt;
    const result: TaskLogLine[] = [];
    const add = (stage: string, text: string, level: TaskLogLine['level'] = 'info') =>
      result.push({ seq: result.length + 1, ts, stage, level, text: `${stage}\n${text}` });
    if (value.trace.prompt) {
      add('System Prompt', value.trace.prompt.system);
      add('User Prompt', value.trace.prompt.user);
    }
    if (value.trace.response !== undefined) add('原始返回', value.trace.response);
    if (value.trace.error) add('请求错误 / 回退原因', value.trace.error, 'error');
    return result;
  }, [value]);
  return (
    <Modal
      presentation="popover"
      anchor={anchor}
      width={560}
      title="推荐回复详情"
      labelledBy={headingId}
      className="weq-int-round-details"
      onClose={onClose}
    >
      <header className="weq-int-round-head">
        <h3 id={headingId}>推荐回复详情</h3>
        <button
          type="button"
          className="weq-int-suggest-refresh"
          title="关闭推荐详情"
          aria-label="关闭推荐详情"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="weq-int-round-body" data-privacy-sensitive>
        {details.isLoading ? (
          <p role="status">正在读取推荐详情…</p>
        ) : details.error ? (
          <div className="weq-int-round-error" role="alert">
            <span>推荐详情读取失败：{details.error.message}</span>
            <button
              type="button"
              className="weq-int-suggest-refresh"
              title="重试读取推荐详情"
              aria-label="重试读取推荐详情"
              disabled={details.isFetching}
              onClick={() => void details.refetch()}
            >
              <RefreshCw size={14} />
            </button>
          </div>
        ) : !value ? (
          <p role="status">本轮推荐记录已不存在。</p>
        ) : (
          <>
            <section className="weq-int-round-summary">
              <h4>模型概括</h4>
              <p>
                {value.entry.summary ??
                  (generation?.source === 'local' || generation?.source === 'fallback'
                    ? '本轮使用本地候选，没有模型概括。'
                    : '未记录')}
              </p>
            </section>
            <dl className="weq-int-round-meta">
              <div>
                <dt>生成时间</dt>
                <dd>{timestamp.format(value.entry.createdAt)}</dd>
              </div>
              <div>
                <dt>候选来源</dt>
                <dd>
                  {generation
                    ? (
                        {
                          api: '模型生成',
                          local: '本地规则候选',
                          fallback: '模型不可用，回退本地候选',
                        } as const
                      )[generation.source]
                    : '未记录'}
                </dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>
                  {generation?.model ?? (generation?.source === 'local' ? '未使用模型' : '未记录')}
                </dd>
              </div>
              <div>
                <dt>供应商</dt>
                <dd>
                  {generation?.providerName ??
                    generation?.providerId ??
                    (generation?.source === 'local' ? '未使用供应商' : '未记录')}
                </dd>
              </div>
              <div>
                <dt>请求耗时</dt>
                <dd>
                  {generation?.requestDurationMs !== undefined
                    ? duration(generation.requestDurationMs)
                    : generation?.source === 'local'
                      ? '未发起模型请求'
                      : '未记录'}
                </dd>
              </div>
              <div>
                <dt>总耗时</dt>
                <dd>{generation ? duration(generation.durationMs) : '未记录'}</dd>
              </div>
              <div>
                <dt>输入消息</dt>
                <dd>{generation ? `${generation.inputMessages} 条` : '未记录'}</dd>
              </div>
              {generation?.usage ? (
                <>
                  <div>
                    <dt>输入 Token</dt>
                    <dd>{generation.usage.promptTokens ?? '未记录'}</dd>
                  </div>
                  <div>
                    <dt>输出 Token</dt>
                    <dd>{generation.usage.completionTokens ?? '未记录'}</dd>
                  </div>
                  <div>
                    <dt>总 Token</dt>
                    <dd>{generation.usage.totalTokens ?? '未记录'}</dd>
                  </div>
                </>
              ) : null}
            </dl>
            <section className="weq-int-round-log">
              <button
                type="button"
                className="weq-int-round-log-toggle"
                aria-expanded={logOpen}
                onClick={() => setLogOpen((open) => !open)}
              >
                <ChevronDown size={14} className={logOpen ? 'is-open' : ''} />
                请求日志
              </button>
              {logOpen ? (
                lines.length ? (
                  <TaskLogConsole lines={lines} collapsed={false} scrollable autoFollow={false} />
                ) : (
                  <p>未记录</p>
                )
              ) : null}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
