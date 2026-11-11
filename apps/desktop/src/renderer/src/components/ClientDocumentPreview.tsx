import { create } from 'zustand';
import { useEffect } from 'react';
import { Download, X } from 'lucide-react';
import { Modal } from './Dialog';
import { IS_WEB } from '../lib/target';
import { useViewState } from '../state/view';
import '../styles/client-document.css';

const useClientDocument = create<{ document: { url: string; title: string } | null }>(() => ({
  document: null,
}));

/** 浏览器结果必须由当前客户端实际呈现，不能把服务端空操作当作已打开。 */
export function presentClientDocument(result: unknown, title: string): void {
  if (!IS_WEB || !result || typeof result !== 'object') return;
  const value = result as { openUrl?: unknown; downloadUrl?: unknown };
  if (typeof value.openUrl === 'string') {
    const url = new URL(value.openUrl, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/_download/'))
      throw new Error('报告地址不可用');
    useClientDocument.setState({ document: { url: url.href, title } });
  } else if (typeof value.downloadUrl === 'string') {
    const link = document.createElement('a');
    link.href = value.downloadUrl;
    link.download = '';
    link.click();
  }
}

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
