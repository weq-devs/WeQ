import { openLink, splitLinks } from '../lib/linkify';

/** 普通正文与 QQ 文本元素共用链接识别，保留原始文字和换行。 */
export function QqTextLinks({ text }: { text: string }) {
  let offset = 0;
  return (
    <>
      {splitLinks(text).map((part) => {
        const start = offset;
        offset += part.text.length;
        return part.kind === 'link' ? (
          <button
            key={start}
            type="button"
            className="qq-link"
            title={part.href}
            onClick={(event) => {
              event.stopPropagation();
              void openLink(part.href);
            }}
          >
            {part.text}
          </button>
        ) : (
          <span key={start}>{part.text}</span>
        );
      })}
    </>
  );
}
