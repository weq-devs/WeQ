import { useState } from 'react';
import type { RoamingTarget } from '@weq/service';
import { createRoot } from 'react-dom/client';
import { RoamingBackfillPanel } from '../../src/renderer/src/components/RoamingBackfillPanel';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import type { ThemeBackground } from '../../src/renderer/src/state/theme';
import { submissions } from './roaming-backfill.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/export.css';

declare global {
  interface Window {
    roamingTheme: (dark: boolean, accent: string, background: ThemeBackground) => void;
    roamingSubmissions: unknown[];
  }
}
window.roamingSubmissions = submissions;
window.roamingTheme = (dark, accent, background) => {
  const theme = useThemeStore.getState();
  theme.setPreference(
    new URLSearchParams(location.search).has('system') ? 'system' : dark ? 'dark' : 'light',
  );
  theme.setAccent(accent);
  theme.setBackground(background);
};
const targets: RoamingTarget[] = [
  { kind: 'c2c', conv: 'u_fixture', name: '合成好友与较长的会话显示名称' },
  { kind: 'group', conv: '10001', name: '合成群聊' },
];
function Fixture() {
  const [submitted, setSubmitted] = useState(false);
  return (
    <>
      <style>{`html,body,#root{margin:0;height:100%;background:var(--weq-chat-bg)}main{max-width:980px;height:100%;margin:auto}`}</style>
      <main>
        {submitted ? (
          <output>已转交当前任务</output>
        ) : (
          <RoamingBackfillPanel
            initialTargets={targets.slice(
              0,
              new URLSearchParams(location.search).has('single') ? 1 : 2,
            )}
            targetMode="fixed"
            onSubmitted={() => setSubmitted(true)}
          />
        )}
      </main>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
