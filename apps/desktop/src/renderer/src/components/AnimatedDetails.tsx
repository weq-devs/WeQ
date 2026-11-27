import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { useExitMotion } from '../hooks/useExitMotion';
import '../styles/animated-disclosure.css';

/** 原生 summary 继续处理键盘，收拢时立即停用内容，到最后一帧再关 details。 */
export function AnimatedDetails({
  open,
  children,
  onClick,
  onToggle,
  ...props
}: ComponentProps<'details'>) {
  const [expanded, setExpanded] = useState(open === true);
  const [previousOpen, setPreviousOpen] = useState(open);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    setExpanded(open === true);
  }
  const panel = useRef<HTMLDivElement>(null);
  const present = useExitMotion(panel, expanded);
  const id = useId();
  const [summary, ...content] = Children.toArray(children);
  return (
    <details
      {...props}
      open={present}
      onClick={(event) => {
        onClick?.(event);
        const target = event.target as Element;
        if (
          event.defaultPrevented ||
          target.closest?.('summary') !== event.currentTarget.firstElementChild ||
          target.closest('a, button, input, select, textarea')
        )
          return;
        event.preventDefault();
        setExpanded((value) => !value);
      }}
      onToggle={(event) => {
        if (event.currentTarget.open !== present) setExpanded(event.currentTarget.open);
        onToggle?.(event);
      }}
    >
      {isValidElement<ComponentProps<'summary'>>(summary)
        ? cloneElement(summary, { role: 'button', 'aria-expanded': expanded, 'aria-controls': id })
        : summary}
      <div
        ref={panel}
        id={id}
        className="weq-disclosure-panel weq-animated-disclosure"
        hidden={!present}
        inert={!expanded}
        aria-hidden={!expanded || undefined}
        data-closing={!expanded || undefined}
      >
        <div>{content}</div>
      </div>
    </details>
  );
}
