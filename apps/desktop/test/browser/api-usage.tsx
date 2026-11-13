import { createRoot } from 'react-dom/client';
import { UsagePanel } from '../../src/renderer/src/views/agentlab/UsagePanel';
import '../../src/renderer/src/styles/index.css';

createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
    <h2 style={{ fontSize: 18, marginBottom: 20 }}>API 用量</h2>
    <UsagePanel />
  </main>,
);
