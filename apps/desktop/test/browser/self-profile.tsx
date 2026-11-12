import { createRoot } from 'react-dom/client';
import { qa } from './self-profile.stub';
import { SelfQQControls } from '../../src/renderer/src/components/settings/SelfQQControls';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
Object.assign(window, { selfProfileQa: qa });
function Fixture() {
  return (
    <main
      className="weq-self-profile-page"
      style={{ maxWidth: 700, padding: 18, margin: '0 auto' }}
    >
      <h1 style={{ fontSize: 18 }}>我的资料</h1>
      <SelfQQControls />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
