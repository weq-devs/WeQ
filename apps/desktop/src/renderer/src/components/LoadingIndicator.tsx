import { LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import '../styles/loading-indicator.css';

export function LoadingSpinner() {
  return (
    <span className="weq-loading-indicator-spinner" aria-hidden>
      <LoaderCircle size={16} strokeWidth={1.85} />
    </span>
  );
}

export function LoadingIndicator({ children = '加载中…' }: { children?: ReactNode }) {
  return (
    <span className="weq-loading-indicator">
      <LoadingSpinner />
      <span>{children}</span>
    </span>
  );
}

export function PanelLoading({
  startup = false,
  children = '正在加载…',
}: {
  startup?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className="weq-panel-loading"
      role="status"
      data-weq-startup-pending={startup || undefined}
    >
      <LoadingIndicator>{children}</LoadingIndicator>
    </div>
  );
}
