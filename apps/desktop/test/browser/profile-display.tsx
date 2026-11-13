import { createRoot } from 'react-dom/client';
import { SelfProfileFixture as SelfQQControls } from '../support/SelfProfileFixture';
import { SelfProfileDisplayProvider } from '../../src/renderer/src/components/ProfileDisplaySettings';
import { qa } from './profile-display.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
Object.assign(window, { profileDisplayQa: qa });
createRoot(document.getElementById('root')!).render(
  <main className="weq-self-profile-page" style={{ maxWidth: 820, padding: 18, margin: '0 auto' }}>
    <SelfProfileDisplayProvider uin="10001">
      <SelfQQControls />
    </SelfProfileDisplayProvider>
  </main>,
);
