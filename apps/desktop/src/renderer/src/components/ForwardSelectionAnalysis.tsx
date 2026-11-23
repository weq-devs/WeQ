import { useId, useMemo } from 'react';
import { calendarParts, formatDateTime, formatTimeRange } from '@weq/time';
import { NumericText } from './NumericText';
import { BarChart3, X } from 'lucide-react';
import {
  forwardSenderKey,
  forwardSenderName,
  type ForwardEntry,
} from '../lib/forwardRecordActions';
import { Modal } from './Dialog';
import { HourlyBarChart } from './analyticsCharts';
import '../styles/conversation-analytics.css';

const MEDIA_LABELS: Record<string, string> = {
  pic: '图片',
  ptt: '语音',
  video: '视频',
  bubbleVideo: '圆形视频',
  file: '文件',
  mface: '商城表情',
};

function summarize(entries: readonly ForwardEntry[]) {
  const people = new Map<string, { name: string; uin: string; count: number }>();
  const hours: Record<number, number> = {};
  const media = new Map<string, number>();
  let first = Infinity;
  let last = 0;
  let undated = 0;
  for (const entry of entries) {
    const key = forwardSenderKey(entry);
    const person = people.get(key) ?? {
      name: forwardSenderName(entry.record),
      uin: entry.record.senderUin || '',
      count: 0,
    };
    person.count++;
    people.set(key, person);
    if (entry.sendTimeMs > 0) {
      first = Math.min(first, entry.sendTimeMs);
      last = Math.max(last, entry.sendTimeMs);
      const hour = calendarParts(entry.sendTimeMs)?.hour;
      if (hour !== undefined) hours[hour] = (hours[hour] ?? 0) + 1;
    } else undated++;
    for (const el of entry.record.elements) {
      const label = MEDIA_LABELS[el.type ?? ''];
      if (label) media.set(label, (media.get(label) ?? 0) + 1);
    }
  }
  return {
    people: [...people].sort((a, b) => b[1].count - a[1].count),
    hours,
    media,
    first,
    last,
    undated,
  };
}

export function ForwardSelectionAnalysis({
  entries,
  onClose,
}: {
  entries: ForwardEntry[];
  onClose: () => void;
}) {
  const titleId = useId();
  const report = useMemo(() => summarize(entries), [entries]);
  return (
    <Modal onClose={onClose} labelledBy={titleId} width={600} className="weq-forward-analysis">
      <header className="weq-forward-analysis-head">
        <BarChart3 size={18} aria-hidden />
        <h2 id={titleId}>所选消息分析</h2>
        <button
          type="button"
          className="weq-forward-close"
          title="关闭分析"
          aria-label="关闭分析"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      <div className="weq-forward-analysis-body">
        <p>
          <strong>
            <NumericText>{entries.length}</NumericText>
          </strong>{' '}
          条消息 ·{' '}
          <strong>
            <NumericText>{report.people.length}</NumericText>
          </strong>{' '}
          位发送者
        </p>
        {report.last > 0 ? (
          <p>
            <NumericText>
              {report.first === report.last
                ? formatDateTime(report.first)
                : formatTimeRange(report.first, report.last)}
            </NumericText>
            （北京时间）
          </p>
        ) : null}
        {report.undated > 0 ? (
          <p>
            <NumericText>{`${report.undated} 条消息没有有效时间`}</NumericText>
          </p>
        ) : null}
        <section>
          <h3>发言排行</h3>
          <ul className="weq-forward-analysis-rank">
            {report.people.map(([key, person]) => (
              <li key={key}>
                <span>
                  {person.name}
                  {/^[1-9]\d*$/.test(person.uin) && person.uin !== person.name ? (
                    <small>{person.uin}</small>
                  ) : null}
                </span>
                <strong>{person.count} 条</strong>
              </li>
            ))}
          </ul>
        </section>
        {report.last > 0 ? (
          <section aria-label="北京时间发言时段">
            <h3>发言时段</h3>
            <HourlyBarChart data={report.hours} />
          </section>
        ) : null}
        {report.media.size ? (
          <section>
            <h3>媒体</h3>
            <p>{[...report.media].map(([label, count]) => `${label} ${count}`).join(' · ')}</p>
          </section>
        ) : null}
      </div>
    </Modal>
  );
}
