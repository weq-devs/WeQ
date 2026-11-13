import { memo } from 'react';
import { Play, RotateCcw } from 'lucide-react';
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

export interface AssistantReplyActions {
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
      {turn.status === 'stopped' ? <p role="status">已停止</p> : null}
      {actions ? (
        <div className="weq-conversation-tools">
          {actions.onContinue ? (
            <button type="button" className="weq-set-btn" onClick={actions.onContinue}>
              <Play size={14} />
              继续当前任务并恢复队列
            </button>
          ) : null}
          {actions.onRestore ? (
            <button type="button" className="weq-set-btn" onClick={actions.onRestore}>
              <RotateCcw size={14} />
              重新编辑消息
            </button>
          ) : null}
          {actions.onNext ? (
            <button type="button" className="weq-set-btn" onClick={actions.onNext}>
              <Play size={14} />
              跳过当前任务并执行下一条
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
