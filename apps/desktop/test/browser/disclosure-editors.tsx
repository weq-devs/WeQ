import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ExternalRkeySection } from '../../src/renderer/src/components/settings/ExternalRkeySection';
import { SsePushSection } from '../../src/renderer/src/components/settings/SsePushSection';
import { OneBotSection } from '../../src/renderer/src/components/settings/OneBotSection';
import { SignatureInteractions } from '../../src/renderer/src/components/ProfileInteractions';
import { QzoneFriendPermissions } from '../../src/renderer/src/components/qq-actions/QzoneFriendPermissions';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { PageSnapshots } from '../../src/renderer/src/components/PageSnapshots';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import { qa } from './disclosure-editors.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '10001' });
Object.assign(window, { disclosureQa: qa, disclosureTheme: useThemeStore });
const surface = new URLSearchParams(location.search).get('surface');
const input = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture', uin: '10001' };
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <PageSnapshots scope="disclosure-editors">
      <main style={{ height: '100dvh', overflow: 'auto', padding: 18 }}>
        {surface === 'rkey' ? (
          <ExternalRkeySection />
        ) : surface === 'sse' ? (
          <SsePushSection />
        ) : surface === 'onebot' ? (
          <OneBotSection />
        ) : surface === 'permissions' ? (
          <QzoneFriendPermissions />
        ) : (
          <SignatureInteractions
            input={input}
            online
            refresh={async () => {}}
            item={{
              id: 'signature',
              text: '合成签名',
              action: null,
              data: null,
              location: null,
              createdAt: 1700000000,
              likes: '0',
              likeUsers: [],
              commentItems: Array.from({ length: 12 }, (_, index) => ({
                id: `comment-${index}`,
                text: `合成评论 ${index + 1}`,
                fromUin: '20001',
                fromName: '合成好友',
                toUin: null,
                toName: null,
                replyId: null,
                time: 1700000000,
              })),
            }}
          />
        )}
      </main>
      <DialogHost />
    </PageSnapshots>
  </QueryClientProvider>,
);
