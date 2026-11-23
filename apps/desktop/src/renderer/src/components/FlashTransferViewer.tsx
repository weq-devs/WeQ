/**
 * 闪传文件浏览弹窗 —— 替代原来的「点卡片 → 换 sharelink → webview」。
 *
 * 卡片点击后直接打开这个竖屏弹窗，用 qfile 匿名 HTTP2RPC 拉文件列表，
 * 支持展开文件夹 / 压缩包、多选下载到 WeQ 本地缓存目录。顶部提供「分享」
 * （换 sharelink 后仍走原来的 webview 弹窗）。
 *
 * 下载按批次在本页展示，可交给后台继续。
 */
import { ToolbarLabel } from './CompactToolbar';
import { observeCompactToolbar } from './CompactToolbar.shared';
import { NumericText } from './NumericText';
import { formatBytes as formatSize } from '../lib/format';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ComponentProps,
} from 'react';
import { usePageDataCache } from './PageSnapshots.shared';
import { PageDataCache } from '../lib/pageDataCache';
import { useSearchTargetFocus } from '../hooks/useSearchTargetFocus';
import {
  ArrowLeft,
  ChevronRight,
  Check,
  Download,
  FolderOpen,
  ListTodo,
  Loader2,
  Pause,
  RefreshCw,
  Share2,
  Square,
  X,
} from 'lucide-react';
import { Modal } from './Dialog';
import { useMultiSelection } from '../hooks/useMultiSelection';
import { pruneNestedSelection } from '../lib/fileSelection';
import { FlashShareDialog } from './FlashShareDialog';
import { client } from '../trpc/client';
import { fileIconUrl } from '../lib/resourceUrl';
import { useToast } from './Toast.shared';
import { TransferRing } from './TransferRing';
import { useTransferProgress } from '../lib/transferActivity';
import { IS_WEB } from '../lib/target.shared';
import { downloadFlashToDevice } from '../lib/flashDownload';
import { TaskProgressBar } from './tasks/TaskProgressBar';
import {
  flashFileTransferTarget,
  flashFilesetTransferTarget,
} from '../../../shared/transfer_progress';
import '../styles/flash-transfer.css';

function EmbeddedTransfer({ children }: ComponentProps<typeof Modal>): ReactElement {
  return <>{children}</>;
}

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
    md: 'markdown.png',
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

function FlashFileProgress({ file }: { file: FlashEntry }) {
  const progress = useTransferProgress(
    file.isDir ? undefined : flashFileTransferTarget(file.filesetId, file.physicalId),
  );
  return progress ? (
    <TransferRing progress={progress} label={`下载 ${file.name}`} size={18} />
  ) : null;
}

type DownloadBinding = { expectedAccountUin: string; expectedAccountConfigId: string };
type DownloadBatch = Awaited<ReturnType<typeof client.account.flashViewDownloads.query>>[number];
type DownloadAction = 'pause' | 'cancel' | 'retry' | 'background' | 'open' | 'download';
const downloadLabel = {
  pending: '等待下载',
  resolving: '获取下载链接',
  downloading: '下载中',
  done: '已保存',
  cancelled: '已取消',
  failed: '下载未完成',
};
const activeDownload = (batch: DownloadBatch) =>
  batch.status === 'pending' || batch.status === 'resolving' || batch.status === 'downloading';

type FlashDirectory = Awaited<ReturnType<typeof client.account.flashListFiles.query>>;

function flashDirectoryKey(filesetId: string, parentId: string, zipFileId: string): string {
  return JSON.stringify(['flash-directory', filesetId, parentId, zipFileId]);
}

function flashCrumbs(title: string, parentId: string, zipFileId: string): Crumb[] {
  const root = { name: title || '闪传文件', id: '', zipFileId: '' };
  return parentId || zipFileId ? [root, { name: '所在目录', id: parentId, zipFileId }] : [root];
}

