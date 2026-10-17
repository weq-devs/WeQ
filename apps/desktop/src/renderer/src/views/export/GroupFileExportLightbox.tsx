/**
 * 群文件导出灯箱 —— 复用聊天页「群文件」卡片的浏览体验：
 *
 *   - 面包屑目录浏览：根目录 → 子文件夹逐层进入，可随时返回上级；
 *   - 文件夹行可勾选整棵子树（懒加载 + 缓存，勾选后递归选中该目录全部文件）；
 *   - 文件行按类型显示 `resources/fileicon/` 图标（与聊天页一致）；
 *   - 勾选的文件导出时按 path 在输出目录里重建文件夹树。
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { groupFileSelectedKeys, resolveGroupFileSelection } from '../../lib/groupFileSelection';
import { ArrowLeft, Check, ChevronRight, FolderOpen, Loader2, Minus, X } from 'lucide-react';
import { closeFromScrim, useEscapeToClose } from '../../im-template/template/modalUtils';
import { client } from '../../trpc/client';
import { useToast } from '../../components/Toast';
import { PickerListSkeleton } from './ExportSkeleton';
import { fileIconUrl } from '../../lib/resourceUrl';
import { ShimmerImage } from '../../components/ShimmerImage';
import {
  fileExtIcon,
  formatFileTime,
  formatSize,
  type GroupFileListing,
  type GroupFileWire,
  type GroupFolderWire,
} from '../../lib/groupFile';

export interface GroupFileEntry {
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

/** 目录面包屑的一层。根目录的 id 固定是 '/'。 */
interface Crumb {
  id: string;
  name: string;
}

const ROOT: Crumb = { id: '/', name: '全部文件' };

/** 递归拉某个文件夹子树里的全部文件（path 相对群文件根目录）。 */
async function collectSubtree(
  groupCode: string,
  folder: { id: string; path: string[] },
  isCurrent = () => true,
): Promise<GroupFileEntry[]> {
  const out: GroupFileEntry[] = [];
  const queue: Array<{ dir: string; path: string[] }> = [{ dir: folder.id, path: folder.path }];
  const seen = new Set<string>([folder.id]);

  while (queue.length > 0) {
    if (!isCurrent()) throw new Error('文件夹选择已停止');
    const { dir, path } = queue.shift()!;
    const listing = await client.account.listGroupFiles.query({ groupCode, folderId: dir });
    if (!isCurrent()) throw new Error('文件夹选择已停止');
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
    for (const sub of listing.folders) {
      if (!sub.folderId || seen.has(sub.folderId)) continue;
      seen.add(sub.folderId);
      queue.push({ dir: sub.folderId, path: [...path, sub.folderName || sub.folderId] });
    }
  }

  return out;
}

