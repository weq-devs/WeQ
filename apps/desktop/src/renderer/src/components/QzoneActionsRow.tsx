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
    const row = ref.current;
    if (!row) return;
    const fit = () => {
      row.removeAttribute('data-compact');
      row.toggleAttribute('data-compact', row.scrollWidth > row.clientWidth);
    };
    // 卡片宽度和异步返回的计数都可能改变文字能否放下。
    const resize = new ResizeObserver(fit);
    const content = new MutationObserver(fit);
    resize.observe(row);
    content.observe(row, { childList: true, characterData: true, subtree: true });
    return () => {
      resize.disconnect();
      content.disconnect();
    };
  }, [ref]);
  return (
    <div ref={ref} className="weq-qzn-actions" data-fit title={title}>
      {children}
    </div>
  );
}
