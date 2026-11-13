/**
 * 助手「多轮思考 + 工具调用」过程的可折叠展示。
 *
 * 运行中默认展开、实时滚动；完成后默认收起（可点开回看）。每一步按 kind 渲染：
 * thinking=思路、tool_call=调用了哪个工具(参数可展开)、tool_result=结果(成功/失败，
 * JSON 预览可展开)。final/error 不在这里展示（final 是主答复气泡，error 走对话框）。
 */

import { memo, useMemo, useState, type ReactElement } from 'react';
import { Brain, Check, ChevronDown, ChevronRight, Loader2, Wrench, X, Copy } from 'lucide-react';
import { copyTextToClipboard } from '../../im-template/template/clipboard';
import type { AssistantStep } from '@weq/service';

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('  ')
    .slice(0, 160);
}

function ToolResult({ preview, ok }: { preview: string; ok: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  const oneLine = preview.replace(/\s+/g, ' ').trim();
  return (
    <div className="weq-asst-step-result">
      <button type="button" className="weq-asst-step-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className={`weq-asst-step-icon ${ok ? 'is-ok' : 'is-err'}`}>
          {ok ? <Check size={12} /> : <X size={12} />}
        </span>
        <span className="weq-asst-step-preview">{oneLine || (ok ? '（空结果）' : '失败')}</span>
      </button>
      {open ? <pre className="weq-asst-step-json">{preview}</pre> : null}
      {open ? (
        <button
          type="button"
          className="icon-button"
          title="复制工具结果"
          aria-label="复制工具结果"
          onClick={() => void copyTextToClipboard(preview)}
        >
          <Copy size={13} />
        </button>
      ) : null}
    </div>
  );
}

export const AssistantSteps = memo(function AssistantSteps({
  steps,
  running,
  reasoning,
}: {
  steps: AssistantStep[];
  running: boolean;
  /** 运行中逐字累积的推理内容（reasoning_delta）；有则在过程面板顶部展示。 */
  reasoning?: string;
}): ReactElement | null {
  // 只展示过程类步骤。
  const calls = useMemo(
    () => new Set(steps.filter((step) => step.kind === 'tool_call').map((step) => step.id)),
    [steps],
  );
  const results = useMemo(
    () =>
      new Map(steps.filter((step) => step.kind === 'tool_result').map((step) => [step.id, step])),
    [steps],
  );
  const shown = steps.filter(
    (s) =>
      s.kind === 'thinking' ||
      s.kind === 'tool_call' ||
      (s.kind === 'tool_result' && !calls.has(s.id)),
  );
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? running;
  // running 切换时不强制改 open（让用户的手动展开/收起优先），但首次有内容且运行中默认展开。
  const toolCount = steps.filter((s) => s.kind === 'tool_call').length;
  const reasoningText = reasoning?.trim() ?? '';

  if (shown.length === 0 && !reasoningText && !running) return null;

  return (
    <div className={`weq-asst-steps${running ? ' is-running' : ''}`}>
      <button
        type="button"
        className="weq-asst-steps-head"
        aria-expanded={open}
        onClick={() => setManualOpen(!open)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {running ? <Loader2 size={13} className="weq-asst-spin" /> : <Brain size={13} />}
        <span>
          {running ? '思考中…' : '思考过程'}
          {toolCount > 0 ? ` · 调用工具 ${toolCount} 次` : ''}
        </span>
      </button>

      {open ? (
        <div className="weq-asst-steps-body">
          {reasoningText ? (
            <div className="weq-asst-step weq-asst-step-reasoning">
              <Brain size={12} className="weq-asst-step-lead" />
              <span className="weq-asst-step-text weq-asst-reasoning-text">{reasoningText}</span>
            </div>
          ) : null}
          {shown.map((s, idx) => {
            const key = `s-${idx}`;
            if (s.kind === 'thinking') {
              return (
                <div key={key} className="weq-asst-step weq-asst-step-think">
                  <Brain size={12} className="weq-asst-step-lead" />
                  <span className="weq-asst-step-text">{s.text}</span>
                </div>
              );
            }
            if (s.kind === 'tool_call') {
              const args = summarizeArgs(s.args);
              const result = results.get(s.id);
              return (
                <div key={key} className="weq-asst-step weq-asst-step-call">
                  <Wrench size={12} className="weq-asst-step-lead" />
                  <span className="weq-asst-step-text">
                    <code className="weq-asst-step-tool">{s.name}</code>
                    <details>
                      <summary className="weq-asst-step-args">{args || '参数'}</summary>
                      <pre className="weq-asst-step-json">{JSON.stringify(s.args, null, 2)}</pre>
                      <button
                        type="button"
                        className="icon-button"
                        title="复制工具参数"
                        aria-label="复制工具参数"
                        onClick={() => void copyTextToClipboard(JSON.stringify(s.args, null, 2))}
                      >
                        <Copy size={13} />
                      </button>
                    </details>
                    {result?.kind === 'tool_result' ? (
                      <ToolResult preview={result.preview} ok={result.ok} />
                    ) : null}
                  </span>
                </div>
              );
            }
            // tool_result
            if (s.kind !== 'tool_result') return null;
            return (
              <div key={key} className="weq-asst-step weq-asst-step-res">
                <ToolResult preview={s.preview} ok={s.ok} />
              </div>
            );
          })}
          {running && shown.length === 0 ? (
            <div className="weq-asst-step-hint">正在规划…</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
