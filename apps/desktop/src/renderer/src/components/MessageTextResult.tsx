import { useState, type ReactNode } from 'react';
import { ChevronsUp } from 'lucide-react';
import { cn } from '../lib/utils';
import { ConversationActionsMenu } from './ConversationActionsMenu';

export function MessageTextResult({
  label,
  error,
  onCollapse,
  children,
}: {
  label: string;
  error?: boolean;
  onCollapse: () => void;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      className={cn('qq-message-text-result', error && 'is-error')}
      role="group"
      aria-label={label}
      tabIndex={0}
      onContextMenu={(event) => {
        event.stopPropagation();
        if (event.defaultPrevented) return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        event.stopPropagation();
        const { left, bottom } = event.currentTarget.getBoundingClientRect();
        setMenu({ x: left, y: bottom });
      }}
    >
      {children}
      {menu ? (
        <ConversationActionsMenu
          {...menu}
          label={`${label}操作`}
          onClose={() => setMenu(null)}
          actions={[
            { label: '收起', icon: <ChevronsUp size={16} aria-hidden />, action: onCollapse },
          ]}
        />
      ) : null}
    </div>
  );
}

export function MessageTranslationResult({
  value,
  error,
  onCollapse,
}: {
  value: string | null;
  error?: boolean;
  onCollapse: () => void;
}) {
  return (
    <MessageTextResult label="译文" error={error} onCollapse={onCollapse}>
      <span role="status" data-privacy-sensitive={Boolean(value && !error) || undefined}>
        {value ?? '正在翻译…'}
      </span>
    </MessageTextResult>
  );
}
