/**
 * 助手「多轮思考 + 工具调用」过程的可折叠展示。
 *
 * 运行中默认展开、实时滚动；完成后默认收起（可点开回看）。每一步按 kind 渲染：
 * thinking=思路、tool_call=调用了哪个工具(参数可展开)、tool_result=结果(成功/失败，
 * JSON 预览可展开)。final/error 不在这里展示（final 是主答复气泡，error 走对话框）。
 */

import { useState, type ReactElement } from 'react';
import { Brain, Check, ChevronDown, ChevronRight, Loader2, Wrench, X } from 'lucide-react';
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
    </div>
  );
}

export function AssistantSteps({
  steps,
  running,
}: {
  steps: AssistantStep[];
  running: boolean;
}): ReactElement | null {
  // 只展示过程类步骤。
  const shown = steps.filter((s) => s.kind === 'thinking' || s.kind === 'tool_call' || s.kind === 'tool_result');
  const [open, setOpen] = useState(running);
  // running 切换时不强制改 open（让用户的手动展开/收起优先），但首次有内容且运行中默认展开。
  const toolCount = steps.filter((s) => s.kind === 'tool_call').length;

  if (shown.length === 0 && !running) return null;

  return (
    <div className={`weq-asst-steps${running ? ' is-running' : ''}`}>
      <button type="button" className="weq-asst-steps-head" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {running ? <Loader2 size={13} className="weq-asst-spin" /> : <Brain size={13} />}
        <span>
          {running ? '思考中…' : '思考过程'}
          {toolCount > 0 ? ` · 调用工具 ${toolCount} 次` : ''}
        </span>
      </button>

      {open ? (
        <div className="weq-asst-steps-body">
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
              return (
                <div key={key} className="weq-asst-step weq-asst-step-call">
                  <Wrench size={12} className="weq-asst-step-lead" />
                  <span className="weq-asst-step-text">
                    <code className="weq-asst-step-tool">{s.name}</code>
                    {args ? <span className="weq-asst-step-args">{args}</span> : null}
                  </span>
                </div>
              );
            }
            // tool_result
            return (
              <div key={key} className="weq-asst-step weq-asst-step-res">
                <ToolResult preview={s.preview} ok={s.ok} />
              </div>
            );
          })}
          {running && shown.length === 0 ? <div className="weq-asst-step-hint">正在规划…</div> : null}
        </div>
      ) : null}
    </div>
  );
}
