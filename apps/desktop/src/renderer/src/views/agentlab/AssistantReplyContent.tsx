import { memo } from 'react';
import { Play, RotateCcw, Square } from 'lucide-react';
import { AiImageGallery } from '../../components/AiImageComposer';
import { AssistantMessage } from './AssistantMessage';
import { AssistantSteps } from './AssistantSteps';
import { AssistantArtifactCard } from './AssistantArtifactCard';
import {
  AssistantPlanPanel,
  AssistantNotesPanel,
  AssistantCompactionMarker,
} from './AssistantWorkspace';
import type { AssistantTurn } from './assistantTranscript';
import '../../styles/assistant-reply-controls.css';

export interface AssistantReplyActions {
  onStop?: () => void;
  stopping?: boolean;
  recovering?: boolean;
  onContinue?: () => void;
  onRestore?: () => void;
  onNext?: () => void;
}
export const AssistantReplyContent = memo(function AssistantReplyContent({
  turn,
  actions,
}: {
  turn: AssistantTurn;
  actions?: AssistantReplyActions;
}) {
  if (turn.role === 'user')
    return (
      <div className="message-content">
        <AiImageGallery images={turn.images} outcomes={turn.imageOutcomes} />
        <AssistantMessage text={turn.text} />
      </div>
    );
  const steps = turn.steps ?? [];
  const plan = steps.findLast((step) => step.kind === 'plan');
  const notes = steps.findLast((step) => step.kind === 'notes');
  const compaction = steps.findLast((step) => step.kind === 'compaction');
  const body = turn.running ? turn.streamingText || turn.text : turn.text;
  return (
    <div className="message-content weq-asst-content">
      {plan?.kind === 'plan' ? <AssistantPlanPanel plan={plan.plan} /> : null}
      <AssistantSteps steps={steps} running={Boolean(turn.running)} reasoning={turn.reasoning} />
      {body ? (
        <AssistantMessage text={body} streaming={Boolean(turn.running)} />
      ) : turn.running ? (
        <span role="status">正在思考…</span>
      ) : null}
      {notes?.kind === 'notes' ? (
        <AssistantNotesPanel notes={notes.notes} running={Boolean(turn.running)} />
      ) : null}
      {compaction?.kind === 'compaction' ? (
        <AssistantCompactionMarker
          summary={compaction.summary}
          foldedTurns={compaction.foldedTurns}
        />
      ) : null}
      {steps.map((step) =>
        step.kind === 'artifact' ? (
          <AssistantArtifactCard key={step.artifact.id} artifact={step.artifact} />
        ) : null,
      )}
      {turn.error ? <p role="alert">{turn.error}</p> : null}
      {actions?.onStop || actions?.onContinue || turn.status === 'stopped' ? (
        <div className="weq-asst-run-controls" aria-label="回复控制">
          {turn.status === 'stopped' && !turn.running ? <span role="status">已停止</span> : null}
          {actions?.onStop ? (
            <button
              type="button"
              className="weq-asst-run-button"
              aria-label={actions.stopping ? '正在停止输出' : '停止输出'}
              title={actions.stopping ? '正在停止输出' : '停止输出'}
              disabled={actions.stopping}
              onClick={actions.onStop}
            >
              <Square size={12} fill="currentColor" aria-hidden="true" />
            </button>
          ) : actions?.onContinue ? (
            <button
              type="button"
              className="weq-asst-run-button"
              aria-label={actions.recovering ? '正在恢复输出' : '恢复输出'}
              title={actions.recovering ? '正在恢复输出' : '恢复输出'}
              disabled={actions.recovering}
              onClick={actions.onContinue}
            >
              <Play size={15} fill="currentColor" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      {actions?.onRestore || actions?.onNext ? (
        <div className="weq-conversation-tools">
          {actions.onRestore ? (
            <button type="button" className="weq-set-btn" onClick={actions.onRestore}>
              <RotateCcw size={14} />
              重新编辑消息
            </button>
          ) : null}
          {actions.onNext ? (
            <button
              type="button"
              className="weq-set-btn"
              disabled={actions.recovering}
              onClick={actions.onNext}
            >
              <Play size={14} />
              跳过当前任务并执行下一条
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
