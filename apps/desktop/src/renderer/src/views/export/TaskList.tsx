/**
 * 底部任务列表。每个任务一张卡片：状态图标 + 名称 + 状态标签 + 进度条 +
 * 进度计数 + 图标操作（暂停 / 下载 / 取消 / 删除）。图标全部来自 lucide。
 */

import type { ReactElement } from 'react';
import {
  Ban,
  CircleAlert,
  CircleCheck,
  Clock,
  Download,
  Loader2,
  Pause,
  Trash2,
  Users,
  UserRound,
  X,
} from 'lucide-react';
import { fmtCount } from './types';

export interface UiTask {
  id: string;
  kind: 'group' | 'c2c';
  name: string;
  format: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  current: number;
  total: number;
  error?: string;
  filePath?: string;
  /** Set when the output is an avatar bundle folder (saved as a folder). */
  bundleDir?: string;
  /** Number of sender avatars exported into the bundle. */
  avatarCount?: number;
}

const STATUS_LABEL: Record<UiTask['status'], string> = {
  pending: '排队中',
  running: '导出中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function StatusIcon({ status }: { status: UiTask['status'] }): ReactElement {
  switch (status) {
    case 'running':
      return <Loader2 size={16} className="weq-exp-spin" />;
    case 'completed':
      return <CircleCheck size={16} />;
    case 'failed':
      return <CircleAlert size={16} />;
    case 'paused':
      return <Pause size={16} />;
    case 'cancelled':
      return <Ban size={16} />;
    default:
      return <Clock size={16} />;
  }
}

export function TaskList({
  tasks,
  onPause,
  onCancel,
  onDownload,
  onDelete,
}: {
  tasks: UiTask[];
  onPause: (t: UiTask) => void;
  onCancel: (t: UiTask) => void;
  onDownload: (t: UiTask) => void;
  onDelete: (t: UiTask) => void;
}): ReactElement {
  return (
    <section className="weq-exp-tasks">
      <header className="weq-exp-tasks-head">
        <span className="weq-exp-tasks-title">导出任务</span>
        <span className="weq-exp-tasks-count">{tasks.length}</span>
      </header>

      <div className="weq-exp-tasks-list">
        {tasks.length === 0 ? (
          <div className="weq-exp-tasks-empty">
            <Download size={26} strokeWidth={1.6} />
            <span>暂无导出任务</span>
            <small>在上方选择会话并开始导出后，任务会出现在这里</small>
          </div>
        ) : (
          tasks.map((t) => {
            const pct = t.status === 'completed' ? 100 : Math.min(100, Math.max(0, t.progress));
            return (
              <article key={t.id} className={`weq-exp-task is-${t.status}`}>
                <span className="weq-exp-task-kind" title={t.kind === 'group' ? '群聊' : '私聊'}>
                  {t.kind === 'group' ? <Users size={16} /> : <UserRound size={16} />}
                </span>

                <div className="weq-exp-task-main">
                  <div className="weq-exp-task-top">
                    <strong className="weq-exp-task-name" title={t.name}>
                      {t.name}
                    </strong>
                    <span className="weq-exp-task-fmt">{t.format.toUpperCase()}</span>
                    <span className={`weq-exp-task-status is-${t.status}`}>
                      <StatusIcon status={t.status} />
                      {t.status === 'running' ? `${pct}%` : STATUS_LABEL[t.status]}
                    </span>
                  </div>

                  <div className="weq-exp-task-bar">
                    <span
                      className={`weq-exp-task-fill${t.status === 'running' ? ' is-active' : ''}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  <div className="weq-exp-task-sub">
                    <span>
                      {fmtCount(t.current)}
                      {t.total > 0 ? ` / ${fmtCount(t.total)}` : ''} 条
                      {t.avatarCount ? ` · 含头像 ${fmtCount(t.avatarCount)}` : ''}
                    </span>
                    {t.status === 'failed' && t.error ? (
                      <span className="weq-exp-task-err" title={t.error}>
                        {t.error}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="weq-exp-task-actions">
                  {t.status === 'running' ? (
                    <button type="button" title="暂停" onClick={() => onPause(t)}>
                      <Pause size={15} />
                    </button>
                  ) : null}
                  {t.status === 'completed' ? (
                    <button type="button" title={t.bundleDir ? '保存文件夹…' : '保存到…'} onClick={() => onDownload(t)}>
                      <Download size={15} />
                    </button>
                  ) : null}
                  {t.status === 'paused' || t.status === 'failed' ? (
                    <button type="button" title="取消" onClick={() => onCancel(t)}>
                      <X size={15} />
                    </button>
                  ) : null}
                  {t.status !== 'running' ? (
                    <button type="button" title="删除" className="is-danger" onClick={() => onDelete(t)}>
                      <Trash2 size={15} />
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
