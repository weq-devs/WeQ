import { createRoot } from 'react-dom/client';
import { SelfProfileDialog } from '../../src/renderer/src/im-template/template/TitleBar';
import { qa } from './self-profile.stub';
import { useState } from 'react';
import { ContactWorkspaceNavigationContext } from '../../src/renderer/src/lib/profileNavigation';
import { SelfQQControls } from '../../src/renderer/src/components/settings/SelfQQControls';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
Object.assign(window, { selfProfileQa: qa });
function Fixture() {
  const [page, setPage] = useState(false);
  return (
    <ContactWorkspaceNavigationContext.Provider value={() => setPage(true)}>
      {page ? (
        <main
          className="weq-self-profile-page"
          style={{ maxWidth: 700, padding: 18, margin: '0 auto' }}
        >
          <h1 style={{ fontSize: 18 }}>我的资料</h1>
          <SelfQQControls />
        </main>
      ) : (
        <SelfProfileDialog onClose={() => {}} />
      )}
    </ContactWorkspaceNavigationContext.Provider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
