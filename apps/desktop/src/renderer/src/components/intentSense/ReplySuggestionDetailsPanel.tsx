import { preciseTimeFormatter, formatDuration } from '@weq/time';
import { useEffect, useId, useMemo, useState } from 'react';
import { ChevronDown, RefreshCw, X } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { Modal } from '../Dialog';
import type { TaskLogLine } from '../TaskLogConsole';
import { ModelRequestLog } from '../ModelRequestLog';
import { suggestionLogBlocks } from '../../lib/modelRequestLog';
import '../../styles/reply-suggestion-details.css';

const timestamp = preciseTimeFormatter;
const duration = (ms: number) => formatDuration(ms / 1000, 'elapsed');

export function ReplySuggestionDetailsPanel({
  kind,
  conv,
  id,
  generating = false,
  anchor,
  onClose,
}: {
  kind: 'c2c' | 'group';
  conv: string;
  id?: string;
  generating?: boolean;
  anchor: HTMLButtonElement;
  onClose: () => void;
}) {
  const headingId = useId();
  const [logOpen, setLogOpen] = useState(id === undefined);
  const [roundId, setRoundId] = useState(id);
  const details = trpc.account.intentSense.getSuggestionDetails.useQuery(
    { kind, conv, id: roundId },
    {
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      cacheTime: 0,
      retry: false,
      keepPreviousData: true,
      refetchInterval: (data) =>
        data?.progress?.status === 'running' || (!data && !roundId && generating) ? 500 : false,
    },
  );
  const value = details.data;
  useEffect(() => {
    const resolved = value?.progress?.id ?? value?.entry?.id;
    if (!roundId && resolved) setRoundId(resolved);
  }, [roundId, value?.progress?.id, value?.entry?.id]);
  const progress = value?.progress;
  const running = progress?.status === 'running';
  const generation = value?.entry?.generation;
  const lines = useMemo((): TaskLogLine[] => {
    if (!value?.trace) return [];
    if (value.trace.logs?.length) return value.trace.logs;
    const ts = value.entry?.generation?.startedAt ?? value.entry?.createdAt ?? 0;
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
  const blocks = useMemo(() => suggestionLogBlocks(lines), [lines]);
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
          <p role="status">
            {generating && !roundId ? '正在读取本轮生成状态…' : '本轮推荐记录已不存在。'}
          </p>
        ) : (
          <>
            {progress ? (
              <p role="status" aria-live="polite">
                {progress.stage}
              </p>
            ) : null}
            <section className="weq-int-round-summary">
              <h4>模型概括</h4>
              <p>
                {value.entry?.summary ??
                  (running
                    ? '正在生成，模型概括将在返回后显示。'
                    : progress?.status === 'stopped' || progress?.status === 'failed'
                      ? '本轮未生成模型概括。'
                      : generation?.source === 'local' || generation?.source === 'fallback'
                        ? '本轮使用本地候选，没有模型概括。'
                        : '未记录')}
              </p>
            </section>
            <dl className="weq-int-round-meta">
              <div>
                <dt>生成时间</dt>
                <dd>
                  {value.entry || progress
                    ? timestamp.format(value.entry?.createdAt ?? progress!.startedAt)
                    : '未记录'}
                </dd>
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
                      : running
                        ? '请求进行中'
                        : '未记录'}
                </dd>
              </div>
              <div>
                <dt>总耗时</dt>
                <dd>
                  {running && progress
                    ? duration(progress.updatedAt - progress.startedAt)
                    : generation
                      ? duration(generation.durationMs)
                      : progress
                        ? duration(progress.updatedAt - progress.startedAt)
                        : '未记录'}
                </dd>
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
                  <ModelRequestLog blocks={blocks} running={running} />
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
