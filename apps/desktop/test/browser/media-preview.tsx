import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { MediaPreview, type PreviewMedia } from '../../src/renderer/src/components/MediaPreview';
import {
  MarketFaceLightbox,
  openMarketFaceLightbox,
} from '../../src/renderer/src/components/MarketFaceLightbox';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  MediaPreviewHost,
  openMediaPreview,
} from '../../src/renderer/src/components/mediaPreviewStore';

import { QqImage, QqVideo, QqVoice } from '../../src/renderer/src/components/QqMedia';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/lib/inputModality';

ensureThemeInitialized();
Object.assign(window, { mediaTheme: useThemeStore });
const emptyPreviewPage = async () => ({ items: [], hasMore: false });
function View() {
  const [gallery, setGallery] = useState<PreviewMedia[] | null>(null);
  return (
    <main style={{ padding: 20, display: 'grid', gap: 20, justifyItems: 'start' }}>
      <button
        type="button"
        onClick={() =>
          setGallery(
            [1, 2, 3].map((index) => ({
              key: `touch-${index}`,
              kind: 'image',
              src: `/_media/pic?token=touch-${index}`,
              title: `触摸图片 ${index}`,
              ocr: null,
            })),
          )
        }
      >
        打开触摸图库
      </button>
      <button
        type="button"
        onClick={() =>
          setGallery([
            { key: 'first', kind: 'image', src: '/_media/pic?token=good', title: '混排图片' },
            { key: 'second', kind: 'video', src: '/_media/video?token=good', title: '混排视频' },
          ])
        }
      >
        打开混排
      </button>
      <button type="button" onClick={() => openMarketFaceLightbox('123')}>
        打开表情包
      </button>
      <button
        type="button"
        onClick={() =>
          setGallery([
            {
              key: 'progressive',
              kind: 'image',
              src: '/_media/pic?token=good&v=thumb',
              title: '渐进图片',
              load: () =>
                new Promise((resolve) =>
                  Object.assign(window, {
                    releasePreviewDetail: () =>
                      resolve({ src: '/_media/pic?token=progressiveFull', kind: 'image' }),
                  }),
                ),
            },
          ])
        }
      >
        打开渐进图片
      </button>
      <button
        type="button"
        onClick={() =>
          openMediaPreview({
            items: [
              {
                key: '/_media/pic?token=good',
                kind: 'image',
                src: '/_media/pic?token=good',
                title: '合成图片',
                ocr: {
                  peerType: 'c2c',
                  fileToken: 'fixture',
                  width: 640,
                  height: 480,
                },
              },
            ],
          })
        }
      >
        打开图片
      </button>
      <button
        type="button"
        onClick={() =>
          openMediaPreview({
            items: [
              {
                key: '/_media/pic?token=fail',
                kind: 'image',
                src: '/_media/pic?token=fail',
                title: '失败图片',
                ocr: null,
                fallbackSources: ['/_media/pic?token=fail&v=thumb'],
              },
            ],
            ownerDocument: document,
          })
        }
      >
        打开失败图片
      </button>
      <button
        type="button"
        onClick={() =>
          openMediaPreview({
            items: [
              {
                key: '/_media/video?token=fail',
                kind: 'video',
                src: '/_media/video?token=fail',
                poster: '',
                title: '合成视频',
              },
            ],
          })
        }
      >
        打开视频
      </button>
      <div
        onKeyDown={(event) => {
          if (['Enter', ' ', 'ArrowDown'].includes(event.key)) event.preventDefault();
        }}
      >
        <QqImage
          data={{ fileName: 'photo.png', fileToken: 'good', imgWidth: 200, imgHeight: 150 }}
          sendTimeMs={1}
        />
      </div>
      <QqImage
        data={{ fileName: 'old.png', fileToken: 'fail', imgWidth: 200, imgHeight: 150 }}
        sendTimeMs={1}
      />
      <QqVideo
        data={{ fileName: 'video.webm', fileToken: 'good', videoWidth: 320, videoHeight: 180 }}
        sendTimeMs={1}
      />
      <QqVoice
        data={{ fileName: 'voice.wav', fileToken: 'fixture', pttDuration: 3 }}
        sendTimeMs={1}
      />
      <button type="button">背景按钮</button>
      <MediaPreviewHost />
      <MarketFaceLightbox />
      {gallery ? (
        <MediaPreview
          items={gallery}
          hasOlder={gallery[0]?.key !== 'touch-1'}
          hasNewer={gallery[0]?.key !== 'touch-1'}
          prefetchAdjacent={gallery[0]?.key !== 'touch-1'}
          loadPage={emptyPreviewPage}
          onClose={() => setGallery(null)}
          renderActions={() => (
            <>
              <input aria-label="媒体评论" />
              <button
                type="button"
                onClick={() =>
                  setGallery((previous) =>
                    previous
                      ? [
                          ...previous,
                          {
                            key: `extra-${previous.length}`,
                            kind: 'image',
                            src: '/_media/pic?token=good',
                            title: '追加图片',
                          },
                        ]
                      : previous,
                  )
                }
              >
                追加合成媒体
              </button>
            </>
          )}
        />
      ) : null}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <View />
  </QueryClientProvider>,
);
