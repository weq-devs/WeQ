import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useExportReportDialog } from '../../src/renderer/src/views/export/ExportReportControl';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/export.css';

function Fixture() {
  const report = useExportReportDialog();
  const [result, setResult] = useState('pending');
  return (
    <main>
      <button type="button" onClick={async () => setResult(String(await report.choose()))}>
        批量导出
      </button>
      <output>{result}</output>
      {report.dialog}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(createElement(Fixture));
