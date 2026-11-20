import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { z } from 'zod';
import { usePageSnapshotKey } from '../components/PageSnapshots.shared';
import { captureReadingPosition } from '../lib/conversationReadingPosition';
import { pageSnapshots } from '../lib/pageSnapshots';
import { timelineRowKey } from '../../../shared/roaming_timeline';

const snapshotSchema = z.object({
  conv: z.string(),
  kind: z.enum(['c2c', 'group']),
  position: z.object({
    scrollTop: z.number().finite().nonnegative(),
    anchorId: z.string().optional(),
    anchorSeq: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    offset: z.number().finite().optional(),
    alignToEnd: z.boolean().optional(),
    bottomInset: z.number().finite().optional(),
  }),
});
type Snapshot = z.infer<typeof snapshotSchema>;
type Row = Parameters<typeof timelineRowKey>[0] & {
  msgSeq: string;
  source?: string;
  ntSeqVerified?: boolean;
};

/** 仅保存当前会话的阅读锚点，不持久化消息窗口或媒体。 */
export function useConversationRecoveryPosition({
  conv,
  kind,
  rows,
  enabled,
  scrollRef,
}: {
  conv: string | null;
  kind: 'c2c' | 'group';
  rows: Row[];
  enabled: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const key = usePageSnapshotKey('chat:recovery-position');
  const pending = useRef<{ key: string | null; value?: Snapshot }>({ key: null });
  if (pending.current.key !== key) {
    let value: Snapshot | undefined;
    try {
      if (key) value = pageSnapshots.read(key, snapshotSchema);
    } catch {
      // 失效锚点不妨碍打开工作区，也不改写原件。
    }
    pending.current = { key, value };
  }
  const read = useCallback((target: string, type: 'c2c' | 'group') => {
    const saved = pending.current.value;
    return saved?.conv === target && saved.kind === type ? saved.position : undefined;
  }, []);
  const applied = useCallback(() => {
    pending.current.value = undefined;
  }, []);

  useEffect(() => {
    if (!key || !conv || !enabled || !rows.length) return;
    let value: Snapshot | undefined;
    let target: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capture = (scroll: HTMLElement, requireOwnedAnchor: boolean) => {
      if (!scroll.isConnected || !scroll.clientHeight) return;
      const position = captureReadingPosition(scroll);
      const anchor = rows.find((row) => timelineRowKey(row) === position.anchorId);
      if (requireOwnedAnchor && !anchor) return;
      position.scrollTop = Math.max(0, position.scrollTop);
      if (
        anchor &&
        /^[1-9]\d*$/.test(anchor.msgSeq) &&
        (kind === 'group' || anchor.source !== 'roaming' || anchor.ntSeqVerified)
      )
        position.anchorSeq = anchor.msgSeq;
      // 底部跟随最新消息；历史位置必须有可在数据库中重取的稳定序号。
      if (scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 4)
        delete position.anchorSeq;
      value = { conv, kind, position };
    };
    const save = (requireOwnedAnchor = false) => {
      clearTimeout(timer);
      timer = undefined;
      if (target) capture(target, requireOwnedAnchor);
      target = null;
      if (!value) return;
      try {
        pageSnapshots.write(key, value);
        value = undefined;
      } catch {
        // 可重建阅读坐标写入失败不影响独立保存的正文草稿。
      }
    };
    const schedule = (scroll: HTMLElement) => {
      target = scroll;
      clearTimeout(timer);
      timer = setTimeout(save, 150);
    };
    const onScroll = (event: Event) => {
      const scroll = scrollRef.current;
      if (scroll && event.target === scroll) schedule(scroll);
    };
    const frame = requestAnimationFrame(() => {
      if (scrollRef.current) schedule(scrollRef.current);
    });
    const pageHide = () => save();
    window.addEventListener('pagehide', pageHide);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('pagehide', pageHide);
      // 清理时可能已复用同一个滚动容器渲染另一段会话。
      save(true);
    };
  }, [key, conv, kind, rows, enabled, scrollRef]);
  return { read, applied };
}
