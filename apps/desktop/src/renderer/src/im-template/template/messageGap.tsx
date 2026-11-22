// @ts-nocheck
import { NumericText } from '../../components/NumericText';
import { cn } from './classNames';
import { useState } from 'react';
import type { HTMLAttributes } from 'react';
import { MessageSelectionMark } from '../../components/MessageSelectionMark';
import '../../styles/message-gap-selection.css';
import { useVisibleMessageGap } from '../../hooks/useVisibleMessageGap';

/**
 * A run of messages QQ never synced to this device. Rendered between the two
 * messages that straddle the hole.
 */
export function MessageGapDivider({
  count,
  onOpen,
  id,
  selectionMode = false,
  selected = false,
  selectionProps,
  autoFetch = false,
}: {
  count: number;
  onOpen?: (automatic?: boolean) => void | Promise<void>;
  autoFetch?: boolean;
  id?: string;
  selectionMode?: boolean;
  selected?: boolean;
  selectionProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const [loading, setLoading] = useState(false);
  const open = async (automatic = false) => {
    if (!onOpen || loading) return;
    setLoading(true);
    try {
      await onOpen(automatic);
    } finally {
      setLoading(false);
    }
  };
  const gapRef = useVisibleMessageGap(autoFetch && !selectionMode && !!onOpen, id, () =>
    open(true),
  );
  return (
    <div
      {...selectionProps}
      ref={gapRef}
      data-message-id={id}
      className={cn(
        'weq-graytip-band',
        'weq-message-selectable',
        selectionMode && 'weq-selectable-gap',
        selectionMode && 'selection-mode',
        selected && 'is-selected',
      )}
      aria-selected={selectionMode ? selected : undefined}
    >
      {selectionMode ? <MessageSelectionMark selected={selected} /> : null}
      <button
        type="button"
        className={cn('weq-graytip-band-hint', 'weq-gap-band-button')}
        onClick={() => open()}
        disabled={(!onOpen && !selectionProps) || loading}
        tabIndex={selectionMode ? -1 : 0}
        aria-busy={loading}
        title={
          selectionMode
            ? selected
              ? '取消选择此消息缺口'
              : '选择此消息缺口；操作前可合并拉取'
            : onOpen
              ? '点击拉取并查看这些缺失消息'
              : '缺口暂不可读取，可进入多选保留选择'
        }
      >
        {loading ? (
          '正在拉取缺失消息…'
        ) : selectionMode ? (
          <NumericText>{`此处有 ${count} 条消息缺失`}</NumericText>
        ) : onOpen ? (
          <NumericText>{`此处有 ${count} 条消息缺失 · 点击拉取`}</NumericText>
        ) : (
          <NumericText>{`此处有 ${count} 条消息需要打开 QQ 本体同步`}</NumericText>
        )}
      </button>
    </div>
  );
}

export function MessageLoadFailure({ children }: { children: string }) {
  return (
    <div className="weq-graytip-band weq-message-load-failure" role="status">
      <span className="weq-graytip-band-hint">{children}</span>
    </div>
  );
}
