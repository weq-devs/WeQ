import { createRoot } from 'react-dom/client';
import { AccountBasicsSection } from '../../src/renderer/src/components/settings/AccountBasicsSection';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { WelcomeDialog } from '../../src/renderer/src/components/WelcomeDialog';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { setFixture } from './qq-debug-copy.stub';
import { saves } from './full-functions.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

ensureThemeInitialized();
setFixture({ state: 'ready', version: '合成版本', runningPids: [] });
Object.assign(window, { fullFunctionsQa: { theme: useThemeStore, saves } });
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
      <main className="weq-settings-dialog full-functions-fixture">
        <AccountBasicsSection />
      </main>
    )}
    <DialogHost />
  </>,
);
