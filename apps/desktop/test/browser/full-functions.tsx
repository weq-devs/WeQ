import { createRoot } from 'react-dom/client';
import { QqStatusReminderSettings } from '../../src/renderer/src/components/settings/QqStatusReminderSettings';
import { AccountBasicsSection } from '../../src/renderer/src/components/settings/AccountBasicsSection';
import { LongTermAuthorizationSection } from '../../src/renderer/src/components/settings/LongTermAuthorizationSection';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import {
  RestrictedModeHost,
  RestrictedModeIndicator,
} from '../../src/renderer/src/components/RestrictedMode';
import { WelcomeDialog } from '../../src/renderer/src/components/WelcomeDialog';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { setFixture, setOnlineFixture } from './qq-debug-copy.stub';
import { saves, setProxyFixture } from './full-functions.stub';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

ensureThemeInitialized();
setFixture({ state: 'ready', version: '合成版本', runningPids: [] });
useViewState.setState({ view: 'main', openedUin: '10001' });
Object.assign(window, {
  fullFunctionsQa: { theme: useThemeStore, saves, setOnlineFixture, setProxyFixture },
});
createRoot(document.getElementById('root')!).render(
  <>
    <style>{`
      html,body,#root{height:auto;min-height:100%;margin:0;overflow:auto}
      .full-functions-fixture{max-width:820px;margin:auto;padding:20px;box-sizing:border-box;color:var(--weq-fg-primary);background:var(--weq-chat-bg)}
      .full-functions-fixture.weq-settings-dialog{display:block;width:100%;height:auto;min-width:0;border:0;border-radius:0;box-shadow:none}
      @media(max-width:600px){.full-functions-fixture{padding:16px}}
    `}</style>
    {new URLSearchParams(location.search).has('welcome') ? (
      <WelcomeDialog />
    ) : (
      <>
        <main className="weq-settings-dialog full-functions-fixture">
          <div className="weq-set">
            <AccountBasicsSection heading={false} />
            <AccountBasicsSection page="qq-proxy" heading={false} />
            <QqStatusReminderSettings />
            <LongTermAuthorizationSection />
          </div>
        </main>
        <RestrictedModeIndicator />
        <RestrictedModeHost />
      </>
    )}
    <DialogHost />
  </>,
);