function flashDirectoryEntries(
  result: FlashDirectory,
  pathCrumbs: Crumb[],
  filesetId: string,
  zipFileId: string,
): FlashEntry[] {
  const prefix = pathCrumbs
    .slice(1)
    .map((c) => c.name)
    .join('/');
  const isZipCtx = zipFileId.length > 0;
  return (result.files ?? []).map((raw) => {
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
}

export function FlashTransferViewer({
  filesetId,
  title,
  onClose,
  initialTarget,
  embedded = false,
}: {
  filesetId: string;
  title: string;
  onClose: () => void;
  initialTarget?: { parentId: string; zipFileId: string; fileId: string };
  embedded?: boolean;
}): ReactElement | null {
  const searchRoot = useRef<HTMLDivElement>(null);
  const searchHandled = useRef(false);
  const pushToast = useToast((s) => s.push);
  const [directoryCache] = useState(() => new PageDataCache());
  const pageCache = usePageDataCache(directoryCache);
  const listRequest = useRef(0);
  const parentId = initialTarget?.parentId ?? '';
  const zipFileId = initialTarget?.zipFileId ?? '';
  const [crumbs, setCrumbs] = useState(() => flashCrumbs(title, parentId, zipFileId));
  const [initialDirectory] = useState(() =>
    pageCache.read<FlashDirectory>(flashDirectoryKey(filesetId, parentId, zipFileId)),
  );
  const [entries, setEntries] = useState(() =>
    initialDirectory ? flashDirectoryEntries(initialDirectory, crumbs, filesetId, zipFileId) : [],
  );
  const [hasDirectory, setHasDirectory] = useState(initialDirectory !== undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, FlashEntry>>(new Map());
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [binding, setBinding] = useState<DownloadBinding | null>(null);
  const [batches, setBatches] = useState<DownloadBatch[]>([]);
  const [busyBatch, setBusyBatch] = useState<string | null>(null);
  const active = useRef(false);
  const leaving = useRef(false);
  const busy = useRef(false);
  const owned = useRef(new Set<string>());
  const liveBinding = useRef<DownloadBinding | null>(null);
  const reads = useRef(0);
  const upload = useTransferProgress(flashFilesetTransferTarget(filesetId, 'upload'));

  const refreshDownloads = useCallback(
    async (scope: DownloadBinding) => {
      const read = ++reads.current;
      const result = await client.account.flashViewDownloads.query({ ...scope, filesetId });
      if (active.current && read === reads.current && liveBinding.current === scope)
        setBatches(result);
    },
    [filesetId],
  );

  const stopOwned = useCallback(async (scope: DownloadBinding) => {
    await Promise.all(
      [...owned.current].map(async (taskId) => {
        await client.account.flashPauseDownloadTask.mutate({
          ...scope,
          taskId,
          foregroundOnly: true,
        });
        owned.current.delete(taskId);
      }),
    );
  }, []);

  useEffect(() => {
    active.current = true;
    let disposed = false;
    void client.account.getAccountConfig
      .query()
      .then((config) => {
        if (disposed || !config?.configId || !config.uin) return;
        const scope = { expectedAccountUin: config.uin, expectedAccountConfigId: config.configId };
        liveBinding.current = scope;
        setBinding(scope);
      })
      .catch(() => {
        if (!disposed) pushToast({ tone: 'error', message: '无法读取闪传下载账号' });
      });
    return () => {
      active.current = false;
      disposed = true;
      const scope = liveBinding.current;
      queueMicrotask(() => {
        if (!active.current && scope) void stopOwned(scope).catch(() => undefined);
      });
    };
  }, [pushToast, stopOwned]);

  useEffect(() => {
    if (!binding) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refreshDownloads(binding);
      } catch {
        // 暂时失联时保留上次快照，下次读取补齐。
      } finally {
        if (!stopped) timer = setTimeout(poll, 1200);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [binding, refreshDownloads]);

  async function close() {
    if (busy.current || leaving.current) return;
    leaving.current = true;
    try {
      if (binding) await stopOwned(binding);
      if (active.current) onClose();
    } catch (reason) {
      pushToast({ tone: 'error', message: '无法暂停闪传下载', detail: String(reason) });
    } finally {
      leaving.current = false;
    }
  }

  async function control(batch: DownloadBatch, action: DownloadAction, fileId?: string) {
    if (!binding || busy.current || leaving.current) return;
    busy.current = true;
    setBusyBatch(batch.id);
    const ref = { ...binding, taskId: batch.id };
    try {
      if (action === 'background') {
        if (!(await client.account.flashBackgroundDownload.mutate({ ...ref, filesetId })))
          throw new Error('下载批次已失效');
        owned.current.delete(batch.id);
      } else if (action === 'pause') {
        await client.account.flashPauseDownloadTask.mutate(ref);
      } else if (action === 'cancel') {
        await client.account.flashCancelDownloadTask.mutate(ref);
      } else if (action === 'retry') {
        if (!(await client.account.flashRetryDownloadTask.mutate(ref)))
          throw new Error('下载仍在收尾，请稍后再试');
        if (batch.foreground) owned.current.add(batch.id);
      } else if (action === 'download') {
        await downloadFlashToDevice(
          { ...ref, fileId },
          () => active.current && liveBinding.current === binding,
        );
        return;
      } else {
        await client.account.flashOpenDownloadOutput.mutate({
          ...ref,
          mode:
            batch.files.length === 1 && batch.files[0]?.status === 'done' ? 'file' : 'directory',
        });
      }
      await refreshDownloads(binding);
    } catch (reason) {
      pushToast({ tone: 'error', message: '闪传下载操作失败', detail: String(reason) });
    } finally {
      busy.current = false;
      if (active.current) setBusyBatch(null);
    }
  }

  const current = crumbs[crumbs.length - 1] ?? crumbs[0]!;

  /** 拉一个目录；crumb 必须是最新的（进入前已 setCrumbs）。 */
  const fetchList = useCallback(
    async (pathCrumbs: Crumb[], parentId: string, zipFileId: string): Promise<void> => {
      setLoading(true);
      setError(null);
      const request = ++listRequest.current;
      const key = flashDirectoryKey(filesetId, parentId, zipFileId);
      const cached = pageCache.read<FlashDirectory>(key);
      setEntries(cached ? flashDirectoryEntries(cached, pathCrumbs, filesetId, zipFileId) : []);
      setHasDirectory(cached !== undefined);
      try {
        const res = await client.account.flashListFiles.query({ filesetId, parentId, zipFileId });
        if (listRequest.current !== request) return;
        const list = flashDirectoryEntries(res, pathCrumbs, filesetId, zipFileId);
        pageCache.write(key, res);
        setHasDirectory(true);
        setEntries(list);
        if (
          initialTarget &&
          !searchHandled.current &&
          parentId === initialTarget.parentId &&
          zipFileId === initialTarget.zipFileId
        ) {
          if (list.some((item) => item.fileId === initialTarget.fileId))
            searchHandled.current = true;
          else setError('未找到搜索中的文件，可能已移动或过期；原搜索结果仍保留');
        }
      } catch (e) {
        if (listRequest.current === request) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (listRequest.current === request) setLoading(false);
      }
    },
    [filesetId, initialTarget, pageCache],
  );

  // 初始加载根目录。
  useEffect(() => {
    const crumbs = flashCrumbs(title, parentId, zipFileId);
    setCrumbs(crumbs);
    searchHandled.current = false;
    void fetchList(crumbs, parentId, zipFileId);
    return () => {
      ++listRequest.current;
    };
  }, [fetchList, title, parentId, zipFileId]);
  useSearchTargetFocus(
    searchRoot,
    'data-flash-file-id',
    initialTarget?.fileId,
    !loading && entries.length > 0,
  );

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
    if (starting || !isReady(file) || isAncestorSelected(file.path)) return;
    multi.toggle(selectKey(file));
  };
  const multi = useMultiSelection({
    ids: entries.filter((file) => isReady(file) && !isAncestorSelected(file.path)).map(selectKey),
    selected: new Set(selected.keys()),
    disabled: starting,
    normalClick: 'passthrough',
    onChange: (keys) => {
      const available = new Map([
        ...selected,
        ...entries.map((file) => [selectKey(file), file] as const),
      ]);
      const next = new Map<string, FlashEntry>();
      for (const key of keys) {
        const file = available.get(key);
        if (file) next.set(key, file);
      }
      setSelected(pruneNestedSelection(next));
    },
  });

  const toggleAll = (checked: boolean): void => {
    if (starting) return;
    setSelected((prev) => {
      const next = new Map(prev);
      for (const file of entries) {
        if (!isReady(file) || isAncestorSelected(file.path)) continue;
        const key = selectKey(file);
        if (checked) next.set(key, file);
        else next.delete(key);
      }
      return pruneNestedSelection(next);
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
    if (items.length === 0 || !binding || starting || leaving.current) return;
    setStarting(true);
    try {
      const res = await client.account.flashStartDownloads.mutate({
        ...binding,
        viewFilesetId: filesetId,
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
      if (res.cancelled) return;
      if (res.taskId) {
        if (!active.current || leaving.current) {
          await client.account.flashPauseDownloadTask.mutate({
            ...binding,
            taskId: res.taskId,
            foregroundOnly: true,
          });
          return;
        }
        owned.current.add(res.taskId);
      }
      if (!active.current) return;
      setSelected(new Map());
      if (res.started > 0) {
        await refreshDownloads(binding);
      } else {
        pushToast({ tone: 'warning', message: '没有可下载的文件' });
      }
      if (res.errors.length > 0) {
        pushToast({
          tone: 'warning',
          message: '部分文件无法解析',
          detail: res.errors[0],
        });
      }
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

  const Surface = embedded ? EmbeddedTransfer : Modal;
  return (
    <>
      <Surface presentation="floating" onClose={() => void close()} width={520} title="闪传文件">
        <div
          className="weq-ft"
          {...multi.rootProps}
          ref={(element) => {
            searchRoot.current = element;
            multi.rootProps.ref(element);
          }}
        >
          <header className="weq-ft-head" data-window-drag-handle>
            <span className="weq-ft-title" title={crumbs[0]?.name}>
              {crumbs[0]?.name || 'QQ闪传'}
            </span>
            <div className="weq-ft-actions">
              <button
                type="button"
                className="weq-ft-btn"
                onClick={() => void handleShare()}
                disabled={sharing}
                title="分享"
                aria-label="分享"
              >
                {sharing ? (
                  <Loader2 size={15} strokeWidth={1.9} className="weq-spin" aria-hidden />
                ) : (
                  <Share2 size={15} strokeWidth={1.9} aria-hidden />
                )}
              </button>
              <button
                type="button"
                className="weq-ft-close"
                onClick={() => void close()}
                aria-label="关闭"
                title="关闭"
              >
                <X size={16} strokeWidth={1.9} aria-hidden />
              </button>
            </div>
          </header>

          <nav className="weq-ft-crumbs">
            <button
              type="button"
              className="weq-ft-close"
              disabled={crumbs.length < 2 || loading}
              onClick={() => navTo(crumbs.length - 2)}
              title="返回上一级"
              aria-label="返回上一级"
            >
              <ArrowLeft size={16} aria-hidden />
            </button>
            {crumbs.map((crumb, i) => (
              <span key={`${crumb.zipFileId}::${crumb.id}::${crumb.name}`} className="weq-ft-crumb">
                {i > 0 ? (
                  <ChevronRight
                    size={12}
                    strokeWidth={2}
                    className="weq-ft-crumb-sep"
                    aria-hidden
                  />
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
                disabled={starting || allReadyCount === 0}
                onChange={(e) => toggleAll(e.target.checked)}
              />
              <span>全选</span>
            </label>
            <span className="weq-ft-count">
              {loading && !hasDirectory ? (
                '读取中'
              ) : (
                <NumericText>{`${entries.length} 项`}</NumericText>
              )}
            </span>
            {current.zipFileId ? (
              <span className="weq-ft-toolbar-hint">正在浏览压缩包内容</span>
            ) : null}
            {upload?.phase === 'failed' ? (
              <span role="status">文件上传失败</span>
            ) : upload ? (
              <TransferRing progress={upload} label="闪传文件上传进度" size={18} />
            ) : null}
          </div>

          <div className="weq-ft-body">
            {batches.length > 0 && (
              <section className="weq-ft-batches" aria-label="本分享的下载">
                {batches.map((batch) => {
                  const running = activeDownload(batch);
                  const label = batch.paused ? '已暂停' : downloadLabel[batch.status];
                  const value =
                    batch.fileSize > 0 ? (batch.downloadedBytes / batch.fileSize) * 100 : undefined;
                  const disabled = busyBatch !== null;
                  return (
                    <section
                      className="weq-ft-batch"
                      key={batch.id}
                      aria-label={`下载 ${batch.files[0]?.relativePath ?? ''}`}
                    >
                      <details>
                        <summary>
                          <span>
                            {batch.files[0]?.relativePath}
                            {batch.files.length > 1 ? (
                              <NumericText>{` 等 ${batch.files.length} 个文件`}</NumericText>
                            ) : null}
                          </span>
                          <span>{batch.foreground ? label : `${label} · 后台`}</span>
                        </summary>
                        <ul>
                          {batch.files.map((file) => (
                            <li key={file.id}>
                              {file.relativePath} · {downloadLabel[file.status]}
                              {IS_WEB && file.status === 'done' && batch.files.length > 1 && (
                                <button
                                  type="button"
                                  className="weq-set-btn"
                                  disabled={disabled}
                                  aria-label={`下载 ${file.relativePath} 到此设备`}
                                  onClick={() => void control(batch, 'download', file.id)}
                                >
                                  <Download size={14} aria-hidden />
                                </button>
                              )}
                              {file.status === 'downloading' && (
                                <NumericText>{` · ${formatSize(file.downloadedBytes)} / ${formatSize(file.fileSize)}`}</NumericText>
                              )}
                            </li>
                          ))}
                        </ul>
                        {batch.error && <p className="weq-ft-batch-error">{batch.error}</p>}
                      </details>
                      {running && <TaskProgressBar value={value} label="本批次下载进度" />}
                      <div ref={observeCompactToolbar} className="weq-ft-batch-actions">
                        {running && (
                          <>
                            <button
                              title="暂停"
                              type="button"
                              className="weq-set-btn"
                              disabled={disabled}
                              onClick={() => void control(batch, 'pause')}
                            >
                              <Pause size={14} aria-hidden />
                              <ToolbarLabel>暂停</ToolbarLabel>
                            </button>
                            <button
                              title="停止"
                              type="button"
                              className="weq-set-btn"
                              disabled={disabled}
                              onClick={() => void control(batch, 'cancel')}
                            >
                              <Square size={14} aria-hidden />
                              <ToolbarLabel>停止</ToolbarLabel>
                            </button>
                          </>
                        )}
                        {batch.foreground && (running || batch.paused) && (
                          <button
                            title="后台进行"
                            type="button"
                            className="weq-set-btn"
                            disabled={disabled}
                            onClick={() => void control(batch, 'background')}
                          >
                            <ListTodo size={14} aria-hidden />
                            <ToolbarLabel>后台进行</ToolbarLabel>
                          </button>
                        )}
                        {batch.canRetry && (
                          <button
                            title={batch.paused ? '继续' : '重试未完成文件'}
                            type="button"
                            className="weq-set-btn"
                            disabled={disabled}
                            onClick={() => void control(batch, 'retry')}
                          >
                            <RefreshCw size={14} aria-hidden />
                            <ToolbarLabel>{batch.paused ? '继续' : '重试未完成文件'}</ToolbarLabel>
                          </button>
                        )}
                        {IS_WEB && batch.files.some((file) => file.status === 'done') && (
                          <button
                            title={batch.files.length === 1 ? '下载到此设备' : '下载已完成文件'}
                            type="button"
                            className="weq-set-btn"
                            disabled={disabled}
                            onClick={() => void control(batch, 'download')}
                          >
                            <Download size={14} aria-hidden />
                            <ToolbarLabel>
                              {batch.files.length === 1 ? '下载到此设备' : '下载已完成文件'}
                            </ToolbarLabel>
                          </button>
                        )}
                        {!IS_WEB && batch.files.some((file) => file.status === 'done') && (
                          <button
                            title={batch.files.length === 1 ? '打开文件' : '打开下载目录'}
                            type="button"
                            className="weq-set-btn"
                            disabled={disabled}
                            onClick={() => void control(batch, 'open')}
                          >
                            <FolderOpen size={14} aria-hidden />
                            <ToolbarLabel>
                              {batch.files.length === 1 ? '打开文件' : '打开下载目录'}
                            </ToolbarLabel>
                          </button>
                        )}
                      </div>
                    </section>
                  );
                })}
              </section>
            )}
            {error ? (
              <div className="weq-ft-error">
                <p>加载失败：{error}</p>
                <button
                  type="button"
                  className="weq-ft-btn"
                  onClick={() => void fetchList(crumbs, current.id, current.zipFileId)}
                >
                  <RefreshCw size={14} aria-hidden />
                  重试
                </button>
              </div>
            ) : null}
            {loading && !hasDirectory ? (
              <div className="weq-ft-loading" role="status" aria-label="正在读取文件">
                <Loader2 size={22} strokeWidth={1.9} className="weq-spin" aria-hidden />
              </div>
            ) : !hasDirectory ? null : entries.length === 0 ? (
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
                      data-flash-file-id={file.fileId}
                      role="button"
                      {...multi.itemProps(key, !ready && !file.isDir)}
                      className={`weq-ft-card${!ready && !file.isDir ? ' weq-ft-card-muted' : ''}${checked ? ' weq-ft-card-checked' : ''}`}
                      onClick={() => handleRowClick(file)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.target === e.currentTarget) {
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
                          {file.isDir ? (
                            '文件夹'
                          ) : (
                            <span className="weq-number weq-number-inherit">
                              {formatSize(file.fileSize)}
                            </span>
                          )}
                          {!ready && !file.isDir ? ' · 等待上传' : ''}
                        </span>
                      </div>
                      <FlashFileProgress file={file} />
                      <label
                        className={`weq-ft-check${!ready ? ' weq-ft-check-disabled' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
                          toggleSelect(file);
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={starting || !ready || isAncestorSelected(file.path)}
                          aria-label={`选择 ${file.name}`}
                          readOnly
                        />
                        <Check
                          className="weq-ft-check-mark"
                          size={12}
                          strokeWidth={3}
                          aria-hidden
                        />
                      </label>
                      {file.isDir || (ZIP_RE.test(file.name) && !current.zipFileId && ready) ? (
                        <ChevronRight size={15} className="weq-ft-card-arrow" aria-hidden />
                      ) : (
                        <span className="weq-ft-card-arrow" />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <footer className="weq-ft-foot">
            <span className="weq-ft-foot-summary">
              {selectedCount > 0 ? (
                <NumericText>{`已选 ${selectedCount} 项 · ${formatSize(selectedSize)}`}</NumericText>
              ) : (
                '未选择文件'
              )}
            </span>
            <button
              type="button"
              className="weq-ft-btn-primary"
              disabled={selectedCount === 0 || starting || !binding}
              onClick={() => void handleStart()}
            >
              {starting ? (
                <TransferRing progress={{ phase: 'preparing' }} label="闪传下载进度" size={16} />
              ) : (
                <Download size={15} strokeWidth={2} aria-hidden />
              )}
              <span>{starting ? '解析中…' : '下载'}</span>
            </button>
          </footer>
        </div>
      </Surface>

      {shareUrl ? (
        <FlashShareDialog
          title={crumbs[0]?.name || title}
          url={shareUrl}
          onClose={() => setShareUrl(null)}
        />
      ) : null}
    </>
  );
}
