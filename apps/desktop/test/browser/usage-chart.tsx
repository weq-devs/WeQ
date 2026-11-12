import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { HourLine } from '../../src/renderer/src/views/agentlab/UsagePanel';
import '../../src/renderer/src/styles/index.css';

const values = [...Array<number>(17).fill(0), 1300, 6400, 3800, 6800, 0, 6700, 0];

function Fixture() {
  const [busy, setBusy] = useState(false);
  const data = values.map((tokens, i) => ({
    hour: `${String((i + 8) % 24).padStart(2, '0')}:00`,
    tokens: busy ? (i % 2 === 0 ? 6800 : 0) : tokens,
    calls: tokens > 0 ? 2 : 0,
  }));
  return (
    <main style={{ padding: 16, color: 'var(--weq-fg-primary)' }}>
      <h4 style={{ marginBottom: 10 }}>近 24 小时已知用量</h4>
      <HourLine data={data} />
      <button type="button" onClick={() => setBusy((value) => !value)}>
        切换高频起伏
      </button>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
