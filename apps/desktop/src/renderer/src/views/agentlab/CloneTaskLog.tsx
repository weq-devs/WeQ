import { useMemo, useState } from 'react';
import { SegmentedControl } from '../../components/SegmentedControl';
import { ModelRequestLog } from '../../components/ModelRequestLog';
import type { ModelLogBlock } from '../../lib/modelRequestLog';
import type { CloneTask } from './cloneTaskStore';
import '../../styles/clone-task-log.css';

const statuses = { running: '生成中', success: '完成', failed: '失败', cancelled: '已取消' };

export function CloneTaskLog({ task }: { task: CloneTask }) {
  const [selected, setSelected] = useState<string | null>(null);
  const logs = task.outputs ?? [];
  const log = logs.find((item) => item.requestId === selected) ?? logs[0];
  const blocks = useMemo(
    (): ModelLogBlock[] =>
      log
        ? [
            ...(log.reasoning
              ? [
                  {
                    id: 'reasoning',
                    label: '推理输出',
                    text: log.reasoning,
                    collapsed: true,
                    format: 'text' as const,
                  },
                ]
              : []),
            {
              id: 'content',
              label: '模型正文',
              text: log.content || (log.status === 'running' ? '等待正文…' : '无正文输出'),
            },
          ]
        : [],
    [log],
  );
  return (
    <section className="weq-clone-task-log" aria-label="克隆任务日志">
      <h3>模型输出</h3>
      {!log ? (
        <p className="text-muted-foreground">暂无模型输出</p>
      ) : (
        <>
          {logs.length > 1 ? (
            <SegmentedControl
              label="模型请求"
              value={log.requestId}
              options={logs.map((item, index) => ({
                value: item.requestId,
                label: `${index + 1}. ${item.feature}`,
                title: `${item.model} · ${statuses[item.status]}`,
              }))}
              onChange={setSelected}
            />
          ) : null}
          <div className="weq-clone-task-log-meta">
            <span>
              {log.feature} · {log.model}
            </span>
            <span>{statuses[log.status]}</span>
          </div>
          {log.truncated ? <p>仅保留最近输出</p> : null}
          <ModelRequestLog key={log.requestId} blocks={blocks} running={log.status === 'running'} />
          {log.error ? <p role="alert">{log.error}</p> : null}
        </>
      )}
    </section>
  );
}
