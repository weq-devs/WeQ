import { useRef, type ReactNode } from 'react';
import { useExitMotion } from '../hooks/useExitMotion';
import '../styles/animated-disclosure.css';

/** 内容在收拢时立即退出交互，保留到网格高度归零。 */
export function AnimatedDisclosure({
  open,
  id,
  keepMounted = false,
  children,
}: {
  open: boolean;
  id: string;
  keepMounted?: boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const shown = useExitMotion(panel, open);
  return (
    <div
      ref={panel}
      id={id}
      className="weq-disclosure-panel weq-animated-disclosure"
      hidden={!shown}
      inert={!open}
      aria-hidden={!open || undefined}
      data-closing={!open || undefined}
    >
      {shown || keepMounted ? <div>{children}</div> : null}
    </div>
  );
}
