import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { formatChatTime, formatConversationTime, formatDateTime, formatTimeRange } from '@weq/time';
import { TimeLabel } from '../../src/renderer/src/components/TimeLabel';
import { HoverTooltip } from '../../src/renderer/src/components/HoverTooltip';
import { NodeTimeInput } from '../../src/renderer/src/components/mergeForward/NodeTimeInput';
import '../../src/renderer/src/styles/index.css';

const now = Date.parse('2026-03-04T15:00:00+08:00');
const stamp = '2026-03-04T06:05:06.789Z';
const timeline = Array.from({ length: 300 }, (_, index) => now - index * 1000);

function Fixture() {
  const [opened, setOpened] = useState(0);
  const [seconds, setSeconds] = useState(Math.floor(Date.parse(stamp) / 1000));
  return (
    <main
      style={{
        maxWidth: 760,
        margin: '24px auto',
        padding: 16,
        color: 'var(--foreground)',
        background: 'var(--background)',
      }}
    >
      <h1 style={{ fontSize: 20 }}>时间记录</h1>
      <button
        type="button"
        data-testid="row"
        onClick={() => setOpened((value) => value + 1)}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 16,
          width: '100%',
          padding: 12,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span>最近会话</span>
        <TimeLabel value={stamp} precision="millisecond" className="compact-time">
          {formatConversationTime(stamp, now)}
        </TimeLabel>
      </button>
      <p data-testid="opened">打开次数 {opened}</p>
      <p>
        <TimeLabel value={stamp}>{formatChatTime(stamp, now)}</TimeLabel>
      </p>
      <p>
        <TimeLabel value={stamp} precision="millisecond" />
      </p>
      <p>
        <TimeLabel value="2025-12-31T23:59:59+08:00">
          {formatTimeRange('2025-12-31T23:59:59+08:00', '2026-01-01T00:01:00+08:00', now)}
        </TimeLabel>
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        <NodeTimeInput time={seconds} onChange={setSeconds} />
        <output>{formatDateTime(seconds * 1000)}</output>
      </div>
      <div style={{ height: 360, overflow: 'auto', marginTop: 16 }} data-testid="scroller">
        {timeline.map((timestamp) => (
          <p key={timestamp}>
            <TimeLabel value={timestamp} />
          </p>
        ))}
      </div>
      <HoverTooltip />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
