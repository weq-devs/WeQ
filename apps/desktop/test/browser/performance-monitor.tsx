import { createRoot } from 'react-dom/client';
import LogPerformanceSettings from '../../src/renderer/src/components/settings/LogPerformanceSettings';
import { LogPerformanceWindowHost } from '../../src/renderer/src/components/LogPerformanceWindow';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { TabActivity } from '../../src/renderer/src/components/RetainedTabs';
import { useState } from 'react';
import { qa } from './performance-monitor.stub';
import '../../src/renderer/src/styles/index.css';
Object.assign(window, { performanceQa: qa });
document.documentElement.dataset.theme = 'light';
function Fixture() {
  const [active, setActive] = useState(true);
  Object.assign(qa, { setActive });
  return (
    <main style={{ padding: 18, maxWidth: 820, margin: '0 auto' }}>
      <div
        className="weq-settings-dialog"
        style={{
          display: 'block',
          width: '100%',
          height: 'auto',
          border: 0,
          borderRadius: 0,
          boxShadow: 'none',
          background: 'transparent',
          overflow: 'visible',
        }}
      >
        <TabActivity active={active}>
          <LogPerformanceSettings />
        </TabActivity>
      </div>
      <LogPerformanceWindowHost />
      <DialogHost />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