/** 文件的路径段是否以 prefix 开头（即文件位于该文件夹子树下）。 */
function pathStartsWith(path: string[], prefix: string[]): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((seg, i) => path[i] === seg);
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
  const pushToast = useToast((s) => s.push);
  const [crumbs, setCrumbs] = useState<Crumb[]>([ROOT]);
  const [listing, setListing] = useState<GroupFileListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** fileId → 选中的文件（含路径，导出时重建目录树）。 */
  const [selection, setSelection] = useState<Map<string, GroupFileEntry>>(() => new Map());
  /** folderId → 该目录子树全部文件（懒加载缓存，供文件夹勾选）。 */
  const [subtreeCache, setSubtreeCache] = useState<Map<string, GroupFileEntry[]>>(() => new Map());
  /** 正在递归收集的文件夹（那一行的勾选框转圈）。 */
  const [loadingFolder, setLoadingFolder] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const selectionPending = useRef(false);
  const selectionActive = useRef(true);
  const selectionContext = useRef(groupCode);
  selectionContext.current = groupCode;
  useEffect(() => {
    selectionActive.current = true;
    return () => {
      selectionActive.current = false;
    };
  }, []);

  const current = crumbs[crumbs.length - 1] ?? ROOT;
  /** 当前目录相对根目录的路径段（根为 []）。 */
  const currentPath = useMemo(() => crumbs.slice(1).map((c) => c.name), [crumbs]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    client.account.listGroupFiles
      .query({ groupCode, folderId: current.id })
      .then((res) => {
        if (cancelled) return;
        setListing(res as GroupFileListing);
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

  const selectedFiles = useMemo(() => [...selection.values()], [selection]);
  const totalSize = useMemo(
    () => selectedFiles.reduce((sum, f) => sum + f.fileSize, 0),
    [selectedFiles],
  );

  function toggleFile(file: GroupFileWire): void {
    multi.toggle(`file:${file.fileId}`);
  }

  /** 勾选/取消一个文件夹（勾选 = 递归选中子树全部文件）。 */
  function toggleFolder(folder: GroupFolderWire): void {
    multi.toggle(`folder:${folder.folderId}`);
  }
  const selectedKeys = groupFileSelectedKeys(selection, listing?.folders ?? [], subtreeCache);
  const multi = useMultiSelection({
    ids: [
      ...(listing?.folders ?? []).map((folder) => `folder:${folder.folderId}`),
      ...(listing?.files ?? []).map((file) => `file:${file.fileId}`),
    ],
    selected: selectedKeys,
    disabled: Boolean(submitting || loading || selecting),
    normalClick: 'passthrough',
    onChange: (keys) => void applySelection(keys),
  });
  async function applySelection(keys: Set<string>): Promise<void> {
    if (!listing || selectionPending.current) return;
    selectionPending.current = true;
    setSelecting(true);
    const isCurrent = () => selectionActive.current && selectionContext.current === groupCode;
    try {
      const next = await resolveGroupFileSelection({
        keys,
        selected: selection,
        listing,
        path: currentPath,
        cache: subtreeCache,
        load: async (folder) => {
          if (!isCurrent()) throw new Error('文件夹选择已停止');
          setLoadingFolder(folder.folderId);
          const files = await collectSubtree(
            groupCode,
            { id: folder.folderId, path: [...currentPath, folder.folderName || folder.folderId] },
            isCurrent,
          );
          if (isCurrent())
            setSubtreeCache((current) => new Map(current).set(folder.folderId, files));
          return files;
        },
      });
      if (isCurrent()) setSelection(next);
    } catch (e) {
      if (isCurrent())
        pushToast({
          tone: 'warning',
          title: '读取文件夹失败',
          ttl: 4000,
          message: e instanceof Error ? e.message : String(e),
        });
    } finally {
      selectionPending.current = false;
      if (selectionActive.current) {
        setLoadingFolder(null);
        setSelecting(false);
      }
    }
  }

  function selectAllVisible(): void {
    if (!listing) return;
    void applySelection(
      new Set([
        ...selectedKeys,
        ...listing.folders.map((folder) => `folder:${folder.folderId}`),
        ...listing.files.map((file) => `file:${file.fileId}`),
      ]),
    );
  }

  function invertVisible(): void {
    if (!listing) return;
    const next = new Set(selectedKeys);
    for (const id of [
      ...listing.folders.map((folder) => `folder:${folder.folderId}`),
      ...listing.files.map((file) => `file:${file.fileId}`),
    ]) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    }
    void applySelection(next);
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
    <div
      className="modal-scrim weq-exp-modal-scrim"
      role="presentation"
      onMouseDown={closeFromScrim(onClose)}
    >
      <section
        className="weq-exp-dialog weq-exp-album-dialog"
        {...multi.rootProps}
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
            <button
              type="button"
              className="weq-exp-btn"
              disabled={picking || submitting}
              onClick={() => void pickPath()}
            >
              {picking ? <Loader2 size={14} className="weq-exp-spin" /> : <FolderOpen size={14} />}
              选择目录
            </button>
          </section>

          {/* 目录浏览条：返回上级 + 面包屑 + 当前目录摘要（聊天页同款）。 */}
          <div className="group-file-toolbar weq-exp-file-toolbar">
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
            <span className="group-file-summary">
              {listing ? `${listing.folders.length} 个文件夹 · ${listing.files.length} 个文件` : ''}
            </span>
          </div>

          {/* 选择工具条。 */}
          <div className="weq-exp-file-tools">
            <button
              type="button"
              className="weq-exp-tool"
              disabled={
                loading ||
                selecting ||
                !listing ||
                listing.files.length + listing.folders.length === 0 ||
                submitting
              }
              onClick={selectAllVisible}
            >
              全选当前目录
            </button>
            <button
              type="button"
              className="weq-exp-tool"
              disabled={
                loading ||
                selecting ||
                !listing ||
                listing.files.length + listing.folders.length === 0 ||
                submitting
              }
              onClick={invertVisible}
            >
              反选当前目录
            </button>
            <button
              type="button"
              className="weq-exp-tool"
              disabled={selection.size === 0 || submitting || selecting}
              onClick={() => void applySelection(new Set())}
            >
              清空已选
            </button>
            <span className="weq-exp-tools-spacer" />
            <span className="weq-exp-tools-count">
              已选 {selection.size} 个文件
              {totalSize > 0 ? ` · ${formatSize(totalSize)}` : ''}
            </span>
          </div>

          <div className="group-file-list weq-exp-file-list">
            {loading ? (
              <PickerListSkeleton rows={6} />
            ) : error ? (
              <div className="group-album-state is-error">{error}</div>
            ) : !listing || listing.files.length + listing.folders.length === 0 ? (
              <div className="group-album-state">
                {current.id === '/' ? '这个群暂无文件' : '这个目录还没有文件'}
              </div>
            ) : (
              <>
                {listing.folders.map((folder) => {
                  const folderPath = [...currentPath, folder.folderName || folder.folderId];
                  const cached = subtreeCache.get(folder.folderId);
                  const selectedUnder = [...selection.values()].filter((e) =>
                    pathStartsWith(e.path, folderPath),
                  );
                  const fully = Boolean(
                    cached && cached.length > 0 && selectedUnder.length === cached.length,
                  );
                  const partial = selectedUnder.length > 0 && !fully;
                  const busy = loadingFolder === folder.folderId;
                  return (
                    <div
                      key={folder.folderId}
                      className={`group-file-row is-folder weq-exp-file-row${fully ? ' is-on' : ''}`}
                      {...multi.itemProps(`folder:${folder.folderId}`)}
                    >
                      <button
                        type="button"
                        className="weq-exp-file-nav"
                        disabled={submitting || selecting}
                        onClick={() =>
                          setCrumbs((c) => [
                            ...c,
                            { id: folder.folderId, name: folder.folderName || folder.folderId },
                          ])
                        }
                      >
                        <ShimmerImage
                          src={fileIconUrl('folder.png')}
                          className="group-file-icon"
                          alt=""
                        />
                        <span className="group-file-main">
                          <strong>{folder.folderName || '未命名文件夹'}</strong>
                          <small>
                            {folder.totalFileCount} 个文件
                            {folder.creatorName ? ` · ${folder.creatorName}` : ''}
                          </small>
                        </span>
                        <ChevronRight size={14} className="group-file-chevron" />
                      </button>
                      <button
                        type="button"
                        className={`weq-exp-file-check${fully ? ' is-full' : ''}${partial ? ' is-partial' : ''}`}
                        title={
                          fully
                            ? '取消选择整个文件夹（含子文件夹）'
                            : '选择整个文件夹（含子文件夹）'
                        }
                        disabled={busy || submitting || selecting}
                        onClick={() => void toggleFolder(folder)}
                      >
                        {busy ? (
                          <Loader2 size={12} className="weq-spin" />
                        ) : fully ? (
                          <Check size={12} />
                        ) : partial ? (
                          <Minus size={12} />
                        ) : null}
                      </button>
                    </div>
                  );
                })}
                {listing.files.map((file) => {
                  const on = selection.has(file.fileId);
                  return (
                    <button
                      // fileId 理论上唯一,但同一文件重复上传过会撞,补时间戳兜底
                      key={`${file.fileId}:${file.uploadedTime}`}
                      type="button"
                      className={`group-file-row weq-exp-file-row${on ? ' is-on' : ''}`}
                      disabled={submitting || selecting}
                      {...multi.itemProps(`file:${file.fileId}`)}
                      onClick={() => toggleFile(file)}
                    >
                      <ShimmerImage
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
                      <span className={`weq-exp-file-check${on ? ' is-full' : ''}`}>
                        {on ? <Check size={12} /> : null}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>

        <footer className="weq-exp-dialog-foot">
          <span className="weq-exp-dialog-foot-note">
            已选 {selection.size} 个文件
            {totalSize > 0 ? ` · ${formatSize(totalSize)}` : ''}
          </span>
          <button type="button" className="weq-exp-btn" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="weq-exp-btn is-primary"
            disabled={
              submitting ||
              selecting ||
              loading ||
              Boolean(error) ||
              !outputDir ||
              selectedFiles.length === 0
            }
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
