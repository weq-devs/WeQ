/**
 * 紧凑、无外部依赖的 Markdown → React 渲染，供 WeQ 助手的最终答复使用。
 *
 * 支持：标题(#~######)、围栏代码块(```)、引用(>)、有序/无序列表、分隔线(---)、
 * 段落与软换行；行内支持 **粗** *斜* ~~删~~ `代码` 与 [文字](http链接)。
 * 刻意只覆盖助手实际会产出的子集，样式走 `weq-asst-md*`（见 styles/index.css）。
 */

import { Fragment, type ReactElement, type ReactNode } from 'react';

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'hr' };

function parseBlocks(value: string): Block[] {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  const at = (n: number): string => lines[n] ?? '';
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = at(i);

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 围栏代码块
    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(at(i))) {
        code.push(at(i));
        i += 1;
      }
      if (i < lines.length) i += 1; // 跳过收尾 ```
      blocks.push({ type: 'code', lang: fence[1] ?? '', text: code.join('\n') });
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: (heading[1] ?? '').length, text: (heading[2] ?? '').trim() });
      i += 1;
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(at(i))) {
        quote.push(at(i).replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', text: quote.join('\n') });
      continue;
    }

    // 列表（连续同类型行）
    const listMatch = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+[.)]/.test(listMatch[1] ?? '');
      const items: string[] = [];
      while (i < lines.length) {
        const m = at(i).match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
        if (!m || /\d+[.)]/.test(m[1] ?? '') !== ordered) break;
        items.push(m[2] ?? '');
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // 段落（吃到空行或下一个块语法）
    const para: string[] = [];
    while (
      i < lines.length &&
      at(i).trim() &&
      !/^```/.test(at(i)) &&
      !/^#{1,6}\s+/.test(at(i)) &&
      !/^>\s?/.test(at(i)) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(at(i)) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(at(i))
    ) {
      para.push(at(i));
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: para.join('\n') });
  }

  return blocks;
}

const INLINE =
  /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;

/** 渲染一段行内 Markdown 为节点数组。 */
function renderInline(value: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(value))) {
    if (m.index > cursor) nodes.push(...renderText(value.slice(cursor, m.index), `${key}-t-${cursor}`));
    if (m[1] !== undefined && m[2]) {
      nodes.push(
        <a key={`${key}-a-${m.index}`} className="weq-asst-md-link" href={m[2]} target="_blank" rel="noreferrer">
          {m[1]}
        </a>,
      );
    } else if (m[3] !== undefined) {
      nodes.push(
        <code key={`${key}-c-${m.index}`} className="weq-asst-md-code">
          {m[3]}
        </code>,
      );
    } else if (m[4] !== undefined || m[5] !== undefined) {
      nodes.push(<strong key={`${key}-b-${m.index}`}>{m[4] ?? m[5]}</strong>);
    } else if (m[6] !== undefined) {
      nodes.push(<del key={`${key}-d-${m.index}`}>{m[6]}</del>);
    } else if (m[7] !== undefined || m[8] !== undefined) {
      nodes.push(<em key={`${key}-i-${m.index}`}>{m[7] ?? m[8]}</em>);
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < value.length) nodes.push(...renderText(value.slice(cursor), `${key}-t-${cursor}`));
  return nodes;
}

/** 纯文本，软换行转 <br/>。 */
function renderText(value: string, key: string): ReactNode[] {
  return value.split('\n').flatMap((line, idx) => {
    const out: ReactNode[] = [];
    if (idx > 0) out.push(<br key={`${key}-br-${idx}`} />);
    if (line) out.push(<Fragment key={`${key}-f-${idx}`}>{line}</Fragment>);
    return out;
  });
}

export function AssistantMessage({ text }: { text: string }): ReactElement {
  const blocks = parseBlocks(text);
  return (
    <div className="weq-asst-md">
      {blocks.map((b, idx) => {
        const key = `b-${idx}`;
        switch (b.type) {
          case 'heading': {
            const Tag = (`h${Math.min(b.level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6');
            return <Tag key={key}>{renderInline(b.text, key)}</Tag>;
          }
          case 'code':
            return (
              <pre key={key} className="weq-asst-md-pre">
                <code>{b.text}</code>
              </pre>
            );
          case 'quote':
            return (
              <blockquote key={key} className="weq-asst-md-quote">
                {renderInline(b.text, key)}
              </blockquote>
            );
          case 'hr':
            return <hr key={key} className="weq-asst-md-hr" />;
          case 'list':
            return b.ordered ? (
              <ol key={key}>
                {b.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          default:
            return <p key={key}>{renderInline(b.text, key)}</p>;
        }
      })}
    </div>
  );
}
