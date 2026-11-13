import { createRoot } from 'react-dom/client';
import { DataSaverSettings } from '../../src/renderer/src/components/settings/DataSaverSettings';
import { QqImage } from '../../src/renderer/src/components/QqMedia';
import { acceptPreferences } from '../../src/renderer/src/lib/clientPreferences';
import { installDataSaver } from '../../src/renderer/src/lib/dataSaver';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/settings-controls.css';
import '../../src/renderer/src/styles/settings-responsive.css';
import '../../src/renderer/src/im-template/styles/emoji.css';

acceptPreferences(
  { epoch: 'fixture', revision: 0, values: { dataSaverMode: 'always' }, records: {} },
  false,
);
installDataSaver();
createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 800, padding: 16 }}>
    <DataSaverSettings />
    <QqImage
      data={{ fileName: 'available.png', fileToken: 'available', imgWidth: 640, imgHeight: 480 }}
      sendTimeMs={1}
    />
    <QqImage
      data={{ fileName: 'missing.png', fileToken: 'missing', imgWidth: 640, imgHeight: 480 }}
      sendTimeMs={2}
    />
  </main>,
);
