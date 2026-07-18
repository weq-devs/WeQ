/**
 * 克隆进度灯箱：展示单个克隆任务的进度，可隐藏到左下角任务列表（构建在后台继续）。
 *
 * 与「新建克隆」弹窗解耦——构建态由 AgentLabView 持有，关掉灯箱不会中断构建。
 *   running → 进度条 + 「隐藏到任务列表」
 *   done    → 「查看克隆体」
 *   error   → 错误信息 + 「关闭」
 */

import type { ReactElement } from 'react';
import { Minus, Sparkles } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import type { CloneTask } from './cloneTaskStore';

export type { CloneTask } from './cloneTaskStore';

export function CloneProgressModal({
  task,
  onHide,
  onOpenPersona,
  onDismiss,
}: {
  task: CloneTask;
  /** 隐藏灯箱（构建继续，停留在任务列表）。 */
  onHide: () => void;
  /** 构建完成后查看克隆体。 */
  onOpenPersona: (personaId: string) => void;
  /** 失败后关闭并移除任务。 */
  onDismiss: (personaId: string) => void;
}): ReactElement {
  const running = task.status === 'running';
  const title = task.status === 'done' ? '克隆完成' : task.status === 'error' ? '克隆失败' : '正在克隆…';

  return (
    <Modal onClose={onHide} width={460}>
      <div className="weq-clone-modal">
        <header className="weq-clone-modal-head">
          <span className="weq-clone-modal-icon"><Sparkles size={16} /></span>
          <strong>{title}：{task.name}</strong>
          {running ? (
            <button
              type="button"
              className="weq-set-iconbtn weq-clone-min"
              onClick={onHide}
              title="隐藏到任务列表"
              aria-label="隐藏到任务列表"
            >
              <Minus size={16} />
            </button>
          ) : null}
        </header>

        <div className="weq-clone-progress">
          {task.status === 'error' ? (
            <div className="weq-clone-progress-phase">{task.error || '构建失败'}</div>
          ) : (
            <>
              <div className="weq-clone-progress-phase">{task.phase}</div>
              <div className="weq-clone-progress-track">
                <div className="weq-clone-progress-fill" style={{ width: `${task.percent}%` }} />
              </div>
              <div className="weq-clone-progress-pct">{Math.round(task.percent)}%</div>
            </>
          )}
          <p className="weq-clone-progress-hint">
            {running
              ? task.mode === 'group'
                ? '私聊为主，语料不足时会到 TA 所在群补采风格，可隐藏到左下角任务列表后台继续。'
                : '正在分析你和 TA 的私聊记录，可隐藏到任务列表继续等待…'
              : task.status === 'done'
                ? 'TA 的克隆体已经准备好啦~'
                : '可关闭后重新发起克隆。'}
          </p>
          <div className="weq-clone-actions">
            {running ? (
              <button type="button" className="weq-set-btn weq-set-btn-soft" onClick={onHide}>
                隐藏到任务列表
              </button>
            ) : task.status === 'done' ? (
              <button type="button" className="weq-set-btn" onClick={() => onOpenPersona(task.personaId)}>
                查看克隆体
              </button>
            ) : (
              <button type="button" className="weq-set-btn weq-set-btn-soft" onClick={() => onDismiss(task.personaId)}>
                关闭
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
