import { useEffect } from 'react';
import { Download, X } from 'lucide-react';
import { Modal } from './Dialog';
import { useViewState } from '../state/view';
import '../styles/client-document.css';
import { useClientDocument } from './ClientDocumentPreview.shared';

export function ClientDocumentPreview() {
  const item = useClientDocument((state) => state.document);
  const account = useViewState((state) => state.openedUin);
  useEffect(() => {
    useClientDocument.setState({ document: null });
  }, [account]);
  if (!item) return null;
  const preview = new URL(item.url);
  preview.searchParams.set('preview', '1');
  const close = () => useClientDocument.setState({ document: null });
  return (
    <Modal
      onClose={close}
      centered
      width="min(960px, 100%)"
      className="weq-client-document"
      labelledBy="weq-client-document-title"
    >
      <header>
        <strong id="weq-client-document-title">{item.title}</strong>
        <a href={item.url} download aria-label="下载报告" title="下载报告">
          <Download size={18} />
        </a>
        <button type="button" onClick={close} aria-label="关闭报告" title="关闭报告">
          <X size={18} />
        </button>
      </header>
      <iframe title={item.title} src={preview.href} sandbox="allow-scripts" />
    </Modal>
  );
}
