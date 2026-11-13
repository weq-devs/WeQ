import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantPanel } from '../src/renderer/src/views/agentlab/AssistantPanel';
import { applyAssistantStep } from '../src/renderer/src/views/agentlab/assistantTranscript';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import { PageSnapshots } from '../src/renderer/src/components/PageSnapshots';
import { DialogHost } from '../src/renderer/src/components/Dialog';
import { requests } from './browser/unified-conversation.stub';
import { conversationExportSelection } from '../src/renderer/src/lib/conversationActions';
import { conversationBatchTargets } from '../src/shared/content_selection';
import { feedConversationRow } from '../src/renderer/src/lib/conversationDirectoryRows';

vi.mock('../src/renderer/src/trpc/client', () => import('./browser/unified-conversation.stub'));
afterEach(() => vi.unstubAllGlobals());

it('助手实际控制器直接渲染共用页、编辑器和六组自动保存设置', async () => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(
          PageSnapshots,
          { scope: 'assistant-unified-test' },
          h(
            ContentSelectionProvider,
            null,
            h(DialogHost),
            h(AssistantPanel, {
              sessionId: 'session',
              chatModels: [],
              onBack() {},
              onSessionCreated() {},
              workspaceTitle: '独立助手会话',
            }),
          ),
        ),
      ),
    );
    expect(host.querySelector('.chat-pane .chat-header')?.textContent).toContain('独立助手会话');
    expect(
      host.querySelector('.chat-pane .composer-editor[contenteditable="true"]'),
    ).not.toBeNull();
    expect(host.querySelector('.weq-agentlab-transcript')).toBeNull();
    expect(host.querySelector('.weq-asst-composer')).toBeNull();
    expect(host.querySelector('[aria-label="运行中发送方式"]')).toBeNull();
    const effort = host.querySelector<HTMLSelectElement>('select[aria-label="思考等级"]')!;
    expect([...effort.options].map((option) => option.value)).toEqual(['off', 'minimal', 'high']);
    expect([...effort.options].map((option) => option.textContent)).toEqual([
      '不指定',
      'minimal',
      'high',
    ]);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="助手设置"]')!.click(),
    );
    expect(document.querySelectorAll('.weq-cvs-nav-item')).toHaveLength(6);
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('.weq-cvs-nav-item')]
        .find((item) => item.textContent?.includes('任务执行'))!
        .click(),
    );
    const limit = document.querySelector<HTMLInputElement>('[aria-label="任务最大轮数"]')!;
    expect(limit.value).toBe('24');
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('.weq-cvs-body-scroll input[type="checkbox"]')!
        .click(),
    );
    expect(
      requests.some(
        (call) =>
          call.name === 'setAssistantConfig' &&
          (call.input as { maxRounds?: number | null }).maxRounds === null,
      ),
    ).toBe(true);
    expect(limit.disabled).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('.weq-cvs-close')!.click());
    const editor = host.querySelector<HTMLDivElement>('.composer-editor')!;
    await act(async () => {
      editor.textContent = '使用默认发送行为';
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.composer-send')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const sent = requests.findLast((call) => call.name === 'submitAssistantMessage');
    expect(sent).toBeDefined();
    expect(sent!.input).not.toHaveProperty('mode');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
it('流式正文不复制历史步骤数组，也不修改原回合对象', () => {
  const turn = {
    id: 'm',
    role: 'assistant' as const,
    text: '',
    ts: 1,
    running: true,
    steps: [{ kind: 'thinking' as const, text: '已有步骤' }],
  };
  const next = applyAssistantStep(turn, { kind: 'text_delta', text: '第一段' });
  expect(next.steps).toBe(turn.steps);
  expect(turn).not.toHaveProperty('streamingText');
  const result = applyAssistantStep(next, {
    kind: 'tool_call',
    id: 'tool',
    name: 'read',
    args: {},
  });
  expect(result.steps).not.toBe(turn.steps);
  expect(turn.steps).toHaveLength(1);
});
it.each(['official', 'service'] as const)('特殊来源 %s 的精确导出不退化为普通私聊目标', (kind) => {
  const conversation = feedConversationRow(
    { id: kind === 'service' ? '77' : 'u_official', name: '合成来源', sendTime: '1', prompt: null },
    kind,
  );
  const selection = conversationExportSelection(conversation)!;
  const targets = conversationBatchTargets({
    ...selection,
    scope: { type: 'items', ids: ['-2', '1'] },
  });
  expect(targets).toEqual([
    {
      id: conversation.id,
      name: '合成来源',
      kind,
      ownerId: kind === 'service' ? '77' : 'u_official',
      messageIds: ['-2', '1'],
    },
  ]);
});
