import type { ReactNode } from 'react';
import '../styles/compact-toolbar.css';

export function ToolbarLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={className ? `weq-toolbar-label ${className}` : 'weq-toolbar-label'}>
      {children}
    </span>
  );
}
