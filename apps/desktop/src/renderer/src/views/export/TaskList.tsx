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

export type StageStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

/** One failed media file, surfaced from a stage's `failures`. */
export interface UiFailure {
  stage: string;
  fileName: string;
  error: string;
}

export interface UiStage {
  key: string;
  label: string;
  status: StageStatus;
  current: number;
  total: number;
  failed?: number;
  note?: string;
  failures?: UiFailure[];
}

/** The CDN-completion stages (download missing → bundle). */
const COMPLETION_KEYS = new Set(['image', 'video', 'file']);

/** Aggregate completion (image/video/file) success / fail across a task's stages. */
function completionSummary(stages: UiStage[] | undefined): {
  ok: number;
  failed: number;
  failures: UiFailure[];
} {
  let ok = 0;
  let failed = 0;
  const failures: UiFailure[] = [];
  for (const s of stages ?? []) {
    if (!COMPLETION_KEYS.has(s.key)) continue;
    failed += s.failed ?? 0;
    // ok = total processed minus failed (only meaningful once the stage ran).
    if (s.status === 'completed') ok += Math.max(0, s.total - (s.failed ?? 0));
    if (s.failures) failures.push(...s.failures);
  }
  return { ok, failed, failures };
}

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
  /** Per-stage progress (message → media → record → image …). */
  stages?: UiStage[];
}

/** Percent for one stage's bar. */
function stagePct(s: UiStage): number {
  if (s.status === 'completed' || s.status === 'skipped') return 100;
  if (s.status === 'pending' || s.total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((s.current / s.total) * 100)));
}

/**
 * Stages to mount: everything that has started — running / failed plus the
 * already-finished ones (completed / skipped). Finished rows stay mounted so
 * they can play their collapse-up animation instead of popping out of the DOM.
 * Pending stages aren't mounted yet; they animate in when they start. Order is
 * preserved.
 */
function mountedStages(stages: UiStage[]): UiStage[] {
  return stages.filter((s) => s.status !== 'pending');
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

/** One stage's row: label + mini progress bar + note, for a media bundle task. */
function StageRow({ stage }: { stage: UiStage }): ReactElement {
  const pct = stagePct(stage);
  // Finished stages collapse upward (CSS animates them out) instead of vanishing.
  const collapsed = stage.status === 'completed' || stage.status === 'skipped';
  return (
    <div className={`weq-exp-stage is-${stage.status}${collapsed ? ' is-collapsed' : ''}`}>
      <span className="weq-exp-stage-label">{stage.label}</span>
      <span className="weq-exp-stage-bar">
        <span
          className={`weq-exp-stage-fill${stage.status === 'running' ? ' is-active' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="weq-exp-stage-note">
        {stage.status === 'skipped' ? (stage.note ?? '已跳过') : stage.note ?? `${pct}%`}
      </span>
    </div>
  );
}

export function TaskList({
  tasks,
  onPause,
  onCancel,
  onDownload,
  onDelete,
  onShowFailures,
}: {
  tasks: UiTask[];
  onPause: (t: UiTask) => void;
  onCancel: (t: UiTask) => void;
  onDownload: (t: UiTask) => void;
  onDelete: (t: UiTask) => void;
  /** Open the failure-detail lightbox for a task's media-completion failures. */
  onShowFailures: (t: UiTask, failures: UiFailure[]) => void;
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
            // Multi-stage view only for in-progress media bundles; a finished or
            // single-stage task keeps the compact single bar.
            const multiStage =
              !!t.stages &&
              t.stages.length > 1 &&
              (t.status === 'running' || t.status === 'paused');
            const shownStages = multiStage ? mountedStages(t.stages!) : [];
            const completion = completionSummary(t.stages);
            const hasCompletion = completion.ok > 0 || completion.failed > 0;
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

                  {multiStage ? (
                    <div className="weq-exp-stages">
                      {shownStages.map((s) => (
                        <StageRow key={s.key} stage={s} />
                      ))}
                    </div>
                  ) : (
                    <div className="weq-exp-task-bar">
                      <span
                        className={`weq-exp-task-fill${t.status === 'running' ? ' is-active' : ''}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}

                  <div className="weq-exp-task-sub">
                    <span>
                      {fmtCount(t.current)}
                      {t.total > 0 ? ` / ${fmtCount(t.total)}` : ''} 条
                      {t.avatarCount ? ` · 含头像 ${fmtCount(t.avatarCount)}` : ''}
                    </span>
                    {hasCompletion ? (
                      completion.failed > 0 && completion.failures.length > 0 ? (
                        <button
                          type="button"
                          className="weq-exp-task-complete is-clickable"
                          title="点击查看失败详情"
                          onClick={() => onShowFailures(t, completion.failures)}
                        >
                          媒体补全 成功 {fmtCount(completion.ok)} · 失败 {fmtCount(completion.failed)}
                        </button>
                      ) : (
                        <span
                          className={`weq-exp-task-complete${completion.failed > 0 ? ' is-warn' : ''}`}
                          title="媒体补全结果"
                        >
                          媒体补全 成功 {fmtCount(completion.ok)}
                          {completion.failed > 0 ? ` · 失败 ${fmtCount(completion.failed)}` : ''}
                        </span>
                      )
                    ) : null}
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
