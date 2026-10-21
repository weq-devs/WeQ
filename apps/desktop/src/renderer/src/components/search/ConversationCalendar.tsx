import { useEffect, useRef, useState } from 'react';
import { ChevronsLeft, ChevronsRight, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { MessageCalendar } from '../MessageCalendar';
import { client, trpc } from '../../trpc/client';
import { daySeconds } from '../../lib/messageCalendar';

export function ConversationCalendar({
  kind,
  conv,
  onClose,
  onJump,
}: {
  kind: 'group' | 'c2c';
  conv: string;
  onClose: () => void;
  onJump: (seq: string) => void;
}) {
  const calendar = trpc.account.conversationCalendar.useQuery(
    { kind, conv },
    {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [kind, conv]);
  async function jump(day?: string, newest = false) {
    const run = generation.current;
    setBusy(true);
    setError('');
    try {
      const start = day ? daySeconds(day) : undefined;
      const result = await client.account.conversationBoundary.query({
        kind,
        conv,
        newest,
        start,
        end: start === undefined ? undefined : start + 86399,
      });
      if (run !== generation.current) return;
      if (result) {
        onJump(result.msgSeq);
        onClose();
      } else setError('该范围没有可定位的消息序号。');
    } catch (e) {
      if (run === generation.current) setError(String(e));
    } finally {
      if (run === generation.current) setBusy(false);
    }
  }
  return (
    <Modal presentation="popover" onClose={onClose} width={440} labelledBy="message-calendar-title">
      <div className="weq-message-calendar">
        <header>
          <h3 id="message-calendar-title">聊天日历</h3>
          <button type="button" className="weq-dialog-x" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <MessageCalendar
          key={`${kind}:${conv}`}
          days={calendar.data}
          loading={calendar.isLoading}
          busy={busy}
          error={error || calendar.error?.message}
          onPick={(day) => void jump(day)}
          leading={
            <button
              type="button"
              title="最早消息"
              aria-label="最早消息"
              disabled={calendar.isLoading || busy}
              onClick={() => void jump()}
            >
              <ChevronsLeft size={16} />
            </button>
          }
          trailing={
            <button
              type="button"
              title="最新消息"
              aria-label="最新消息"
              disabled={calendar.isLoading || busy}
              onClick={() => void jump(undefined, true)}
            >
              <ChevronsRight size={16} />
            </button>
          }
        />
      </div>
    </Modal>
  );
}
