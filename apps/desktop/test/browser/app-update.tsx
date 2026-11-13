import { createRoot } from 'react-dom/client';
import { UpdateCard } from '../../src/renderer/src/components/settings/UpdateCard';
import '../../src/renderer/src/styles/index.css';

createRoot(document.getElementById('root')!).render(
  <main className="weq-set" style={{ padding: 16, maxWidth: 800, margin: '0 auto' }}>
    <UpdateCard />
  </main>,
);
