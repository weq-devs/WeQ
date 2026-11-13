import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ContentSelectionProvider,
  useContentExportRequest,
} from '../../src/renderer/src/state/contentSelection';
import type { ContentReference } from '../../src/shared/content_selection';
import { ReferenceExportTool } from '../../src/renderer/src/views/export/ReferenceExportTool';
import { MessageNotificationRows } from '../../src/renderer/src/components/settings/MessageNotificationRows';
import { MediaView, AlbumGridView } from '../../src/renderer/src/components/QzoneAlbumDialog';
import { AnalysisHistory } from '../../src/renderer/src/views/analysis/AnalysisHistory';
import { SavedAnalysisBody } from '../../src/renderer/src/views/analysis/SavedAnalysisBody';
import { savedReport } from './requirements.stub';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/settings-controls.css';
import '../../src/renderer/src/im-template/styles/chat.css';
import '../../src/renderer/src/styles/analysis-tool.css';
Object.assign(window, {
  requirementsTheme: (theme: 'light' | 'dark') => {
    useThemeStore.getState().setPreference(theme);
    useThemeStore.getState().setAccent(theme === 'dark' ? '#ce809d' : '#167d67');
  },
});
const items: ContentReference[] = [
  {
    kind: 'qzone-photo',
    uin: '10002',
    albumId: 'album-a',
    mediaKey: 'same-name',
    name: '相册甲的照片',
  },
  {
    kind: 'qzone-photo',
    uin: '10002',
    albumId: 'album-b',
    mediaKey: 'same-name',
    name: '相册乙的照片',
  },
];
function Work() {
  const [album, setAlbum] = useState(0);
  const [grid, setGrid] = useState(false);
  const request = useContentExportRequest();
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>相册内容</h1>
      <nav aria-label="相册">
        <button
          type="button"
          className="weq-exp-tool"
          onClick={() => {
            setAlbum(0);
            setGrid(false);
          }}
        >
          相册甲
        </button>
        <button
          type="button"
          className="weq-exp-tool"
          onClick={() => {
            setAlbum(1);
            setGrid(false);
          }}
        >
          相册乙
        </button>
        <button type="button" className="weq-exp-tool" onClick={() => setGrid(true)}>
          相册列表
        </button>
      </nav>
      {grid ? (
        <AlbumGridView
          hostUin="10002"
          albums={['甲', '乙'].map((name, index) => ({
            id: index === 0 ? 'album-a' : 'album-b',
            name: `相册${name}`,
            coverUrl: '',
            desc: '',
            createTime: 0,
            priv: 0,
            mediaCount: 1,
          }))}
          onOpen={(item) => {
            setAlbum(item.id === 'album-a' ? 0 : 1);
            setGrid(false);
          }}
        />
      ) : (
        <MediaView
          key={`album:${album}`}
          active
          photos={[
            {
              id: 'same-name',
              name: items[album]!.name!,
              desc: '',
              url: 'https://fixture.invalid/photo.png',
              thumbUrl: '',
              uploadTime: 100,
              isVideo: false,
              picKey: 'same-name',
            },
          ]}
          total={1}
          loading={false}
          loadingMore={false}
          error={null}
          hasMore={false}
          fetchedPages={1}
          albumName={album === 0 ? '相册甲' : '相册乙'}
          hostUin="10002"
          selfUin="10001"
          topicId={album === 0 ? 'album-a' : 'album-b'}
          onBack={() => setGrid(true)}
          onLoadMore={async () => false}
        />
      )}
      {request?.selection.scope.type === 'references' ? (
        <ReferenceExportTool
          key={`export:${request.revision}`}
          initial={request.selection.scope.items}
        />
      ) : null}
      <h2 style={{ fontSize: 18 }}>通知</h2>
      <section className="weq-set">
        <MessageNotificationRows />
      </section>
      <h2 style={{ fontSize: 18 }}>分析报告</h2>
      <SavedAnalysisBody request={savedReport.request} onClose={() => undefined} />
      <AnalysisHistory enabled />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <ContentSelectionProvider>
    <Work />
  </ContentSelectionProvider>,
);
