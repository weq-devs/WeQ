import { useState } from 'react';
import { qzoneTextParts } from '../lib/qzone';
import { inlineImageUrl } from '../lib/resourceUrl';
import { useDataSaver } from '../lib/dataSaver';

export function QzoneInlineText({ content }: { content: string }) {
  return qzoneTextParts(content).map((part) =>
    part.kind === 'emoji' ? (
      <QzoneEmoji key={`${part.offset}:${part.code}`} code={part.code} />
    ) : (
      <span key={`${part.offset}:text`}>{part.text}</span>
    ),
  );
}

export function QzoneEmoji({
  code,
  className = 'weq-qzn-emoji',
}: {
  code: string;
  className?: string;
}) {
  const limited = useDataSaver((state) => state.enabled && !state.behavior.dataSaverEmoji);
  const [attempt, setAttempt] = useState({ limited, index: 0 });
  const sourceIndex = attempt.limited === limited ? attempt.index : 0;
  if (sourceIndex >= 2)
    return (
      <span className="weq-qzn-emoji-unavailable" title={`QQ 表情 ${code}`}>
        [QQ表情]
      </span>
    );
  const extension = sourceIndex === 0 ? 'gif' : 'png';
  return (
    <img
      className={className}
      src={inlineImageUrl(`https://qzonestyle.gtimg.cn/qzone/em/${code}.${extension}`, 'emoji')}
      alt="[QQ表情]"
      title={`QQ 表情 ${code}`}
      loading="lazy"
      onError={() => setAttempt({ limited, index: sourceIndex + 1 })}
    />
  );
}
