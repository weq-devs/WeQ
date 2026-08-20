/**
 * 闪传文件浏览弹窗 —— 替代原来的「点卡片 → 换 sharelink → webview」。
 *
 * 卡片点击后直接打开这个竖屏弹窗，用 qfile 匿名 HTTP2RPC 拉文件列表，
 * 支持展开文件夹 / 压缩包、多选下载到 WeQ 本地缓存目录。顶部提供「分享」
 * （换 sharelink 后仍走原来的 webview 弹窗）和「下载任务」入口。
 *
 * 布局：竖屏弹窗（同原 webview 尺寸比例），文件用横排小卡片按宽度自适应列数。
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { ArrowLeft, Check, Download, FolderOpen, Loader2, Share2, X } from 'lucide-react';
import { Modal } from './Dialog';
import { FlashShareDialog } from './FlashShareDialog';
import { FlashTransferTasksDialog } from './FlashTransferTasksDialog';
import { client } from '../trpc/client';
import { fileIconUrl } from '../lib/resourceUrl';
import { useToast } from './Toast';
import '../styles/flash-transfer.css';

/** 与 service 端 FlashListFile 对齐的线格式。 */
interface FlashEntry {
  name: string;
  isDir: boolean;
  fileSize: number;
  fileId: string;
  physicalId: string;
  filesetId: string;
  status: number;
  path: string;
  isZipContent: boolean;
  zipFileId: string;
}

interface Crumb {
  name: string;
  /** 目录 id；根为 ''。 */
  id: string;
  /** 压缩包上下文（zip 的 cli_fileid）；普通浏览为 ''。 */
  zipFileId: string;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

const ZIP_RE = /\.(zip|rar|7z)$/i;

function fileExtIcon(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    doc: 'doc.png',
    docx: 'doc.png',
    xls: 'xls.png',
    xlsx: 'xls.png',
    ppt: 'ppt.png',
    pptx: 'ppt.png',
    pdf: 'pdf.png',
    zip: 'rar.png',
    '7z': 'rar.png',
    rar: 'rar.png',
    gz: 'rar.png',
    tar: 'rar.png',
    exe: 'exe.png',
    msi: 'exe.png',
    mp3: 'audio.png',
    wav: 'audio.png',
    flac: 'audio.png',
    aac: 'audio.png',
    ogg: 'audio.png',
    m4a: 'audio.png',
    mp4: 'video.png',
    avi: 'video.png',
    mov: 'video.png',
    mkv: 'video.png',
    flv: 'video.png',
    wmv: 'video.png',
    png: 'image.png',
    jpg: 'image.png',
    jpeg: 'image.png',
    gif: 'image.png',
    webp: 'image.png',
    bmp: 'image.png',
    svg: 'image.png',
    txt: 'txt.png',
    md: 'txt.png',
    log: 'txt.png',
    json: 'code.png',
    apk: 'apk.png',
    bak: 'bak.png',
    dmg: 'dmg.png',
    ipa: 'ipa.png',
    pkg: 'pkg.png',
    js: 'code.png',
    ts: 'code.png',
    jsx: 'code.png',
    tsx: 'code.png',
    py: 'code.png',
    java: 'code.png',
    c: 'code.png',
    cpp: 'code.png',
    cs: 'code.png',
    go: 'code.png',
    rs: 'code.png',
    html: 'code.png',
    css: 'code.png',
    ttf: 'font.png',
    otf: 'font.png',
    woff: 'font.png',
    woff2: 'font.png',
  };
  return map[ext] ?? 'unknown.png';
}

