import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ExportLightbox } from '../../src/renderer/src/views/export/ExportLightbox';
import { MessageCalendar } from '../../src/renderer/src/components/MessageCalendar';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { selectAllExportContent } from '@weq/service/export-content';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/export.css';
import '../../src/renderer/src/styles/unified-export.css';

useViewState.setState({ openedUin: '10001' });
function Fixture() {
  const [picked, setPicked] = useState('');
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState('');
  return (
    <main style={{ maxWidth: 1050, margin: 'auto', padding: 12, boxSizing: 'border-box' }}>
      <section aria-label="统计中的日历" style={{ maxWidth: 340 }}>
        <MessageCalendar
          allowEmpty
          loading={loading}
          start={picked || '2026-11-01'}
          days={loading ? [] : [{ day: '2025-01-01', count: 10 }]}
          onPick={setPicked}
        />
        <button type="button" onClick={() => setLoading(false)}>
          完成统计
        </button>
        <output data-testid="calendar-selection">{picked}</output>
      </section>
      <ExportLightbox
        embedded
        variant="full"
        headline="导出"
        summary="合成会话"
        initialFormats={[]}
        initialOptions={{ content: selectAllExportContent('none') }}
        onClose={() => {}}
        onConfirm={(value) =>
          setResult(JSON.stringify({ formats: value.formats, content: value.options.content }))
        }
      />
      <pre hidden data-testid="export-result">
        {result}
      </pre>
      <DialogHost />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(createElement(Fixture));
