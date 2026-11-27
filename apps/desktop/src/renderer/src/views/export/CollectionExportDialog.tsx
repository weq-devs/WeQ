import { usePreferenceState } from '../../lib/clientPreferences';
import { NumericText } from '../../components/NumericText';
import { useState } from 'react';
import { Download, X } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { client } from '../../trpc/client';
import { ExportReportControl } from './ExportReportControl';
import { StructuredExportControls } from './StructuredExportControls';
import { structuredExportOptions } from './StructuredExportControls.shared';

export function CollectionExportDialog({
  cids,
  onClose,
}: {
  cids?: string[];
  onClose: () => void;
}) {
  const [format, setFormat] = usePreferenceState('collectionExportFormat');
  const [structured, setStructured] = usePreferenceState('collectionExportDetails');
  const [busy, setBusy] = useState(false);
  const [includeIntegrityReport, setIncludeIntegrityReport] =
    usePreferenceState('exportIntegrityReport');
  const [error, setError] = useState('');
  async function start() {
    setBusy(true);
    setError('');
    try {
      await client.account.startCollectionExport.mutate({
        ...structuredExportOptions(structured, [format]),
        name: cids ? `收藏_${cids.length}条` : '全部收藏',
        format,
        cids,
        includeIntegrityReport,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal onClose={onClose} width={400} labelledBy="collection-export-title">
      <div className="weq-message-calendar">
        <header>
          <h3 id="collection-export-title">导出收藏</h3>
          <button type="button" className="weq-dialog-x" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p>{cids ? <NumericText>{`已选 ${cids.length} 条收藏`}</NumericText> : '全部收藏'}</p>
        <label>
          文件格式{' '}
          <SegmentedControl
            label="收藏导出格式"
            value={format}
            disabled={busy}
            onChange={setFormat}
            options={[
              { value: 'json', label: 'JSON' },
              { value: 'jsonl', label: 'JSONL' },
              { value: 'jsonl.gz', label: 'JSONL.GZ' },
              { value: 'csv', label: 'CSV' },
              { value: 'xlsx', label: 'Excel' },
              { value: 'txt', label: 'TXT' },
            ]}
          />
        </label>
        <StructuredExportControls
          domain="collectionProperties"
          onRequireJson={() => setFormat('json')}
          options={structured}
          formats={[format]}
          disabled={busy}
          onChange={(value) => setStructured((current) => ({ ...current, ...value }))}
        />
        <ExportReportControl
          checked={includeIntegrityReport}
          onChange={setIncludeIntegrityReport}
          disabled={busy}
        />
        {error ? <p role="alert">{error}</p> : null}
        <div className="weq-dialog-actions">
          <button
            type="button"
            className="weq-action-primary"
            disabled={busy}
            onClick={() => void start()}
          >
            <Download size={15} />
            {busy ? '创建中…' : '开始导出'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
import { SegmentedControl } from '../../components/SegmentedControl';
