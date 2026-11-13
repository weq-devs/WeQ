import { createRoot } from 'react-dom/client';
import { useState, useLayoutEffect } from 'react';
import { TrpcProvider } from '../../src/renderer/src/trpc/provider';
import { client, trpc } from '../../src/renderer/src/trpc/client';
import { ClientStateSync } from '../../src/renderer/src/components/ClientStateSync';
import { SharedDisplayToggle } from '../../src/renderer/src/components/settings/SharedDisplayToggle';
import { usePrivacyStore } from '../../src/renderer/src/state/privacy';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import {
  useClientPreferences,
  preferenceValue,
  initializePreferences,
  sharedAccountRecords,
} from '../../src/renderer/src/lib/clientPreferences';
import { resolveDraftSave } from '../../src/renderer/src/lib/draftPersistence';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/client-sync.css';

ensureThemeInitialized();
usePrivacyStore.getState().hydrate();
useViewState.setState({ openedUin: '10001' });
Object.assign(window, {
  syncQa: {
    client,
    theme: useThemeStore,
    preferences: useClientPreferences,
    preferenceValue,
    initializePreferences,
    resolveDraftSave,
    privacy: usePrivacyStore,
  },
});
function Fixture() {
  useClientPreferences((state) => state.tick);
  const background = useThemeStore((state) => state.background);
  const settings = trpc.bootstrap.getSettings.useQuery();
  const [lines] = useState(() => Array.from({ length: 80 }, (_, i) => `测试消息 ${i + 1}`));
  useLayoutEffect(() => {
    const sample = () => ({
      count: document.querySelectorAll('.sync-message').length,
      height: document.querySelector('.sync-message')?.getBoundingClientRect().height ?? 0,
    });
    Object.assign(window, { syncFirstCommit: sample() });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => Object.assign(window, { syncFirstPaint: sample() })),
    );
  }, []);
  return (
    <main className="sync-fixture">
      <ClientStateSync />
      <section>
        <h1>主题与背景</h1>
        <label>
          界面背景
          <select
            aria-label="界面背景"
            value={background}
            onChange={(event) =>
              useThemeStore.getState().setBackground(event.target.value as typeof background)
            }
          >
            {['plain', 'paper', 'grid', 'dots', 'wash', 'telegram'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          消息气泡
          <SharedDisplayToggle
            name="showMessageBubble"
            label="消息气泡"
            fallback={settings.data?.showMessageBubble ?? true}
          />
        </label>
        <p data-markdown={settings.data?.renderTextMarkdown}>
          Markdown：{settings.data?.renderTextMarkdown ? '开启' : '关闭'}
        </p>
        <p data-follow={String(settings.data?.autoFollowLatestMessages)}>
          跟随消息：{settings.data?.autoFollowLatestMessages ? '开启' : '关闭'}
        </p>
        <p data-cache={settings.data?.chatImageCacheMiB}>
          图片预算：{settings.data?.chatImageCacheMiB}
        </p>
        <p data-pin={String(sharedAccountRecords('pins')['123'] ?? false)}>
          群助手置顶：{sharedAccountRecords('pins')['123'] ? '开启' : '关闭'}
        </p>
      </section>
      <section aria-label="消息列表" className="sync-messages">
        {lines.map((line) => (
          <p key={line} className="sync-message">
            {line}
          </p>
        ))}
      </section>
      <style>{`html,body,#root{margin:0;height:100%;overflow:auto}.sync-fixture{padding:16px;min-height:100%;background:var(--weq-chat-bg);color:var(--weq-fg-primary);font-size:14px}.sync-fixture h1{font-size:20px}.sync-fixture section{max-width:760px;margin:auto}.sync-fixture label{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0}.sync-fixture select{max-width:100%;background:var(--weq-bg-surface);color:var(--weq-fg-primary);border:1px solid var(--weq-border-subtle);padding:4px}.sync-messages{height:400px;overflow:auto}.sync-message{padding:8px;max-width:75%;background:var(--weq-bg-surface);border:1px solid var(--weq-border-subtle);border-radius:6px}`}</style>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <TrpcProvider>
    <Fixture />
  </TrpcProvider>,
);
