import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QqMarketFace } from '../../src/renderer/src/components/QqMedia';
import { MarketFaceLightbox } from '../../src/renderer/src/components/MarketFaceLightbox';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useDataSaver } from '../../src/renderer/src/lib/dataSaver';
import '../../src/renderer/src/styles/index.css';

ensureThemeInitialized();
useDataSaver.setState({ enabled: true });
Object.assign(window, { marketTheme: useThemeStore });
function View() {
  const [count, setCount] = useState(0);
  return (
    <main style={{ padding: 16, color: 'var(--weq-fg-primary)' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 16 }}>合成会话</h1>
      </header>
      <section style={{ display: 'grid', gap: 48, padding: 12, background: 'var(--weq-chat-bg)' }}>
        <QqMarketFace data={{ emojiPackId: 123, marketEmoticonIdHex: '1'.padStart(32, '0') }} />
        <div style={{ justifySelf: 'end' }}>
          <QqMarketFace data={{ emojiPackId: 123, marketEmoticonIdHex: '2'.padStart(32, '0') }} />
        </div>
      </section>
      <footer style={{ marginTop: 160 }}>
        <button type="button" className="weq-set-btn" onClick={() => setCount(count + 1)}>
          背景操作 {count}
        </button>
      </footer>
      <MarketFaceLightbox />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <View />
  </QueryClientProvider>,
);
