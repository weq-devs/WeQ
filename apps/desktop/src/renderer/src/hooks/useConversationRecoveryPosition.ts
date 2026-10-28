import { useCallback, useEffect, useRef } from 'react';
import { z } from 'zod';
import { usePageSnapshotKey } from '../components/PageSnapshots';
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
}: {
  conv: string | null;
  kind: 'c2c' | 'group';
  rows: Row[];
  enabled: boolean;
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      timer = undefined;
      if (!value) return;
      try {
        pageSnapshots.write(key, value);
      } catch {
        // 可重建阅读坐标写入失败不影响独立保存的正文草稿。
      }
    };
    const capture = (scroll: HTMLElement) => {
      const position = captureReadingPosition(scroll);
      const anchor = rows.find((row) => timelineRowKey(row) === position.anchorId);
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
      if (!timer) timer = setTimeout(save, 150);
    };
    const onScroll = (event: Event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches('.weq-readonly-chat .message-scroll')
      )
        capture(event.target);
    };
    const frame = requestAnimationFrame(() => {
      const scroll = document.querySelector<HTMLElement>('.weq-readonly-chat .message-scroll');
      if (scroll) capture(scroll);
    });
    document.addEventListener('scroll', onScroll, true);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      document.removeEventListener('scroll', onScroll, true);
      save();
    };
  }, [key, conv, kind, rows, enabled]);
  return { read, applied };
}