export function FlashTransferViewer({
  filesetId,
  title,
  onClose,
}: {
  filesetId: string;
  title: string;
  onClose: () => void;
}): ReactElement | null {
  const pushToast = useToast((s) => s.push);
  const [crumbs, setCrumbs] = useState<Crumb[]>([
    { name: title || '闪传文件', id: '', zipFileId: '' },
  ]);
  const [entries, setEntries] = useState<FlashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, FlashEntry>>(new Map());
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const current = crumbs[crumbs.length - 1] ?? crumbs[0]!;

  /** 拉一个目录；crumb 必须是最新的（进入前已 setCrumbs）。 */
  const fetchList = useCallback(
    async (pathCrumbs: Crumb[], parentId: string, zipFileId: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const res = await client.account.flashListFiles.query({ filesetId, parentId, zipFileId });
        const prefix = pathCrumbs
          .slice(1)
          .map((c) => c.name)
          .join('/');
        const isZipCtx = zipFileId.length > 0;
        const list = (res.files ?? []).map((raw) => {
          const name = raw.name || '未知文件';
          const path = prefix ? `${prefix}/${name}` : name;
          const status = isZipCtx ? 2 : Number(raw.status ?? 0);
          return {
            name,
            isDir: raw.isDir === true,
            fileSize: Number(raw.fileSize ?? 0),
            fileId: raw.fileId || '',
            physicalId: raw.physicalId || '',
            filesetId: raw.filesetId || filesetId,
            status,
            path,
            isZipContent: isZipCtx,
            zipFileId: isZipCtx ? zipFileId : '',
          } as FlashEntry;
        });
        setEntries(list);
      } catch (e) {
        setEntries([]);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [filesetId],
  );

  // 初始加载根目录。
  useEffect(() => {
    void fetchList([{ name: title || '闪传文件', id: '', zipFileId: '' }], '', '');
  }, [fetchList, title]);

  const navTo = (targetIndex: number): void => {
    const next = crumbs.slice(0, targetIndex + 1);
    const top = next[next.length - 1]!;
    setCrumbs(next);
    setSelected(new Map());
    void fetchList(next, top.id, top.zipFileId);
  };

  const enterItem = (file: FlashEntry): void => {
    const isZip = ZIP_RE.test(file.name) && !current.zipFileId && file.status === 2;
    if (file.isDir) {
      const next: Crumb[] = [
        ...crumbs,
        { name: file.name, id: file.fileId, zipFileId: current.zipFileId },
      ];
      setCrumbs(next);
      setSelected(new Map());
      void fetchList(next, file.fileId, current.zipFileId);
    } else if (isZip) {
      const next: Crumb[] = [...crumbs, { name: file.name, id: '', zipFileId: file.fileId }];
      setCrumbs(next);
      setSelected(new Map());
      void fetchList(next, '', file.fileId);
    }
  };

  const isReady = (file: FlashEntry): boolean => file.status === 2;

  const isAncestorSelected = (path: string): boolean => {
    for (const item of selected.values()) {
      if (item.isDir && path.startsWith(`${item.path}/`)) return true;
    }
    return false;
  };

  const selectKey = (file: FlashEntry): string =>
    `${file.isZipContent ? 'zip:' : 'dir:'}${file.fileId}`;

  const toggleSelect = (file: FlashEntry): void => {
    if (!isReady(file) || isAncestorSelected(file.path)) return;
    setSelected((prev) => {
      const next = new Map(prev);
      const key = selectKey(file);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.set(key, file);
        if (file.isDir) {
          for (const [id, item] of next.entries()) {
            if (id !== key && item.path.startsWith(`${file.path}/`)) next.delete(id);
          }
        }
      }
      return next;
    });
  };

  const toggleAll = (checked: boolean): void => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const file of entries) {
        if (!isReady(file) || isAncestorSelected(file.path)) continue;
        const key = selectKey(file);
        if (checked) next.set(key, file);
        else next.delete(key);
      }
      return next;
    });
  };

  const handleRowClick = (file: FlashEntry): void => {
    if (file.isDir) {
      enterItem(file);
      return;
    }
    if (ZIP_RE.test(file.name) && !current.zipFileId && isReady(file)) {
      enterItem(file);
      return;
    }
    toggleSelect(file);
  };

  const handleShare = async (): Promise<void> => {
    if (sharing) return;
    setSharing(true);
    try {
      const res = await client.account.getFlashShareLink.mutate({ fileSetId: filesetId });
      if (!res.ok) {
        pushToast({
          tone: res.reason === 'offline' ? 'warning' : 'error',
          message:
            res.reason === 'offline' ? 'QQ 未在线，无法获取闪传分享链接' : '获取闪传分享链接失败',
          detail: res.reason === 'error' ? res.message : undefined,
        });
        return;
      }
      setShareUrl(res.shareUrl);
    } catch (e) {
      pushToast({
        tone: 'error',
        message: '获取闪传分享链接失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSharing(false);
    }
  };

  const handleStart = async (): Promise<void> => {
    const items = Array.from(selected.values());
    if (items.length === 0 || starting) return;
    setStarting(true);
    try {
      const res = await client.account.flashStartDownloads.mutate({
        filesetName: crumbs[0]?.name || title || '闪传下载',
        selections: items.map((it) => ({
          filesetId: it.filesetId,
          fileId: it.fileId,
          physicalId: it.physicalId,
          name: it.name,
          fileSize: it.fileSize,
          path: it.path,
          isDir: it.isDir,
          isZipContent: it.isZipContent,
          zipFileId: it.zipFileId,
        })),
      });
      setSelected(new Map());
      pushToast({ tone: 'success', message: `已加入下载队列（${res.started} 个文件）` });
      if (res.errors.length > 0) {
        pushToast({ tone: 'warning', message: '部分文件无法解析', detail: res.errors[0] });
      }
      setTasksOpen(true);
    } catch (e) {
      pushToast({
        tone: 'error',
        message: '启动下载失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setStarting(false);
    }
  };

  const selectedCount = selected.size;
  const selectedSize = useMemo(
    () => Array.from(selected.values()).reduce((sum, f) => sum + f.fileSize, 0),
    [selected],
  );
  const allReadyCount = entries.filter((f) => isReady(f) && !isAncestorSelected(f.path)).length;
  const allChecked =
    allReadyCount > 0 &&
    entries.every((f) => !isReady(f) || selected.has(selectKey(f)) || isAncestorSelected(f.path));

  return (
    <>
      <Modal onClose={onClose} width={520}>
        <div className="weq-ft">
          <header className="weq-ft-head">
            <span className="weq-ft-title" title={crumbs[0]?.name}>
              {crumbs[0]?.name || 'QQ闪传'}
            </span>
            <div className="weq-ft-actions">
              <button
                type="button"
                className="weq-ft-btn"
                onClick={() => setTasksOpen(true)}
                title="下载任务"
              >
                <Download size={15} strokeWidth={1.9} aria-hidden />
                <span>下载任务</span>
              </button>
              <button
                type="button"
                className="weq-ft-btn"
                onClick={() => void handleShare()}
                disabled={sharing}
                title="分享"
              >
                {sharing ? (
                  <Loader2 size={15} strokeWidth={1.9} className="weq-spin" aria-hidden />
                ) : (
                  <Share2 size={15} strokeWidth={1.9} aria-hidden />
                )}
                <span>分享</span>
              </button>
              <button
                type="button"
                className="weq-ft-close"
                onClick={onClose}
                aria-label="关闭"
                title="关闭"
              >
                <X size={16} strokeWidth={1.9} aria-hidden />
              </button>
            </div>
          </header>

          <nav className="weq-ft-crumbs">
            {crumbs.map((crumb, i) => (
              <span key={`${crumb.zipFileId}::${crumb.id}::${crumb.name}`} className="weq-ft-crumb">
                {i > 0 ? (
                  <ArrowLeft size={12} strokeWidth={2} className="weq-ft-crumb-sep" aria-hidden />
                ) : null}
                <button
                  type="button"
                  className={i === crumbs.length - 1 ? 'weq-ft-crumb-current' : 'weq-ft-crumb-link'}
                  onClick={() => navTo(i)}
                  disabled={i === crumbs.length - 1}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>

          <div className="weq-ft-toolbar">
            <label className="weq-ft-select-all">
              <input
                type="checkbox"
                checked={allChecked}
                disabled={allReadyCount === 0}
                onChange={(e) => toggleAll(e.target.checked)}
              />
              <span>全选</span>
            </label>
            {current.zipFileId ? (
              <span className="weq-ft-toolbar-hint">正在浏览压缩包内容</span>
            ) : null}
          </div>

          <div className="weq-ft-body">
            {loading ? (
              <div className="weq-ft-loading">
                <Loader2 size={22} strokeWidth={1.9} className="weq-spin" aria-hidden />
              </div>
            ) : error ? (
              <div className="weq-ft-error">
                <p>加载失败：{error}</p>
              </div>
            ) : entries.length === 0 ? (
              <div className="weq-ft-empty">
                <FolderOpen size={34} strokeWidth={1.5} aria-hidden />
                <p>这里没有文件</p>
              </div>
            ) : (
              <div className="weq-ft-grid">
                {entries.map((file) => {
                  const ready = isReady(file);
                  const key = selectKey(file);
                  const checked = selected.has(key) || isAncestorSelected(file.path);
                  const icon = file.isDir
                    ? 'folder.png'
                    : file.name && ZIP_RE.test(file.name)
                      ? 'rar.png'
                      : fileExtIcon(file.name);
                  return (
                    <div
                      key={key}
                      role="button"
                      tabIndex={0}
                      className={`weq-ft-card${!ready && !file.isDir ? ' weq-ft-card-muted' : ''}${checked ? ' weq-ft-card-checked' : ''}`}
                      onClick={() => handleRowClick(file)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleRowClick(file);
                        }
                      }}
                    >
                      <img
                        className="weq-ft-card-icon"
                        src={fileIconUrl(icon)}
                        alt=""
                        draggable={false}
                      />
                      <div className="weq-ft-card-main">
                        <span className="weq-ft-card-name" title={file.name}>
                          {file.name}
                        </span>
                        <span className="weq-ft-card-meta">
                          {file.isDir ? '文件夹' : formatSize(file.fileSize)}
                          {!ready && !file.isDir ? ' · 等待上传' : ''}
                        </span>
                      </div>
                      <label
                        className={`weq-ft-check${!ready ? ' weq-ft-check-disabled' : ''}`}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!ready || isAncestorSelected(file.path)}
                          onChange={() => toggleSelect(file)}
                        />
                        <Check
                          className="weq-ft-check-mark"
                          size={12}
                          strokeWidth={3}
                          aria-hidden
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <footer className="weq-ft-foot">
            <span className="weq-ft-foot-summary">
              {selectedCount > 0
                ? `已选 ${selectedCount} 项 · ${formatSize(selectedSize)}`
                : '勾选文件后下载到本地缓存'}
            </span>
            <button
              type="button"
              className="weq-ft-btn-primary"
              disabled={selectedCount === 0 || starting}
              onClick={() => void handleStart()}
            >
              {starting ? (
                <Loader2 size={15} strokeWidth={2} className="weq-spin" aria-hidden />
              ) : (
                <Download size={15} strokeWidth={2} aria-hidden />
              )}
              <span>{starting ? '解析中…' : '下载'}</span>
            </button>
          </footer>
        </div>
      </Modal>

      {shareUrl ? (
        <FlashShareDialog
          title={crumbs[0]?.name || title}
          url={shareUrl}
          onClose={() => setShareUrl(null)}
        />
      ) : null}
      {tasksOpen ? <FlashTransferTasksDialog onClose={() => setTasksOpen(false)} /> : null}
    </>
  );
}
