import {
  Children,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';

function labelOf(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) return labelOf(child.props.children);
      return '';
    })
    .join('')
    .trim();
}

/** 不增加包装 DOM，拖拽、焦点和布局仍使用原按钮。 */
export const CompositionButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    disabledReason?: string | null;
  }
>(function CompositionButton({ children, title, disabledReason, disabled, ...props }, ref) {
  const action = title?.trim() || props['aria-label'] || labelOf(children);
  return (
    <button
      {...props}
      ref={ref}
      disabled={disabled}
      aria-label={props['aria-label'] || action || undefined}
      title={disabled && disabledReason ? `${action}：${disabledReason}` : action || undefined}
      data-disabled-reason={disabled ? disabledReason || undefined : undefined}
    >
      {children}
    </button>
  );
});
