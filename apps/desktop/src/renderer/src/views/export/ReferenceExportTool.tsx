import { useRef, useState } from 'react';
import { Download, CheckCheck, FlipHorizontal2, X, Check, Loader2 } from 'lucide-react';
import { client } from '../../trpc/client';
import { useExportSavePolicy } from '../../hooks/useExportSavePolicy';
import { ServerSavePrompt } from '../../components/ServerSavePrompt';
import { useToast } from '../../components/Toast';
import { ExportReportControl } from './ExportReportControl';
import { WindowedList } from '../../components/WindowedList';
import { contentReferenceKey, type ContentReference } from '../../../../shared/content_selection';
import '../../styles/content-reference-selection.css';
import '../../styles/export.css';

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
  const [includeIntegrityReport, setIncludeIntegrityReport] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const save = useExportSavePolicy();
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
      if (!save.isCurrent()) return;
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
      {save.serverLocation ? (
        <ServerSavePrompt name={save.serverLocation.name} onChoose={save.chooseServerLocation} />
      ) : null}
      <header className="weq-exp-tools weq-reference-export-head">
        <h3>已选 {selected.size} 项内容</h3>
        <button
          type="button"
          className="weq-exp-tool"
          title={selected.size === pool.length ? '取消全选' : '全选'}
          aria-label={selected.size === pool.length ? '取消全选' : '全选'}
          disabled={busy}
          onClick={() =>
            setSelected(
              selected.size === pool.length ? new Set() : new Set(pool.map(contentReferenceKey)),
            )
          }
        >
          <CheckCheck size={16} aria-hidden />
        </button>
        <button
          type="button"
          className="weq-exp-tool"
          title="反选"
          aria-label="反选"
          disabled={busy}
          onClick={() =>
            setSelected(new Set(pool.map(contentReferenceKey).filter((key) => !selected.has(key))))
          }
        >
          <FlipHorizontal2 size={16} aria-hidden />
        </button>
        <button
          type="button"
          className="weq-exp-tool"
          title="清空选择"
          aria-label="清空选择"
          disabled={busy || !selected.size}
          onClick={() => setSelected(new Set())}
        >
          <X size={16} aria-hidden />
        </button>
      </header>
      <WindowedList
        items={pool}
        height={Math.min(352, Math.max(64, pool.length * 64))}
        rowHeight={64}
        itemKey={contentReferenceKey}
        className="weq-reference-export-list"
        label="已选内容范围"
        renderItem={(item) => {
          const key = contentReferenceKey(item);
          const owner = 'uin' in item ? item.uin : item.groupCode;
          return (
            <label
              className={`weq-exp-row weq-reference-export-row${selected.has(key) ? ' is-on' : ''}`}
            >
              <input
                type="checkbox"
                className="weq-reference-export-checkbox"
                aria-label={`选择 ${item.name || ('albumId' in item ? item.albumId : item.tid)} · ${owner}${'albumId' in item ? ` · ${item.albumId}` : ''}`}
                checked={selected.has(key)}
                disabled={busy}
                onChange={() =>
                  setSelected((previous) => {
                    const next = new Set(previous);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              />
              <span className="weq-exp-row-meta">
                <strong>{item.name || ('albumId' in item ? item.albumId : item.tid)}</strong>
                <small>
                  {item.kind.endsWith('-album') ? '整本相册' : '媒体'} · {owner}
                  {'albumId' in item ? ` · ${item.albumId}` : ''}
                </small>
              </span>
              <span className="weq-exp-row-check" aria-hidden>
                {selected.has(key) ? <Check size={14} /> : null}
              </span>
            </label>
          );
        }}
      />
      <ExportReportControl
        checked={includeIntegrityReport}
        onChange={setIncludeIntegrityReport}
        disabled={busy}
      />
      {error ? <p role="alert">{error}</p> : null}
      <footer className="weq-exp-dialog-foot">
        <button
          type="button"
          className="weq-exp-btn is-primary"
          disabled={busy || !selected.size || !save.binding}
          title={!selected.size ? '尚未选择内容' : undefined}
          onClick={() => void submit()}
        >
          {busy ? (
            <Loader2 size={16} className="weq-spin" aria-hidden />
          ) : (
            <Download size={16} aria-hidden />
          )}
          {busy ? '正在准备' : '开始导出'}
        </button>
      </footer>
    </section>
  );
}
