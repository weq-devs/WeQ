import { createRoot } from 'react-dom/client';
import PerformanceMonitor from '../../src/renderer/src/components/settings/PerformanceMonitor';
import { TabActivity } from '../../src/renderer/src/components/RetainedTabs';
import { useState } from 'react';
import { qa } from './performance-monitor.stub';
import '../../src/renderer/src/styles/index.css';
Object.assign(window, { performanceQa: qa });
function Fixture() {
  const [active, setActive] = useState(true);
  Object.assign(qa, { setActive });
  return (
    <main style={{ padding: 18, maxWidth: 820, margin: '0 auto' }}>
      <TabActivity active={active}>
        <PerformanceMonitor />
      </TabActivity>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
