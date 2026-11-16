import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DatabaseManagementSection } from '../../src/renderer/src/components/settings/DatabaseManagementSection';
import { AccountBasicsSection } from '../../src/renderer/src/components/settings/AccountBasicsSection';
import { DatabaseBrowserWindowHost } from '../../src/renderer/src/components/DatabaseBrowserWindow';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { useViewState } from '../../src/renderer/src/state/view';
import { qa } from './database-management.stub';
import '../../src/renderer/src/styles/index.css';
Object.assign(window, { databaseQa: qa });
useViewState.setState({ openedUin: '10001' });
const client = new QueryClient();
function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <QueryClientProvider client={client}>
      <main style={{ padding: 16, maxWidth: 900, margin: '0 auto' }}>
        <button type="button" onClick={() => setOpen(!open)}>
          {open ? '关闭设置' : '打开设置'}
        </button>
        {open && (
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
            {new URLSearchParams(location.search).has('reading') ? (
              <AccountBasicsSection page="listening" />
            ) : (
              <DatabaseManagementSection
                onOpen={() => {
                  qa.repairs++;
                }}
              />
            )}
          </div>
        )}
        <DatabaseBrowserWindowHost />
        <DialogHost />
      </main>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
