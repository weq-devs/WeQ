import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  MediaPreviewHost,
  openMediaPreview,
} from '../../src/renderer/src/components/mediaPreviewStore';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';

ensureThemeInitialized();
Object.assign(window, { mediaTheme: useThemeStore });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <button
      type="button"
      className="weq-set-btn"
      onClick={() =>
        openMediaPreview({
          items: [
            { key: 'fixture', kind: 'image', src: '/_media/pic?token=good', title: '合成图片' },
          ],
        })
      }
    >
      打开图片
    </button>
    <MediaPreviewHost />
  </QueryClientProvider>,
);
