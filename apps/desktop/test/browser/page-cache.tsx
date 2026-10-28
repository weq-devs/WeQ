import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PageSnapshots } from '../../src/renderer/src/components/PageSnapshots';
import { CollectionDialog } from '../../src/renderer/src/components/CollectionDialog';
import { lazyPanel } from '../../src/renderer/src/lib/lazyPanel';
import { fixture } from './page-cache.stub';
import '../../src/renderer/src/styles/index.css';

const Tool = lazyPanel(
  () =>
    new Promise<{ default: () => React.ReactElement }>((resolve) => {
      setTimeout(() => resolve({ default: () => <p>工具已就绪</p> }), 1000);
    }),
);
Object.assign(window, { pageCacheQa: fixture });
function App() {
  const [open, setOpen] = useState(true);
  const [tool, setTool] = useState(false);
  return (
    <PageSnapshots scope="browser-qa">
      <main style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
        <nav style={{ display: 'flex', gap: 12, padding: 12 }}>
          <button type="button" onClick={() => setOpen(!open)}>
            {open ? '隐藏收藏' : '返回收藏'}
          </button>
          <button type="button" onClick={() => setTool(true)}>
            打开工具
          </button>
        </nav>
        {tool ? <Tool /> : null}
        {open ? <CollectionDialog open embedded onClose={() => setOpen(false)} /> : null}
      </main>
    </PageSnapshots>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
