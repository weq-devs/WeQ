export interface ModelLogBlock {
  id: string;
  label: string;
  text: string;
  ts?: number;
  level?: 'info' | 'warn' | 'error';
  collapsed?: boolean;
  format?: 'text' | 'auto';
}

/** 只格式化完整 JSON；生成中、截断和普通文本始终保留原样。 */
export function formatModelLogText(raw: string, streaming = false) {
  if (!streaming && raw.length <= 128_000) {
    const text = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return { text: JSON.stringify(JSON.parse(text), null, 2), json: true };
      } catch {
        // 半截 JSON 和带前后说明的文本不猜测修复。
      }
    }
  }
  return { text: raw, json: false };
}

export function modelResponseText(raw: string): { content?: string; reasoning?: string } {
  try {
    const value = JSON.parse(raw);
    const message = value?.choices?.[0]?.message;
    return {
      content: typeof message?.content === 'string' ? message.content : undefined,
      reasoning:
        typeof message?.reasoning_content === 'string' ? message.reasoning_content : undefined,
    };
  } catch {
    return {};
  }
}

/** 兼容旧日志的标题前缀及字符串内嵌正文，不改写保存的原始响应。 */
export function suggestionLogBlocks(
  lines: readonly {
    seq: number;
    ts: number;
    stage: string;
    text: string;
    level: 'info' | 'warn' | 'error';
  }[],
): ModelLogBlock[] {
  const hasContent = lines.some((line) => line.stage === '模型正文');
  const hasReasoning = lines.some((line) => line.stage === '推理输出');
  return lines.flatMap((line): ModelLogBlock[] => {
    const text =
      ['System Prompt', 'User Prompt', '原始返回'].includes(line.stage) &&
      line.text.startsWith(`${line.stage}\n`)
        ? line.text.slice(line.stage.length + 1)
        : line.text;
    const block: ModelLogBlock = {
      id: String(line.seq),
      label: line.stage,
      text,
      ts: line.ts,
      level: line.level,
      collapsed: ['System Prompt', 'User Prompt', '推理输出', '原始返回', '响应汇总'].includes(
        line.stage,
      ),
      format: ['System Prompt', 'User Prompt', '推理输出'].includes(line.stage) ? 'text' : 'auto',
    };
    if (line.stage !== '原始返回') return [block];
    const response = modelResponseText(text);
    return [
      ...(!hasContent && response.content
        ? [
            {
              ...block,
              id: `${block.id}-content`,
              label: '模型正文',
              text: response.content,
              collapsed: false,
            },
          ]
        : []),
      ...(!hasReasoning && response.reasoning
        ? [
            {
              ...block,
              id: `${block.id}-reasoning`,
              label: '推理输出',
              text: response.reasoning,
              format: 'text' as const,
            },
          ]
        : []),
      block,
    ];
  });
}
