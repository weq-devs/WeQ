// @ts-nocheck
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Check, File, FolderOpen, Loader2, X } from 'lucide-react';
import { closeFromScrim, useEscapeToClose } from '../../im-template/template/modalUtils';
import { client } from '../../trpc/client';

interface GroupFileEntry {
  fileId: string;
  fileName: string;
  fileSize: number;
  busId: number;
  uploaderName: string;
  /** 相对根目录的文件夹路径段,导出时用来重建目录树。 */
  path: string[];
}

export interface GroupFileExportResult {
  outputDir: string;
  selectedFiles: GroupFileEntry[];
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/**
 * 递归遍历整个群的文件树。后端的 listRecursive 不走 IPC(只在导出时用),
 * 所以这里按目录逐层调 listGroupFiles 自己拼路径。
 */
async function collectAll(groupCode: string): Promise<GroupFileEntry[]> {
  const out: GroupFileEntry[] = [];
  const queue: Array<{ dir: string; path: string[] }> = [{ dir: '/', path: [] }];
  const seen = new Set<string>(['/']);

  while (queue.length > 0) {
    const { dir, path } = queue.shift()!;
    const listing = await client.account.listGroupFiles.query({ groupCode, folderId: dir });
    for (const f of listing.files) {
      out.push({
        fileId: f.fileId,
        fileName: f.fileName,
        fileSize: f.fileSize,
        busId: f.busId,
        uploaderName: f.uploaderName,
        path,
      });
    }
    for (const folder of listing.folders) {
      if (!folder.folderId || seen.has(folder.folderId)) continue;
      seen.add(folder.folderId);
      queue.push({ dir: folder.folderId, path: [...path, folder.folderName || folder.folderId] });
    }
  }

  return out;
}

export function GroupFileExportLightbox({
  groupCode,
  groupName,
  outputDir,
  submitting,
  onPickPath,
  onClose,
  onConfirm,
}: {
  groupCode: string;
  groupName: string;
  outputDir: string | null;
  submitting?: boolean;
  onPickPath: () => Promise<string | null>;
  onClose: () => void;
  onConfirm: (result: GroupFileExportResult) => void;
}): ReactElement {
  useEscapeToClose(onClose);
  const [files, setFiles] = useState<GroupFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [picking, setPicking] = useState(false);

  // fileId 在同群内唯一,直接当选择键。
  const selectedFiles = useMemo(
    () => files.filter((f) => selection.has(f.fileId)),
    [files, selection],
  );
  const totalSize = useMemo(
    () => selectedFiles.reduce((sum, f) => sum + f.fileSize, 0),
    [selectedFiles],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFiles([]);
    setSelection(new Set());

    collectAll(groupCode)
      .then((all) => {
        if (cancelled) return;
        setFiles(all);
        setSelection(new Set(all.map((f) => f.fileId)));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [groupCode]);

  function toggle(id: string): void {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function pickPath(): Promise<void> {
    setPicking(true);
    try {
      await onPickPath();
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className="modal-scrim weq-exp-modal-scrim" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <section
        className="weq-exp-dialog weq-exp-album-dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="weq-exp-dialog-head">
          <div className="weq-exp-dialog-title">
            <strong>导出群文件</strong>
            <span title={groupName}>{groupName}</span>
          </div>
          <button type="button" className="weq-exp-dialog-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="weq-exp-dialog-body">
          <section className="weq-exp-album-path">
            <span className="weq-exp-path" title={outputDir ?? undefined}>
              <FolderOpen size={14} aria-hidden />
              <span className="weq-exp-path-txt">{outputDir ?? '未选择保存目录'}</span>
            </span>
            <button type="button" className="weq-exp-btn" disabled={picking || submitting} onClick={() => void pickPath()}>
              {picking ? <Loader2 size={14} className="weq-exp-spin" /> : <FolderOpen size={14} />}
              选择目录
            </button>
          </section>

          <section className="weq-exp-album-tools">
            <button
              type="button"
              className="weq-exp-tool"
              disabled={loading || files.length === 0 || submitting}
              onClick={() => setSelection(new Set(files.map((f) => f.fileId)))}
            >
              全选
            </button>
            <button
              type="button"
              className="weq-exp-tool"
              disabled={loading || files.length === 0 || submitting}
              onClick={() =>
                setSelection((current) => new Set(files.filter((f) => !current.has(f.fileId)).map((f) => f.fileId)))
              }
            >
              反选
            </button>
            <span className="weq-exp-tools-spacer" />
            <span className="weq-exp-tools-count">
              已选 {selection.size}
              {totalSize > 0 ? ` · ${formatSize(totalSize)}` : ''}
            </span>
          </section>

          <div className="weq-exp-album-list">
            {loading ? (
              <div className="weq-exp-list-state">
                <Loader2 size={18} className="weq-exp-spin" />
                <span>正在遍历群文件喵~</span>
              </div>
            ) : error ? (
              <div className="weq-exp-list-state is-error">{error}</div>
            ) : files.length === 0 ? (
              <div className="weq-exp-list-state">这个群暂无文件</div>
            ) : (
              files.map((file, index) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: fileId 理论上唯一,但同一文件重复上传过会撞,补索引兜底
                  key={`${file.fileId}:${index}`}
                  type="button"
                  className={`weq-exp-album-row${selection.has(file.fileId) ? ' is-on' : ''}`}
                  disabled={submitting}
                  onClick={() => toggle(file.fileId)}
                >
                  <span className="weq-exp-album-cover is-empty">
                    <File size={18} />
                  </span>
                  <span className="weq-exp-row-meta">
                    <strong title={[...file.path, file.fileName].join('/')}>{file.fileName}</strong>
                    <small>
                      {formatSize(file.fileSize)}
                      {file.path.length ? ` · ${file.path.join('/')}` : ''}
                      {file.uploaderName ? ` · ${file.uploaderName}` : ''}
                    </small>
                  </span>
                  <span className="weq-exp-row-check">{selection.has(file.fileId) ? <Check size={14} /> : null}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <footer className="weq-exp-dialog-foot">
          <button type="button" className="weq-exp-btn" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="weq-exp-btn is-primary"
            disabled={submitting || loading || Boolean(error) || !outputDir || selectedFiles.length === 0}
            onClick={() => outputDir && onConfirm({ outputDir, selectedFiles })}
          >
            {submitting ? <Loader2 size={15} className="weq-exp-spin" /> : null}
            开始导出
          </button>
        </footer>
      </section>
    </div>
  );
}
