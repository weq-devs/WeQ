import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  PersonaBotExportPane,
  QzoneTargetInput,
  QzoneContentSelector,
} from '../../src/renderer/src/views/export/ResourceExportPanes';
import { AnalysisTool } from '../../src/renderer/src/views/analysis/AnalysisTool';
import { ExportLightbox } from '../../src/renderer/src/views/export/ExportLightbox';
import type { QzoneExportContent } from '../../src/renderer/src/views/export/types';
import { useViewState } from '../../src/renderer/src/state/view';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/export.css';
import '../../src/renderer/src/styles/unified-export.css';
import '../../src/renderer/src/styles/qzone.css';
import '../../src/renderer/src/styles/qq-actions.css';

useViewState.setState({ openedUin: '10001' });
function Fixture() {
  const [kind, setKind] = useState('analytics');
  const [content, setContent] = useState<QzoneExportContent>('both');
  return (
    <main style={{ maxWidth: 1000, margin: 'auto', padding: 12, boxSizing: 'border-box' }}>
      <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        {['analytics', 'bot', 'album'].map((value) => (
          <button type="button" key={value} onClick={() => setKind(value)}>
            {value}
          </button>
        ))}
      </nav>
      {kind === 'analytics' ? (
        <AnalysisTool onGenerate={() => {}} />
      ) : kind === 'bot' ? (
        <PersonaBotExportPane />
      ) : (
        <>
          <QzoneContentSelector value={content} onChange={setContent} />
          <QzoneTargetInput onAdd={() => {}} />
          <ExportLightbox
            embedded
            variant="qzone"
            qzoneContent={content}
            headline="QQ 空间导出"
            summary="合成空间"
            onClose={() => {}}
            onConfirm={() => {}}
          />
        </>
      )}
      <DialogHost />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(createElement(Fixture));
