// @ts-nocheck
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ArrowLeft, ChevronRight, Loader2, Square, X } from 'lucide-react';
import { client } from '../trpc/client';
import { MediaSaveControls, useMediaSave } from './MediaSaveControls';
import { OverlayLayer } from './OverlayLayer';
import { fileIconUrl } from '../lib/resourceUrl';
import { GroupFileActions } from './qq-actions/GroupFileActions';
import { fileExtIcon, formatFileTime, formatSize, type GroupFileListing } from '../lib/groupFile';

/** 目录面包屑的一层。根目录的 id 固定是 '/'。 */
interface Crumb {
  id: string;
  name: string;
}

const ROOT: Crumb = { id: '/', name: '全部文件' };

export function GroupFileDialog({
  groupCode,
  groupName,
  initialFolderId,
  initialFileId,
  onClose,
}: {
  groupCode: string;
  groupName: string;
  initialFolderId?: string;
  initialFileId?: string;
  onClose: () => void;
}): ReactElement {
  const mediaSave = useMediaSave();
  const [crumbs, setCrumbs] = useState<Crumb[]>(
    initialFolderId && initialFolderId !== '/'
      ? [ROOT, { id: initialFolderId, name: '定位目录' }]
      : [ROOT],
  );
  const root = useRef<HTMLElement>(null);
  const [searchMissing, setSearchMissing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [listing, setListing] = useState<GroupFileListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 正在换取直链的 fileId —— 用来给那一行的下载按钮转圈。 */

  const current = crumbs[crumbs.length - 1] ?? ROOT;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client.account.listGroupFiles
      .query({ groupCode, folderId: current.id })
      .then((res) => {
        if (cancelled) return;
        setListing(res as GroupFileListing);
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
  }, [groupCode, current.id, revision]);
  useEffect(() => {
    if (!initialFileId || loading || error || !listing || current.id !== (initialFolderId ?? '/')) {
      setSearchMissing(false);
      return;
    }
    setSearchMissing(!listing.files.some((file) => file.fileId === initialFileId));
    const row = [...(root.current?.querySelectorAll<HTMLElement>('[data-file-id]') ?? [])].find(
      (item) => item.dataset.fileId === initialFileId,
    );
    row?.scrollIntoView({ block: 'center' });
  }, [initialFileId, initialFolderId, current.id, loading, error, listing]);

  const summary = useMemo(() => {
    if (!listing) return '';
    const parts: string[] = [];
    if (listing.folders.length) parts.push(`${listing.folders.length} 个文件夹`);
    parts.push(`${listing.files.length} 个文件`);
    return parts.join(' · ');
  }, [listing]);

  return (
    <OverlayLayer
      presentation="sidecar"
      title="群文件"
      className="modal-scrim group-album-scrim"
      onClose={onClose}
    >
      <section
        className="group-album-dialog group-file-dialog"
        ref={root}
        role="region"
        aria-label={`${groupName}的群文件`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {mediaSave.prompt}
        <header>
          <div>
            <strong>群文件</strong>
            <span>{groupName}</span>
          </div>
          {mediaSave.downloading && (
            <button
              className="icon-button"
              type="button"
              title="停止本次下载"
              aria-label="停止当前媒体下载"
              onClick={() => void mediaSave.cancel()}
            >
              <Square size={16} />
            </button>
          )}
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        {searchMissing ? <p role="status">搜索命中的文件已删除或当前目录不可见。</p> : null}
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

          <GroupFileActions
            key={`${groupCode}:${current.id}`}
            groupId={Number(groupCode)}
            directory={current.id}
            files={loading ? [] : (listing?.files ?? [])}
            folders={loading ? [] : (listing?.folders ?? [])}
            onChanged={() => setRevision((value) => value + 1)}
          />
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
                    <img src={fileIconUrl('folder.png')} className="group-file-icon" alt="" />
                    <span className="group-file-main">
                      <strong>{folder.folderName || '未命名文件夹'}</strong>
                      <small>
                        {folder.totalFileCount} 个文件
                        {folder.creatorName ? ` · ${folder.creatorName}` : ''}
                      </small>
                    </span>
                    <ChevronRight size={14} className="group-file-chevron" />
                  </button>
                </li>
              ))}
              {listing.files.map((file) => (
                <li
                  key={`${file.fileId}:${file.uploadedTime}`}
                  data-file-id={file.fileId}
                  className={
                    file.fileId === initialFileId && current.id === (initialFolderId ?? '/')
                      ? 'is-search-hit'
                      : undefined
                  }
                >
                  <div className="group-file-row">
                    <img
                      src={fileIconUrl(fileExtIcon(file.fileName))}
                      className="group-file-icon"
                      alt=""
                    />
                    <span className="group-file-main">
                      <strong title={file.fileName}>{file.fileName}</strong>
                      <small>
                        {formatSize(file.fileSize)}
                        {file.uploaderName ? ` · ${file.uploaderName}` : ''}
                        {file.uploadedTime ? ` · ${formatFileTime(file.uploadedTime)}` : ''}
                      </small>
                    </span>
                    <MediaSaveControls
                      save={mediaSave}
                      source={{
                        kind: 'group-file',
                        groupCode,
                        fileId: file.fileId,
                        fileName: file.fileName,
                        busId: file.busId,
                      }}
                      className="icon-button"
                      label={`保存 ${file.fileName}`}
                      iconOnly
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </OverlayLayer>
  );
}
