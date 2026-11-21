import { MessageCircle } from 'lucide-react';
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

export function QzoneActionsRow({
  children,
  rowRef,
  title,
}: {
  children: ReactNode;
  rowRef?: RefObject<HTMLDivElement | null>;
  title?: string;
}) {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = rowRef ?? internalRef;
  useLayoutEffect(() => {
    const container = ref.current;
    const row = container?.firstElementChild;
    if (!container || !row) return;
    const fit = () => {
      container.removeAttribute('data-compact');
      container.toggleAttribute('data-compact', row.scrollWidth > container.clientWidth);
    };
    // 卡片宽度和异步返回的计数都可能改变文字能否放下。
    const resize = new ResizeObserver(fit);
    const content = new MutationObserver(fit);
    resize.observe(container);
    content.observe(row, { childList: true, characterData: true, subtree: true });
    return () => {
      resize.disconnect();
      content.disconnect();
    };
  }, [ref]);
  return (
    <div ref={ref} className="weq-qzn-actions-fit" title={title}>
      <div className="weq-qzn-actions">{children}</div>
    </div>
  );
}

export function QzoneCommentToggle({
  expanded,
  count,
  onToggle,
}: {
  expanded: boolean;
  count: number | null;
  onToggle: () => void;
}) {
  return (
    <button type="button" aria-expanded={expanded} title="评论" onClick={onToggle}>
      <MessageCircle size={16} aria-hidden />
      <span className="weq-qzn-action-label">评论</span>{' '}
      <span className="weq-number">{count ?? '?'}</span>
    </button>
  );
}
