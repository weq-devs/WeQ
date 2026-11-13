import type { AssistantStep, ConversationTurn } from '@weq/service';

export interface AssistantTurn extends ConversationTurn {
  running?: boolean;
  streamingText?: string;
  reasoning?: string;
  handoffIndex?: number;
  error?: string;
}
export function persistedAssistantTurn(turn: ConversationTurn): AssistantTurn {
  const error = turn.steps?.findLast((step) => step.kind === 'error');
  return {
    ...turn,
    running: turn.status === 'running',
    error: error?.kind === 'error' ? error.message : undefined,
  };
}
/** 工具边界先保留已显示正文，下一段真正到达时再归档。 */
export function applyAssistantStep(turn: AssistantTurn, step: AssistantStep): AssistantTurn {
  const next = { ...turn, steps: turn.steps ?? [] };
  const commit = () => {
    if (next.handoffIndex === undefined) return;
    if (next.streamingText?.trim()) {
      next.steps = [...next.steps];
      next.steps.splice(next.handoffIndex, 0, { kind: 'thinking', text: next.streamingText });
    }
    next.handoffIndex = undefined;
  };
  switch (step.kind) {
    case 'text_delta': {
      const newSegment = next.handoffIndex !== undefined;
      commit();
      next.streamingText = newSegment ? step.text : (next.streamingText ?? '') + step.text;
      next.running = true;
      break;
    }
    case 'reasoning_delta':
      next.reasoning = (next.reasoning ?? '') + step.text;
      break;
    case 'final':
      commit();
      next.text = step.text;
      next.streamingText = '';
      next.reasoning = '';
      next.running = false;
      next.status = 'complete';
      break;
    case 'aborted':
      commit();
      next.text = next.streamingText?.trim() || next.text || '（已停止）';
      next.running = false;
      next.status = 'stopped';
      break;
    case 'error':
      next.running = false;
      next.status = 'failed';
      next.error = step.message;
      break;
    case 'turn':
    case 'queue':
    case 'reset':
    case 'remove_turn':
      break;
    default:
      if (
        ['tool_call', 'plan', 'notes', 'compaction'].includes(step.kind) &&
        next.handoffIndex === undefined
      )
        next.handoffIndex = next.steps.length;
      next.steps = [...next.steps, step];
  }
  return next;
}
