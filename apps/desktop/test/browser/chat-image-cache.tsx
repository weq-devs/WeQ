import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatImageCacheProvider } from '../../src/renderer/src/components/ChatImageCacheProvider';
import { ChatImageCacheSettings } from '../../src/renderer/src/components/settings/ChatImageCacheSettings';
import { QqImage, QqMarketFace } from '../../src/renderer/src/components/QqMedia';
import { trpc } from '../../src/renderer/src/trpc/client';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles/emoji.css';

function Fixture() {
  const settings = trpc.bootstrap.getSettings.useQuery();
  const [mounted, setMounted] = useState(true);
  const [scope, setScope] = useState('one');
  return (
    <ChatImageCacheProvider scope={scope} budgetMiB={settings.data?.chatImageCacheMiB ?? 128}>
      <main style={{ maxWidth: 900, padding: 16 }}>
        <ChatImageCacheSettings />
        <button type="button" onClick={() => setMounted((value) => !value)}>
          切换消息挂载
        </button>
        <button
          type="button"
          onClick={() => setScope((value) => (value === 'one' ? 'two' : 'one'))}
        >
          切换账号
        </button>
        <div
          data-images
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'start', gap: 16, marginTop: 16 }}
        >
          {mounted ? (
            <>
              <QqImage
                data={{ fileName: '合成图片.png', imgWidth: 640, imgHeight: 480 }}
                sendTimeMs={1}
              />
              <QqImage
                data={{ fileName: '合成动画.png', imgWidth: 640, imgHeight: 480, subType: 1 }}
                sendTimeMs={2}
              />
              <QqMarketFace
                data={{
                  emojiPackId: 1,
                  marketEmoticonIdHex: 'a'.repeat(32),
                  previewWidth: 120,
                  previewHeight: 120,
                }}
              />
            </>
          ) : null}
        </div>
        <div style={{ height: 2400 }} />
      </main>
    </ChatImageCacheProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
