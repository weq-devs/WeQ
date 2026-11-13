import { createRoot } from 'react-dom/client';
import { UsagePanel } from '../../src/renderer/src/views/agentlab/UsagePanel';
import { SectionHeader } from '../../src/renderer/src/components/settings/controls';
import { Activity } from 'lucide-react';
import '../../src/renderer/src/styles/index.css';

createRoot(document.getElementById('root')!).render(
  <main className="weq-set" style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
    <SectionHeader title="API 用量" icon={<Activity size={16} strokeWidth={1.8} />} />
    <UsagePanel />
  </main>,
);
