import { LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import '../styles/loading-indicator.css';

export function LoadingIndicator({ children = '加载中…' }: { children?: ReactNode }) {
  return (
    <span className="weq-loading-indicator">
      <span className="weq-loading-indicator-spinner" aria-hidden>
        <LoaderCircle size={16} strokeWidth={1.85} />
      </span>
      <span>{children}</span>
    </span>
  );
}

export function PanelLoading() {
  return (
    <div className="weq-panel-loading" role="status" data-weq-startup-pending>
      <LoadingIndicator>正在加载…</LoadingIndicator>
    </div>
  );
}
