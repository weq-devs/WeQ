import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ContentReferenceToolbar } from '../../src/renderer/src/components/ContentReferenceToolbar';
import {
  ContentSelectionProvider,
  useContentExportRequest,
  useContentMultiSelect,
} from '../../src/renderer/src/state/contentSelection';
import { contentReferenceKey, type ContentReference } from '../../src/shared/content_selection';
import { ReferenceExportTool } from '../../src/renderer/src/views/export/ReferenceExportTool';
import { MessageNotificationRows } from '../../src/renderer/src/components/settings/MessageNotificationRows';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/settings-controls.css';
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
  const owner = useMemo(
    () => ({ kind: 'qzone-albums' as const, container: 'fixture-workspace' }),
    [],
  );
  const references = useMemo(
    () =>
      new Map(items.filter((_, i) => i === album).map((item) => [contentReferenceKey(item), item])),
    [album],
  );
  const selection = useContentMultiSelect(owner, true, references);
  const request = useContentExportRequest();
  return (
    <main className="weq-set" style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>相册内容</h1>
      <nav aria-label="相册">
        <button type="button" className="weq-set-btn" onClick={() => setAlbum(0)}>
          相册甲
        </button>
        <button type="button" className="weq-set-btn" onClick={() => setAlbum(1)}>
          相册乙
        </button>
      </nav>
      <ContentReferenceToolbar
        owner={owner}
        selection={selection}
        loaded={[...references.keys()]}
      />
      {[...references].map(([key, item]) => (
        <button
          key={key}
          type="button"
          className="weq-reference-export-row"
          aria-pressed={selection.selectedIds.has(key)}
          onClick={() =>
            selection.setSelectedIds((previous) => {
              const next = new Set(previous);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
        >
          {item.name}
        </button>
      ))}
      {request?.selection.scope.type === 'references' ? (
        <ReferenceExportTool key={request.revision} initial={request.selection.scope.items} />
      ) : null}
      <h2 style={{ fontSize: 18 }}>通知</h2>
      <MessageNotificationRows />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <ContentSelectionProvider>
    <Work />
  </ContentSelectionProvider>,
);
