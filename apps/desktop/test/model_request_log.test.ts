import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { formatModelLogText, suggestionLogBlocks } from '../src/renderer/src/lib/modelRequestLog';
import { ModelRequestLog } from '../src/renderer/src/components/ModelRequestLog';

vi.mock('../src/renderer/src/views/agentlab/shikiHighlighter', () => ({
  shikiCodeHighlighter: { getThemes: () => [], highlight: () => null },
}));
let dispose = () => {};
afterEach(() => {
  dispose();
  dispose = () => {};
  vi.unstubAllGlobals();
});

it('完整对象、数组与 JSON 围栏格式化，生成中、截断、超长和普通文本保持原样', () => {
  for (const raw of [
    '{"replies":["你好"]}',
    '[{"text":"你好"}]',
    '```json\n{"tone":"自然"}\n```',
  ]) {
    const formatted = formatModelLogText(raw);
    expect(formatted.json).toBe(true);
    expect(formatted.text).toContain('\n  ');
    expect(formatModelLogText(raw, true)).toEqual({ text: raw, json: false });
  }
  for (const raw of ['{"text":', '原文\\n不换行', '说明\n{"x":1}', '9', 'x'.repeat(128_001)])
    expect(formatModelLogText(raw)).toEqual({ text: raw, json: false });
});

it('历史响应内嵌 JSON 正文独立展示，提示词和原始响应可折叠，不重复生成正文', () => {
  const response = JSON.stringify({
    choices: [{ message: { content: '{"replies":["你好"]}', reasoning_content: '合成推理' } }],
  });
  const raw = {
    seq: 2,
    ts: 1,
    stage: '原始返回',
    text: `原始返回\n${response}`,
    level: 'info' as const,
  };
  const blocks = suggestionLogBlocks([
    { seq: 1, ts: 1, stage: 'System Prompt', text: 'System Prompt\n合成提示词', level: 'info' },
    raw,
  ]);
  expect(blocks.map((block) => block.label)).toEqual([
    'System Prompt',
    '模型正文',
    '推理输出',
    '原始返回',
  ]);
  expect(blocks[0]).toMatchObject({ text: '合成提示词', collapsed: true, format: 'text' });
  expect(blocks.at(-1)?.text).toBe(response);
  expect(
    suggestionLogBlocks([{ ...raw, stage: '模型正文', text: '已有正文' }, raw]).filter(
      (block) => block.label === '模型正文',
    ),
  ).toHaveLength(1);
  expect(
    suggestionLogBlocks([{ ...raw, stage: '模型正文', text: '模型正文\n原始内容' }])[0]?.text,
  ).toBe('模型正文\n原始内容');
});

it('共享日志生成中原样更新、完成后格式化，可切回原文且模型文本不执行 HTML', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  dispose = () => {
    act(() => root.unmount());
    host.remove();
  };
  const text = '{"reply":"<img src=x onerror=alert(1)>"}';
  const blocks = [{ id: 'a', label: '模型正文', text }];
  act(() => root.render(h(ModelRequestLog, { blocks, running: true })));
  expect(host.querySelector('pre')?.textContent).toBe(text);
  act(() => root.render(h(ModelRequestLog, { blocks, running: false })));
  expect(host.querySelector('pre')?.textContent).toContain('\n  "reply": ');
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="模型正文：查看原文"]')!.click());
  expect(host.querySelector('pre')?.textContent).toBe(text);
  expect(host.querySelector('img')).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="模型正文：格式化 JSON"]')!.click());
  expect(host.querySelector('pre')?.textContent).toContain('\n  "reply": ');
});
