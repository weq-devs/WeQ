import { useRef, useState } from 'react';
import { Download, ListChecks, ListX, Pencil, Check } from 'lucide-react';
import { client } from '../../trpc/client';
import { useExportSavePolicy } from '../../hooks/useExportSavePolicy';
import { ServerSavePrompt } from '../../components/ServerSavePrompt';
import { useToast } from '../../components/Toast';
import { useExportReportDialog } from './ExportReportControl';
import { contentReferenceKey, type ContentReference } from '../../../../shared/content_selection';
import '../../styles/content-reference-selection.css';

export function ReferenceExportTool({
  initial,
  onClose,
}: {
  initial: ContentReference[];
  onClose?: () => void;
}) {
  const [pool] = useState(() => [
    ...new Map(initial.map((item) => [contentReferenceKey(item), { ...item }])).values(),
  ]);
  const [selected, setSelected] = useState(() => new Set(pool.map(contentReferenceKey)));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const save = useExportSavePolicy();
  const report = useExportReportDialog();
  const toast = useToast((state) => state.push);
  async function submit() {
    if (pending.current || !selected.size || !save.binding) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const binding = { ...save.binding };
    const items = pool
      .filter((item) => selected.has(contentReferenceKey(item)))
      .filter((item) => item.kind !== 'qzone-post')
      .map((item) => ({ ...item }));
    try {
      const includeIntegrityReport = await report.choose();
      if (includeIntegrityReport === null || !save.isCurrent()) return;
      const policy = await save.prepareSave(undefined, { kind: 'bundle', name: '选中的相册内容' });
      if (!policy || !save.isCurrent()) return;
      const id = await client.account.startAlbumReferenceExport.mutate({
        ...binding,
        items,
        name: '选中的相册内容',
        savePolicy: policy,
        includeIntegrityReport,
      });
      if (id && save.isCurrent()) {
        toast({ tone: 'info', title: '相册导出已加入任务列表' });
        onClose?.();
      }
    } catch (reason) {
      if (save.isCurrent()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="weq-reference-export" aria-label="精确内容导出">
      {report.dialog}
      {save.serverLocation ? (
        <ServerSavePrompt name={save.serverLocation.name} onChoose={save.chooseServerLocation} />
      ) : null}
      <header className="weq-reference-toolbar">
        <h3>已选 {selected.size} 项内容</h3>
        <button
          type="button"
          className="weq-set-btn"
          disabled={busy}
          onClick={() => setEditing((value) => !value)}
        >
          <Pencil size={16} />
          {editing ? '完成编辑' : '编辑列表'}
        </button>
        {editing ? (
          <>
            <button
              type="button"
              className="weq-set-iconbtn"
              title={selected.size === pool.length ? '取消全选' : '全选'}
              aria-label="全选或取消全选"
              onClick={() =>
                setSelected(
                  selected.size === pool.length
                    ? new Set()
                    : new Set(pool.map(contentReferenceKey)),
                )
              }
            >
              <ListChecks size={17} />
            </button>
            <button
              type="button"
              className="weq-set-iconbtn"
              title="反选"
              aria-label="反选"
              onClick={() =>
                setSelected(
                  new Set(pool.map(contentReferenceKey).filter((key) => !selected.has(key))),
                )
              }
            >
              <ListX size={17} />
            </button>
          </>
        ) : null}
      </header>
      <div className="weq-reference-export-list">
        {pool.map((item) => {
          const key = contentReferenceKey(item);
          const owner = 'uin' in item ? item.uin : item.groupCode;
          return (
            <button
              type="button"
              key={key}
              className="weq-reference-export-row"
              aria-pressed={selected.has(key)}
              disabled={!editing || busy}
              onClick={() =>
                setSelected((previous) => {
                  const next = new Set(previous);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            >
              <Check size={16} style={{ visibility: selected.has(key) ? 'visible' : 'hidden' }} />
              <span>{item.name || ('albumId' in item ? item.albumId : item.tid)}</span>
              <small>
                {item.kind.endsWith('-album') ? '整本相册' : '媒体'} · {owner}
                {'albumId' in item ? ` · ${item.albumId}` : ''}
              </small>
            </button>
          );
        })}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <footer className="weq-reference-toolbar">
        <button
          type="button"
          className="weq-set-btn primary"
          disabled={busy || !selected.size || !save.binding}
          title={!selected.size ? '尚未选择内容' : undefined}
          onClick={() => void submit()}
        >
          <Download size={16} />
          {busy ? '正在准备' : '开始导出'}
        </button>
      </footer>
    </section>
  );
}
