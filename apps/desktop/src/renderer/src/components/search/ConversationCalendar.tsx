import { useEffect, useMemo, useState, useRef } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { client } from '../../trpc/client';

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
  const [days, setDays] = useState<Array<{ day: string; count: number }>>([]);
  const [month, setMonth] = useState(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date()),
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    generation.current++;
    setError('');
    setDays([]);
    setLoading(true);
    void client.account.conversationCalendar
      .query({ kind, conv })
      .then((rows) => {
        if (!active) return;
        setDays(rows);
        if (rows.length) setMonth(rows[rows.length - 1]!.day.slice(0, 7));
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, [kind, conv]);
  const counts = useMemo(() => new Map(days.map((row) => [row.day, row.count])), [days]);
  const years = [...new Set(days.map((row) => row.day.slice(0, 4)))];
  const [year, mon] = month.split('-').map(Number);
  const startWeekday = new Date(Date.UTC(year!, mon! - 1, 1)).getUTCDay();
  const length = new Date(Date.UTC(year!, mon!, 0)).getUTCDate();
  async function jump(day?: string, newest = false) {
    const run = generation.current;
    setBusy(true);
    setError('');
    try {
      const start = day ? Math.floor(Date.parse(day + 'T00:00:00+08:00') / 1000) : undefined;
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
  function move(delta: number) {
    const date = new Date(Date.UTC(year!, mon! - 1 + delta, 1));
    setMonth(date.toISOString().slice(0, 7));
  }
  return (
    <Modal onClose={onClose} width={440} labelledBy="message-calendar-title">
      <div className="weq-message-calendar">
        <header>
          <h3 id="message-calendar-title">聊天日历</h3>
          <button className="weq-dialog-x" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="weq-calendar-tools">
          <button
            title="最早消息"
            aria-label="最早消息"
            disabled={loading || busy}
            onClick={() => void jump()}
          >
            <ChevronsLeft size={16} />
          </button>
          <button title="上个月" aria-label="上个月" disabled={busy} onClick={() => move(-1)}>
            <ChevronLeft size={16} />
          </button>
          <select
            aria-label="年份"
            value={String(year)}
            onChange={(e) => setMonth(e.target.value + month.slice(4))}
          >
            {[...new Set([...years, String(year)])].sort().map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
          <select
            aria-label="月份"
            value={mon}
            onChange={(e) => setMonth(String(year) + '-' + e.target.value.padStart(2, '0'))}
          >
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i} value={i + 1}>
                {i + 1}月
              </option>
            ))}
          </select>
          <button title="下个月" aria-label="下个月" disabled={busy} onClick={() => move(1)}>
            <ChevronRight size={16} />
          </button>
          <button
            title="最新消息"
            aria-label="最新消息"
            disabled={loading || busy}
            onClick={() => void jump(undefined, true)}
          >
            <ChevronsRight size={16} />
          </button>
        </div>
        {loading ? (
          <div role="status">加载中...</div>
        ) : (
          <>
            <div className="weq-calendar-grid">
              {['日', '一', '二', '三', '四', '五', '六'].map((d) => (
                <span key={d}>{d}</span>
              ))}
              {Array.from({ length: startWeekday }, (_, i) => (
                <span key={'pad' + i} />
              ))}
              {Array.from({ length }, (_, i) => {
                const day = month + '-' + String(i + 1).padStart(2, '0');
                const count = counts.get(day) || 0;
                return (
                  <button
                    key={day}
                    className={count ? 'has-messages' : ''}
                    disabled={!count || busy}
                    title={`${day}（北京时间）：${count} 条`}
                    onClick={() => void jump(day)}
                  >
                    <span>{i + 1}</span>
                    <small>{count || ''}</small>
                  </button>
                );
              })}
            </div>
            <footer>北京时间 · {days.length} 个有记录日期</footer>
          </>
        )}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </Modal>
  );
}
