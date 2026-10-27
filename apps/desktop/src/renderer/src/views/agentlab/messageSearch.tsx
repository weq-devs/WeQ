import { useEffect, useRef, useState, type RefObject } from 'react';
import '../../styles/generated-search.css';

export function useGeneratedSearchJump(
  transcript: RefObject<HTMLDivElement | null>,
  messageId: string | null,
  ready: boolean,
  messages: readonly unknown[],
) {
  const [missing, setMissing] = useState(false);
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!messageId || !ready || jumped.current === messageId) return;
    const frame = requestAnimationFrame(() => {
      const target = [
        ...(transcript.current?.querySelectorAll<HTMLElement>('[data-generated-message-id]') ?? []),
      ].find((node) => node.dataset.generatedMessageId === messageId);
      setMissing(!target);
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
        jumped.current = messageId;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [messageId, ready, messages, transcript]);
  return Boolean(messageId && missing);
}

export function GeneratedSearchNotice({ missing, error }: { missing: boolean; error: boolean }) {
  return missing || error ? (
    <div className="weq-generated-search-notice" role="status">
      {error ? '记录加载失败' : '该条记录已不在当前会话中'}
    </div>
  ) : null;
}
