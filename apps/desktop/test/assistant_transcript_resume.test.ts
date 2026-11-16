import { expect, it } from 'vitest';
import {
  applyAssistantStep,
  persistedAssistantTurn,
} from '../src/renderer/src/views/agentlab/assistantTranscript';

it('载入运行中正文后增量接在末尾，错误和停止均保留全部文本', () => {
  const turn = persistedAssistantTurn({
    id: 'a',
    role: 'assistant',
    text: '已保留\n\n',
    status: 'running',
    ts: 1,
    steps: [{ kind: 'error', message: '之前的错误' }],
  });
  expect(turn.error).toBeUndefined();
  const next = applyAssistantStep(turn, { kind: 'text_delta', text: '续写' });
  expect(next.streamingText).toBe('已保留\n\n续写');
  expect(applyAssistantStep(next, { kind: 'aborted' }).text).toBe(next.streamingText);
  expect(applyAssistantStep(next, { kind: 'error', message: '网络错误' }).text).toBe(
    next.streamingText,
  );
});

it('恢复后经过工具边界的新段落不会重复拼上旧正文', () => {
  const turn = persistedAssistantTurn({
    id: 'a',
    role: 'assistant',
    text: '已有片段',
    status: 'running',
    ts: 1,
  });
  const tool = applyAssistantStep(turn, { kind: 'tool_call', id: 'tool', name: 'read', args: {} });
  const next = applyAssistantStep(tool, { kind: 'text_delta', text: '工具后的结论' });
  expect(next.streamingText).toBe('工具后的结论');
  expect(next.steps).toContainEqual({ kind: 'thinking', text: '已有片段' });
});
