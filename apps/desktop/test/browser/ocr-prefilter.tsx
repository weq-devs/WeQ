import { createRoot } from 'react-dom/client';
import { OcrModelsSection } from '../../src/renderer/src/components/settings/OcrModelsSection';
import '../../src/renderer/src/styles/index.css';

createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 900, margin: 'auto', padding: 16 }}>
    <OcrModelsSection />
  </main>,
);
