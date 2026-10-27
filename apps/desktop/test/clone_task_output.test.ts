import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CloneTaskLog } from '../src/renderer/src/views/agentlab/CloneTaskLog';
import {
  appendCloneOutput,
  CLONE_LOG_REQUEST_LIMIT,
  CLONE_LOG_TEXT_LIMIT,
} from '../src/renderer/src/views/agentlab/cloneTaskOutput';
import type { CloneTask } from '../src/renderer/src/views/agentlab/cloneTaskStore';

let dispose = () => {};
afterEach(() => {
  dispose();
  dispose = () => {};
  vi.unstubAllGlobals();
});
const event = { requestId: 'a', feature: '画像卡', model: 'fixture', status: 'running' as const };

it('并发输出按请求 ID 分开，文本和保留请求数有界，更新不改变原快照', () => {
  const first = appendCloneOutput([], { ...event, channel: 'content', text: '甲' });
  const second = appendCloneOutput(first, {
    ...event,
    requestId: 'b',
    channel: 'reasoning',
    text: '乙',
  });
  const third = appendCloneOutput(second, {
    ...event,
    channel: 'content',
    text: '丙'.repeat(CLONE_LOG_TEXT_LIMIT),
  });
  expect(first[0]?.content).toBe('甲');
  expect(third[0]).toMatchObject({ content: '丙'.repeat(CLONE_LOG_TEXT_LIMIT), truncated: true });
  expect(third[1]?.reasoning).toBe('乙');
  let logs = third;
  for (let i = 0; i < CLONE_LOG_REQUEST_LIMIT; i++)
    logs = appendCloneOutput(logs, { ...event, requestId: `r${i}` });
  expect(logs).toHaveLength(CLONE_LOG_REQUEST_LIMIT);
  expect(logs.some((log) => log.requestId === 'a')).toBe(false);
});

it('分段控件可切换各并发请求、推理与失败日志，模型文本不作为 HTML 执行', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  dispose = () => {
    act(() => root.unmount());
    host.remove();
  };
  const outputs = appendCloneOutput(
    appendCloneOutput([], { ...event, channel: 'content', text: '<img src=x onerror=alert(1)>' }),
    {
      ...event,
      requestId: 'b',
      feature: '对话样本',
      status: 'failed',
      error: '合成错误',
      channel: 'reasoning',
      text: '合成推理',
    },
  );
  const task = { personaId: 'fixture', outputs } as CloneTask;
  act(() => root.render(h(CloneTaskLog, { task })));
  expect(host.querySelector('img')).toBeNull();
  expect(host.querySelector('[aria-label="模型正文"]')?.textContent).toContain('<img');
  const buttons = host.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  act(() =>
    buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  );
  expect(buttons[1]?.getAttribute('aria-checked')).toBe('true');
  expect(host.textContent).toContain('合成推理');
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('合成错误');
  act(() => buttons[0]!.click());
  expect(host.textContent).not.toContain('合成错误');
});
