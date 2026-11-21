import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useRenderDocument } from '../lib/renderDocument';
import { DRESS_OPACITY_PREVIEW, type DressOpacityKind } from './ChatBackdrop.shared';
import { FormRange } from './FormRange';

const LABELS: Record<DressOpacityKind, string> = {
  background: '聊天背景',
  widget: '浮屏挂件',
};

export function DressOpacityControl({
  kind,
  value,
  previewRef,
  onCommit,
  disabled,
}: {
  kind: DressOpacityKind;
  value: number;
  previewRef?: RefObject<HTMLElement | null>;
  onCommit: (value: number) => Promise<void>;
  disabled?: boolean;
}) {
  const document = useRenderDocument();
  const [draft, setDraft] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const queued = useRef<number | null>(null);
  const committing = useRef(false);
  const percent = Math.round((draft ?? value) * 100);

  useLayoutEffect(() => {
    if (draft === null) return;
    const root = (previewRef?.current ?? document.documentElement).style;
    const variable = DRESS_OPACITY_PREVIEW[kind];
    root.setProperty(variable, String(draft));
    return () => {
      root.removeProperty(variable);
    };
  }, [document, kind, draft, previewRef]);

  function reset() {
    pending.current = null;
    setDraft(null);
  }

  async function commit() {
    const next = pending.current;
    if (next === null) return;
    if (!committing.current && next === value) {
      reset();
      return;
    }
    pending.current = null;
    queued.current = next;
    if (committing.current) return;
    committing.current = true;
    try {
      // 键盘可继续调整，网络较慢时只保留随后确认的最新值。
      while (queued.current !== null) {
        const opacity = queued.current;
        queued.current = null;
        await onCommit(opacity);
      }
    } finally {
      committing.current = false;
      if (pending.current === null) setDraft(null);
    }
  }

  return (
    <label className="weq-dress-opacity">
      <span>不透明度</span>
      <FormRange
        aria-label={`${LABELS[kind]}不透明度`}
        aria-valuetext={`${percent}%`}
        min={0}
        max={1}
        step={0.01}
        disabled={disabled}
        value={draft ?? value}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          pending.current = next;
          setDraft(next);
        }}
        onPointerUp={() => void commit()}
        onPointerCancel={reset}
        onKeyUp={() => void commit()}
        onBlur={() => void commit()}
      />
      <span className="weq-dress-opacity-value weq-number weq-number-inherit" aria-hidden>
        {percent}%
      </span>
    </label>
  );
}
