import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImageLightbox, openLightbox } from '../../src/renderer/src/components/ImageLightbox';
import { VideoLightbox, openVideoLightbox } from '../../src/renderer/src/components/VideoLightbox';
import { QqImage, QqVideo, QqVoice } from '../../src/renderer/src/components/QqMedia';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/lib/inputModality';

ensureThemeInitialized();
Object.assign(window, { mediaTheme: useThemeStore });
function View() {
  return (
    <main style={{ padding: 20, display: 'grid', gap: 20, justifyItems: 'start' }}>
      <button
        type="button"
        onClick={() =>
          openLightbox('/_media/pic?token=good', '合成图片', {
            peerType: 'c2c',
            fileToken: 'fixture',
            width: 640,
            height: 480,
          })
        }
      >
        打开图片
      </button>
      <button
        type="button"
        onClick={() =>
          openLightbox('/_media/pic?token=fail', '失败图片', null, document, undefined, [
            '/_media/pic?token=fail&v=thumb',
          ])
        }
      >
        打开失败图片
      </button>
      <button
        type="button"
        onClick={() => openVideoLightbox('/_media/video?token=fail', '', '合成视频')}
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
      <ImageLightbox />
      <VideoLightbox />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <View />
  </QueryClientProvider>,
);
