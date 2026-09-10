/**
 * WeQ 助手「调查过程」的三个展示组件：
 * - AssistantPlanPanel：调查计划面板（模型调 update_investigation_plan 后更新），
 *   展示对问题的理解 + 分步计划与状态；
 * - AssistantNotesPanel：工作笔记折叠块（模型调 update_work_notes 后更新），
 *   长任务里模型记下的关键事实/待查项，给用户观察调查在关注什么；
 * - AssistantCompactionMarker：上下文压缩标记——长会话里早期历史被折叠成摘要时显示，
 *   点开可回看摘要（借鉴 WeFlow CompactionMarker）。
 */

import { useState, type ReactElement } from 'react';
import { ChevronDown, ChevronRight, ListChecks, NotebookPen, ScrollText } from 'lucide-react';
import type { AssistantInvestigationPlan } from '@weq/service';

export function AssistantPlanPanel({ plan }: { plan: AssistantInvestigationPlan }): ReactElement {
  return (
    <div className="weq-asst-plan">
      <div className="weq-asst-plan-head">
        <ListChecks size={13} />
        <span>调查计划</span>
        {plan.title ? <em className="weq-asst-plan-title">{plan.title}</em> : null}
      </div>
      {plan.question ? <div className="weq-asst-plan-question">{plan.question}</div> : null}
      {plan.steps.length > 0 ? (
        <ol className="weq-asst-plan-steps">
          {plan.steps.map((step) => (
            <li key={step.id} className={`weq-asst-plan-step is-${step.status}`}>
              <span className="weq-asst-plan-mark" aria-hidden>
                {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '▶' : '○'}
              </span>
              <span className="weq-asst-plan-step-title">{step.title}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function AssistantNotesPanel({
  notes,
  running,
}: {
  notes: string[];
  running: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className={`weq-asst-notes${running ? ' is-running' : ''}`}>
      <button
        type="button"
        className="weq-asst-notes-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <NotebookPen size={12} />
        <span>工作笔记 · {notes.length} 条</span>
      </button>
      {open ? (
        <ul className="weq-asst-notes-body">
          {notes.map((note, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 笔记按顺序展示,无稳定唯一键
            <li key={i}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AssistantCompactionMarker({
  summary,
  foldedTurns,
}: {
  summary: string;
  foldedTurns: number;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="weq-asst-compaction">
      <button
        type="button"
        className="weq-asst-compaction-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <ScrollText size={12} />
        <span>较早内容已压缩 {foldedTurns > 0 ? `（${foldedTurns} 轮历史）` : ''}，点开看摘要</span>
      </button>
      {open ? <div className="weq-asst-compaction-body">{summary}</div> : null}
    </div>
  );
}
