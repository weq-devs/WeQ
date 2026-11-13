import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContactFieldHistoryProvider } from '../../src/renderer/src/components/contactProfile/ContactFieldHistory';
import { ContactRow } from '../../src/renderer/src/components/contactProfile/ContactRow';
import { ContactHistory } from '../../src/renderer/src/components/ContactHistory';
import { SelfAvatarHistory } from '../../src/renderer/src/components/SelfAvatarHistory';
import { ProfileExtras } from '../../src/renderer/src/components/ProfileExtras';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import { reads } from './history-visibility.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/contact-workspace.css';
import '../../src/renderer/src/styles/contact-card.css';
ensureThemeInitialized();
useViewState.setState({ openedUin: '10001' });
Object.assign(window, { historyVisibilityQa: { reads, theme: useThemeStore } });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <main style={{ width: 'min(560px, 100%)', padding: 16, margin: '0 auto' }}>
      <ContactFieldHistoryProvider entity="friend:u_peer">
        {['昵称', '个性签名', '累计获赞', '学校', '标签'].map((label) => (
          <ContactRow key={label} label={label} value={`当前${label}`} />
        ))}
        <ContactHistory entity="friend:u_peer" />
        <ProfileExtras uin="10002" section="signature" />
        <SelfAvatarHistory />
      </ContactFieldHistoryProvider>
      <ContactFieldHistoryProvider entity="group:12345">
        <ContactRow label="群成员数" value="10 人" />
        <ContactHistory entity="group:12345" />
      </ContactFieldHistoryProvider>
    </main>
  </QueryClientProvider>,
);
