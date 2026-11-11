import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RegionEditor } from '../../src/renderer/src/components/settings/EditableSelfProfile';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/settings-controls.css';
import '../../src/renderer/src/styles/self-profile-editor.css';

const regions = await fetch('/__region-qa').then((response) => response.json());
const qa = { saved: [] as Array<{ field: string; value: string[] }> };
Object.assign(window, { profileRegionQa: qa });
function App() {
  const [region, setRegion] = useState(['1', '35', '2']);
  const [hometown, setHometown] = useState(['DEU', '0', 'SWH', '0']);
  return (
    <main
      className="weq-set weq-self-profile-dialog"
      style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}
    >
      <RegionEditor
        label="当前地区"
        value={region}
        layers={3}
        regions={regions}
        disabled={false}
        onSave={async (value) => {
          qa.saved.push({ field: 'region', value });
          setRegion(value);
          return true;
        }}
      />
      <RegionEditor
        label="家乡"
        value={hometown}
        layers={4}
        regions={regions}
        disabled={false}
        onSave={async (value) => {
          qa.saved.push({ field: 'hometown', value });
          setHometown(value);
          return true;
        }}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
