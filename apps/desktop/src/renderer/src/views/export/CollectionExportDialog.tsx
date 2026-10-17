import { useState } from 'react';
import { Download, X } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { client } from '../../trpc/client';

export function CollectionExportDialog({
  cids,
  onClose,
}: {
  cids?: string[];
  onClose: () => void;
}) {
  const [format, setFormat] = useState<'json' | 'csv' | 'xlsx' | 'txt'>('json');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast((state) => state.push);
  async function start() {
    setBusy(true);
    setError('');
    try {
      await client.account.startCollectionExport.mutate({
        name: cids ? `收藏_${cids.length}条` : '全部收藏',
        format,
        cids,
      });
      toast({
        tone: 'success',
        title: '收藏导出任务已开始',
        detail: '可在导出中心查看进度并保存结果。',
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
        <p>{cids ? `已选 ${cids.length} 条收藏` : '全部收藏'}</p>
        <label>
          文件格式{' '}
          <select
            aria-label="收藏导出格式"
            value={format}
            onChange={(e) => setFormat(e.target.value as typeof format)}
          >
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
            <option value="xlsx">Excel</option>
            <option value="txt">TXT</option>
          </select>
        </label>
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
