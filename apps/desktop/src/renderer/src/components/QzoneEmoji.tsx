import { useState } from 'react';
import { avatarFetchUrl } from '../lib/resourceUrl';

export function QzoneEmoji({
  code,
  className = 'weq-qzn-emoji',
}: {
  code: string;
  className?: string;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);
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
      src={avatarFetchUrl(`https://qzonestyle.gtimg.cn/qzone/em/${code}.${extension}`)}
      alt="[QQ表情]"
      title={`QQ 表情 ${code}`}
      loading="lazy"
      onError={() => setSourceIndex((current) => (current === sourceIndex ? current + 1 : current))}
    />
  );
}
