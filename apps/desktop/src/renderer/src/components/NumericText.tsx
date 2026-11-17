import type { ReactNode } from 'react';

/** 仅用于程序生成的进度、大小等摘要，不处理消息正文、名称或原始代码。 */
export function NumericText({
  children,
  as: Tag = 'span',
}: {
  children?: string | number;
  as?: 'span' | 'tspan';
}) {
  const text = children === undefined ? '' : String(children);
  const parts: ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(/\d+(?:[.,:/\u2013-]\d+)*%?/g)) {
    parts.push(text.slice(end, match.index));
    parts.push(
      <Tag className="weq-number weq-number-inherit" key={match.index}>
        {match[0]}
      </Tag>,
    );
    end = match.index + match[0].length;
  }
  parts.push(text.slice(end));
  return <>{parts}</>;
}
