// @ts-nocheck
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { ArrowLeft, Download, File, Folder, Loader2, X } from 'lucide-react';
import { client } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';

interface GroupFileWire {
  fileId: string;
  fileName: string;
  fileSize: number;
  busId: number;
  uploadedTime: number;
  expireTime: number;
  modifiedTime: number;
  downloadedTimes: number;
  uploaderUin: number;
  uploaderName: string;
  parentDirectory: string;
}

interface GroupFolderWire {
  folderId: string;
  parentDirectoryId: string;
  folderName: string;
  createTime: number;
  modifiedTime: number;
  creatorUin: number;
  creatorName: string;
  totalFileCount: number;
}

interface Listing {
  targetDirectory: string;
  files: GroupFileWire[];
  folders: GroupFolderWire[];
}

/** 目录面包屑的一层。根目录的 id 固定是 '/'。 */
interface Crumb {
  id: string;
  name: string;
}

const ROOT: Crumb = { id: '/', name: '全部文件' };

function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatTime(seconds: number): string {
  if (!seconds) return '';
  const d = new Date(seconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function GroupFileDialog({
  groupCode,
  groupName,
  onClose,
}: {
  groupCode: string;
  groupName: string;
  onClose: () => void;
}): ReactElement {
  useEscapeToClose(onClose);
  const dialog = useAppDialog();
  const [crumbs, setCrumbs] = useState<Crumb[]>([ROOT]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 正在换取直链的 fileId —— 用来给那一行的下载按钮转圈。 */
  const [downloading, setDownloading] = useState<string | null>(null);

  const current = crumbs[crumbs.length - 1] ?? ROOT;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client.account.listGroupFiles
      .query({ groupCode, folderId: current.id })
      .then((res) => {
        if (cancelled) return;
        setListing(res as Listing);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setListing(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupCode, current.id]);

  const download = useCallback(
    async (file: GroupFileWire): Promise<void> => {
      setDownloading(file.fileId);
      try {
        // 直链有时效,每次点击现取。交给浏览器/系统去下,不占主进程。
        const url = await client.account.getGroupFileUrl.mutate({
          groupCode,
          fileId: file.fileId,
          fileName: file.fileName,
          busId: file.busId,
        });
        const a = document.createElement('a');
        a.href = url;
        a.download = file.fileName;
        a.rel = 'noreferrer';
        a.click();
      } catch (e) {
        dialog.error('获取下载链接失败', e instanceof Error ? e.message : String(e));
      } finally {
        setDownloading(null);
      }
    },
    [groupCode, dialog],
  );

  const summary = useMemo(() => {
    if (!listing) return '';
    const parts: string[] = [];
    if (listing.folders.length) parts.push(`${listing.folders.length} 个文件夹`);
    parts.push(`${listing.files.length} 个文件`);
    return parts.join(' · ');
  }, [listing]);

  return (
    <div className="modal-scrim group-album-scrim" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <section
        className="group-album-dialog group-file-dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <strong>群文件</strong>
            <span>{groupName}</span>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="group-album-body">
          <div className="group-file-toolbar">
            <div className="group-file-crumbs">
              {crumbs.length > 1 ? (
                <button
                  type="button"
                  className="group-album-back"
                  onClick={() => setCrumbs((c) => c.slice(0, -1))}
                >
                  <ArrowLeft size={14} /> 返回上级
                </button>
              ) : null}
              <span title={crumbs.map((c) => c.name).join(' / ')}>
                {crumbs.map((c) => c.name).join(' / ')}
              </span>
            </div>
            <span className="group-file-summary">{summary}</span>
          </div>

          {loading ? (
            <div className="group-album-state">
              <Loader2 size={18} className="weq-spin" />
              <span>正在查询群文件喵~</span>
            </div>
          ) : error ? (
            <div className="group-album-state is-error">{error}</div>
          ) : !listing || listing.files.length + listing.folders.length === 0 ? (
            <div className="group-album-state">这个目录还没有文件</div>
          ) : (
            <ul className="group-file-list">
              {listing.folders.map((folder) => (
                <li key={folder.folderId}>
                  <button
                    type="button"
                    className="group-file-row is-folder"
                    onClick={() =>
                      setCrumbs((c) => [
                        ...c,
                        { id: folder.folderId, name: folder.folderName || folder.folderId },
                      ])
                    }
                  >
                    <Folder size={18} />
                    <span className="group-file-main">
                      <strong>{folder.folderName || '未命名文件夹'}</strong>
                      <small>
                        {folder.totalFileCount} 个文件
                        {folder.creatorName ? ` · ${folder.creatorName}` : ''}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
              {listing.files.map((file) => (
                <li key={`${file.fileId}:${file.uploadedTime}`}>
                  <div className="group-file-row">
                    <File size={18} />
                    <span className="group-file-main">
                      <strong title={file.fileName}>{file.fileName}</strong>
                      <small>
                        {formatSize(file.fileSize)}
                        {file.uploaderName ? ` · ${file.uploaderName}` : ''}
                        {file.uploadedTime ? ` · ${formatTime(file.uploadedTime)}` : ''}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="icon-button"
                      title="下载"
                      disabled={downloading === file.fileId}
                      onClick={() => void download(file)}
                    >
                      {downloading === file.fileId ? (
                        <Loader2 size={16} className="weq-spin" />
                      ) : (
                        <Download size={16} />
                      )}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
