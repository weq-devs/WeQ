import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  Check,
  Download,
  FileUp,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Search,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { client, trpc } from '../trpc/client';
import { useQQAutoRefresh } from '../hooks/useQQAutoRefresh';
import { useMultiSelection } from '../hooks/useMultiSelection';
import { useTabActive } from './RetainedTabs';
import { useDialog } from './Dialog';
import { ConversationActionsMenu } from './ConversationActionsMenu';
import {
  ActionFeedback,
  ActionIcon,
  useQQAction,
  useQQGroupPermissions,
  withQQAccountScope,
} from './qq-actions/shared';
import type { QQWriteBinding, QQWriteOutcome } from '../hooks/useQQWriteSession';
import { fileIconUrl } from '../lib/resourceUrl';
import { cn } from '../lib/utils';
import { useRenderDocument } from '../lib/renderDocument';
import {
  fileExtIcon,
  formatFileTime,
  formatSize,
  type GroupFileListing,
  type GroupFileWire,
  type GroupFolderWire,
} from '../lib/groupFile';
import {
  canManageGroupFile,
  GROUP_FILE_DRAG_TYPE,
  GROUP_FILE_UPLOAD_LIMIT,
  groupFileEntries,
  groupFileNameConflict,
  readGroupFileDrag,
  validateGroupFileName,
  type GroupFileEntryRow,
  type GroupFileSort,
} from '../lib/groupFileManager';
import { clipboardFiles } from '../im-template/template/composerMedia';
import '../styles/group-file-manager.css';

interface Editor {
  mode: 'createFolder' | 'rename' | 'move';
  keys: string[];
  name: string;
  crumbs: { id: string; name: string }[];
}
interface Upload {
  key: string;
  path: string;
  name: string;
  directory: string;
  directoryName: string;
  state: 'ready' | 'accepted' | 'unknown';
  error?: string;
}
interface Receipt {
  key: string;
  name: string;
  state: 'waiting' | 'accepted' | 'unknown';
  error?: string;
}
interface Props {
  groupId: number;
  directory: string;
  files: GroupFileWire[];
  folders: GroupFolderWire[];
  onChanged: () => void | Promise<void>;
  onOpenFolder?: (folder: GroupFolderWire) => void | Promise<void>;
  onSaveSelected?: (files: GroupFileWire[], folders: GroupFolderWire[]) => void | Promise<void>;
  renderFileAction?: (file: GroupFileWire) => ReactNode;
  highlightedFileId?: string;
  loading?: boolean;
  onNavigationGuard?: (guard: (() => Promise<boolean>) | null) => void;
}
const accepted = (result: QQWriteOutcome) =>
  result.state === 'accepted' || result.state === 'confirmed' || result.state === 'unchanged';
const creationKey = (name: string) =>
  JSON.stringify(['createFolder', name.normalize('NFC').toLocaleLowerCase()]);
function GroupFileManagerBody({
  groupId,
  directory,
  files,
  folders,
  onChanged,
  onOpenFolder,
  onSaveSelected,
  renderFileAction,
  highlightedFileId,
  loading = false,
  onNavigationGuard,
}: Props) {
  const a = useQQAction(`files:${groupId}:${directory}`);
  const renderDocument = useRenderDocument();
  const ElementClass = renderDocument.defaultView?.Element ?? Element;
  const NodeClass = renderDocument.defaultView?.Node ?? Node;
  const active = useTabActive();
  const permissions = useQQGroupPermissions(groupId, a);
  const manager = permissions.data?.canManage === true;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<GroupFileSort>('name');
  const [selected, setSelected] = useState(new Set<string>());
  const selectionAnchor = useRef<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorName = useRef<HTMLInputElement | null>(null);
  const editorKey = editor ? JSON.stringify([editor.mode, editor.keys]) : '';
  useEffect(() => {
    if (active && editorKey) {
      editorName.current?.focus();
      editorName.current?.select();
    }
  }, [active, editorKey]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [, setReceipts] = useState<Receipt[]>([]);
  const [error, setError] = useState('');
  const [dropActive, setDropActive] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; keys: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const confirm = useDialog((s) => s.confirm);
  const mayLeave = useCallback(async () => {
    if (a.pending) {
      setError('操作仍在进行，请等待或停止后续操作');
      return false;
    }
    if (editor || uploads.some((item) => item.state !== 'accepted'))
      return confirm('离开当前目录', '未完成的文件操作和待上传列表将被清理，仍要离开？');
    return true;
  }, [a.pending, editor, uploads, confirm]);
  useEffect(() => {
    onNavigationGuard?.(mayLeave);
    return () => onNavigationGuard?.(null);
  }, [onNavigationGuard, mayLeave]);
  const mounted = useRef(true),
    stop = useRef(false),
    uncertain = useRef(new Set<string>());
  const identity = `${a.binding?.expectedAccountUin}:${a.binding?.expectedAccountConfigId}:${groupId}:${directory}`;
  const latest = useRef(identity);
  latest.current = identity;
  const current = () => mounted.current && latest.current === identity;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop.current = true;
    };
  }, []);
  useEffect(() => {
    if (!active) {
      setMenu(null);
      setDropActive(false);
      setDropTarget(null);
    }
  }, [active]);
  const all = useMemo(() => groupFileEntries(files, folders, '', 'name'), [files, folders]);
  const rows = useMemo(
    () => groupFileEntries(files, folders, query, sort),
    [files, folders, query, sort],
  );
  const chosen = all.filter((row) => selected.has(row.key));
  const manageable = (row: GroupFileEntryRow) =>
    canManageGroupFile(row, manager, permissions.data?.selfUin);
  const locked = a.disabled || loading;
  const selectedManageable = chosen.length > 0 && chosen.every((row) => manageable(row));
  const multi = useMultiSelection({
    ids: rows.map((row) => row.key),
    selected,
    onChange: setSelected,
    anchorRef: selectionAnchor,
    normalClick: 'passthrough',
    disabled: loading || a.pending,
    onExit: () => setSelected(new Set()),
  });
  const selectOne = (key: string) => {
    selectionAnchor.current = key;
    setSelected(new Set([key]));
  };
  const autoRefresh = useQQAutoRefresh(a.available);
  const summary = trpc.account.qqActions.fileSummary.useQuery(
    { ...a.binding!, groupId },
    autoRefresh,
  );
  const destination = editor?.crumbs.at(-1)?.id ?? '/';
  const targets = trpc.account.qqActions.folders.useQuery(
    { ...a.binding!, groupId, directory: destination },
    useQQAutoRefresh(a.available && editor?.mode === 'move'),
  );
  async function listing(binding: QQWriteBinding, folderId: string): Promise<GroupFileListing> {
    const result = await client.account.qqActions.folders.query({
      ...binding,
      groupId,
      directory: folderId,
    });
    if (!current()) throw new Error('账号、群或目录已切换，已停止后续操作');
    if (result.targetDirectory !== folderId) throw new Error('返回目录与目标不一致，请重新读取');
    return result;
  }
  async function refresh() {
    await onChanged();
    await summary.refetch();
  }
  async function openFolder(folder: GroupFolderWire) {
    if ((await mayLeave()) && current()) await onOpenFolder?.(folder);
  }
  async function closeEditor() {
    if (a.pending) return;
    if (
      editor &&
      (editor.name || editor.mode === 'move') &&
      !(await confirm('放弃文件操作', '放弃当前未提交的文件操作？'))
    )
      return;
    setEditor(null);
  }
  async function openEditor(
    mode: Editor['mode'],
    keys: string[],
    folderId = '/',
    folderName = '全部文件',
  ) {
    if (locked) return;
    if (editor && !(await confirm('切换文件操作', '放弃当前未提交的文件操作？'))) return;
    if (!current()) return;
    const row = all.find((item) => item.key === keys[0]);
    setEditor({
      mode,
      keys,
      name: mode === 'rename' ? (row?.name ?? '') : '',
      crumbs:
        folderId === '/'
          ? [{ id: '/', name: '全部文件' }]
          : [
              { id: '/', name: '全部文件' },
              { id: folderId, name: folderName },
            ],
    });
    setError('');
  }
  async function operate(
    mode: 'delete' | Editor['mode'],
    keys: string[],
    name = '',
    target = destination,
  ) {
    if (locked || !current()) return;
    setError('');
    stop.current = false;
    try {
      if (mode === 'createFolder' && !manager) throw new Error('新建文件夹需要群主或管理员权限');
      const requested =
        mode === 'createFolder' ? [] : keys.map((key) => all.find((row) => row.key === key));
      if (requested.some((row) => !row || !manageable(row!)))
        throw new Error('选择包含无权限或已变化的项目');
      if (mode !== 'createFolder' && !requested.length) throw new Error('请先选择文件或文件夹');
      const nextName =
        mode === 'createFolder' || mode === 'rename' ? validateGroupFileName(name) : '';
      if (
        mode === 'move' &&
        (target === directory || requested.some((row) => row?.kind !== 'file'))
      )
        throw new Error('只能将文件移动到另一个目录');
      const initial: Receipt[] =
        mode === 'createFolder'
          ? [{ key: creationKey(nextName), name: nextName, state: 'waiting' }]
          : requested.map((row) => ({ key: row!.key, name: row!.name, state: 'waiting' }));
      const destructiveWarning =
        mode === 'delete'
          ? `删除所选 ${requested.length} 项？文件夹及其内容也会删除，不能撤销。`
          : undefined;
      const hasUnknown = initial.some((item) => uncertain.current.has(item.key));
      const warning = hasUnknown
        ? `${destructiveWarning ?? '提交所选文件操作？'}\n上次关联操作的结果未确认，可能已生效。请先核对 QQ，仍要再次提交？`
        : destructiveWarning;
      await a.perform(
        async (binding) => {
          const source = await listing(binding, directory);
          const fresh = groupFileEntries(source.files, source.folders, '', 'name');
          const actual = keys.map((key) => fresh.find((row) => row.key === key));
          if (mode !== 'createFolder' && actual.some((row) => !row))
            throw new Error('选择的项目已不在当前目录，请重新选择');
          if (
            (mode === 'createFolder' || mode === 'rename') &&
            groupFileNameConflict(nextName, source, mode === 'rename' ? keys[0] : undefined)
          )
            throw new Error('当前目录已有同名项目，请换一个名称');
          const dest = mode === 'move' ? await listing(binding, target) : null;
          if (dest && actual.some((row) => groupFileNameConflict(row!.name, dest)))
            throw new Error('目标目录已有同名项目，请先重命名或移除冲突项');
          const pending = [...initial];
          setReceipts(pending);
          for (let index = 0; index < pending.length; index++) {
            if (!current()) throw new Error('来源已切换，已停止后续操作');
            if (stop.current) break;
            const row = actual[index];
            try {
              const result = await client.account.qqActions.file.mutate({
                ...binding,
                groupId,
                directory,
                action:
                  mode === 'rename'
                    ? row?.kind === 'folder'
                      ? 'renameFolder'
                      : 'rename'
                    : mode === 'delete'
                      ? row?.kind === 'folder'
                        ? 'deleteFolder'
                        : 'delete'
                      : mode,
                id: row?.kind === 'folder' ? row.folder.folderId : row?.file.fileId,
                name: nextName || undefined,
                destination: mode === 'move' ? target : undefined,
              });
              if (!accepted(result)) uncertain.current.add(pending[index]!.key);
              pending[index] = { ...pending[index]!, state: 'accepted' };
              if (current())
                setSelected(
                  (old) => new Set([...old].filter((key) => key !== pending[index]!.key)),
                );
            } catch (reason) {
              pending[index] = {
                ...pending[index]!,
                state: 'unknown',
                error: reason instanceof Error ? reason.message : String(reason),
              };
              uncertain.current.add(pending[index]!.key);
              if (current()) setReceipts([...pending]);
              break;
            }
            if (current()) setReceipts([...pending]);
          }
          if (current() && pending.every((item) => item.state === 'accepted')) setEditor(null);
          return {
            state: pending.every((item) => item.state === 'accepted') ? 'accepted' : 'unconfirmed',
          };
        },
        refresh,
        warning,
        {
          readback: async () => {
            if (!a.binding) return false;
            const source = await listing(a.binding, directory);
            const fresh = groupFileEntries(source.files, source.folders, '', 'name');
            if (mode === 'createFolder')
              return source.folders.some((folder) => folder.folderName === nextName);
            if (mode === 'rename')
              return fresh.some((row) => keys.includes(row.key) && row.name === nextName);
            if (fresh.some((row) => keys.includes(row.key))) return false;
            if (mode === 'move') {
              const dest = await listing(a.binding, target);
              return (
                dest.files.filter((file) =>
                  requested.some((row) => row?.kind === 'file' && row.file.fileId === file.fileId),
                ).length === requested.length
              );
            }
            return true;
          },
        },
      );
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  function stage(
    incoming: { path: string; fileName: string }[],
    target = directory,
    directoryName = '当前目录',
  ) {
    if (locked) return;
    setError('');
    const fresh = new Set(
      incoming
        .filter(
          (item) =>
            item.path && !uploads.some((row) => row.key === JSON.stringify([target, item.path])),
        )
        .map((item) => JSON.stringify([target, item.path])),
    );
    if (fresh.size + uploads.length > GROUP_FILE_UPLOAD_LIMIT)
      setError(`待上传列表最多 ${GROUP_FILE_UPLOAD_LIMIT} 项，超出部分未加入`);
    setUploads((old) => {
      const next = [...old];
      for (const item of incoming) {
        const key = JSON.stringify([target, item.path]);
        if (!item.path || next.some((row) => row.key === key)) continue;
        if (next.length >= GROUP_FILE_UPLOAD_LIMIT) break;
        next.push({
          key,
          path: item.path,
          name: item.fileName,
          directory: target,
          directoryName,
          state: 'ready',
        });
      }
      return next;
    });
  }
  async function upload() {
    if (locked || !uploads.some((item) => item.state === 'ready')) return;
    stop.current = false;
    setError('');
    await a.perform(
      async (binding) => {
        const ready = uploads.filter((item) => item.state === 'ready');
        const sources = new Map<string, GroupFileListing>();
        const names = new Set<string>();
        for (const item of ready) {
          let source = sources.get(item.directory);
          if (!source) {
            source = await listing(binding, item.directory);
            sources.set(item.directory, source);
          }
          const name = validateGroupFileName(item.name);
          const key = JSON.stringify([item.directory, name.normalize('NFC').toLocaleLowerCase()]);
          if (names.has(key) || groupFileNameConflict(name, source))
            throw new Error(`同名冲突：${name}，请改名或移除后再上传`);
          names.add(key);
        }
        let complete = true;
        for (const item of ready) {
          if (!current()) throw new Error('来源已切换，已停止后续上传');
          if (stop.current) {
            complete = false;
            break;
          }
          try {
            const result = await client.account.sendFile.mutate({
              ...binding,
              peerType: 'group',
              targetId: String(groupId),
              path: item.path,
              fileName: validateGroupFileName(item.name),
              folderId: item.directory,
            });
            if (!result.ok) throw new Error('上传或发送回执未确认，请先核对群文件');
            if (current())
              setUploads((old) =>
                old.map((row) => (row.key === item.key ? { ...row, state: 'accepted' } : row)),
              );
          } catch (reason) {
            if (current())
              setUploads((old) =>
                old.map((row) =>
                  row.key === item.key
                    ? {
                        ...row,
                        state: 'unknown',
                        error: reason instanceof Error ? reason.message : String(reason),
                      }
                    : row,
                ),
              );
            complete = false;
            break;
          }
        }
        return { state: complete ? 'accepted' : 'unconfirmed' };
      },
      refresh,
      `上传待处理的 ${uploads.filter((item) => item.state === 'ready').length} 个文件到 QQ 群 ${groupId} 列出的目标目录，并发布群文件消息？`,
      {
        readback: async () => {
          if (!a.binding) return false;
          const pending = uploads.filter((item) => item.state === 'ready');
          for (const item of pending) {
            const source = await listing(a.binding, item.directory);
            if (!source.files.some((file) => file.fileName === item.name)) return false;
          }
          return pending.length > 0;
        },
      },
    );
  }
  async function saveRows(keys: string[]) {
    if (!onSaveSelected || saving) return;
    setSaving(true);
    setError('');
    const items = all.filter((row) => keys.includes(row.key));
    try {
      await onSaveSelected(
        items.flatMap((row) => (row.kind === 'file' ? [row.file] : [])),
        items.flatMap((row) => (row.kind === 'folder' ? [row.folder] : [])),
      );
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (current()) setSaving(false);
    }
  }
  function drop(event: DragEvent, folderId = directory, folderName = '当前目录') {
    event.preventDefault();
    event.stopPropagation();
    try {
      if (!event.dataTransfer) return;
      const payload = event.dataTransfer.getData(GROUP_FILE_DRAG_TYPE);
      if (!payload && !Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault();
      event.stopPropagation();
      setDropActive(false);
      setDropTarget(null);
      if (locked) return;
      if (payload) {
        const ids = readGroupFileDrag(
          payload,
          {
            groupId,
            directory,
            uin: a.binding?.expectedAccountUin ?? '',
            configId: a.binding?.expectedAccountConfigId ?? '',
          },
          files,
        );
        if (folderId === directory) throw new Error('文件已在当前目录');
        const keys = ids.map((id) => `file:${id}`);
        if (keys.some((key) => !manageable(all.find((row) => row.key === key)!)))
          throw new Error('选择包含无权移动的文件');
        void openEditor('move', keys, folderId, folderName);
      } else {
        const incoming = clipboardFiles(event.dataTransfer).map((file) => ({
          fileName: file.name,
          path: window.weq?.pathForFile?.(file) ?? '',
        }));
        if (!incoming.length || incoming.some((file) => !file.path))
          throw new Error('无法取得本机文件路径，请使用选择上传文件');
        stage(incoming, folderId, folderName);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  const menuRows = all.filter((row) => menu?.keys.includes(row.key));
  const menuManageable = menuRows.length > 0 && menuRows.every((row) => manageable(row));
  return (
    <section
      {...multi.rootProps}
      className={cn(
        'weq-group-file-manager',
        dropActive && 'is-dropping',
        renderFileAction && 'has-file-save',
      )}
      aria-label="群文件管理器"
      onDragOver={(event) => {
        if (
          !locked &&
          (event.dataTransfer.types.includes('Files') ||
            event.dataTransfer.types.includes(GROUP_FILE_DRAG_TYPE))
        ) {
          event.preventDefault();
          event.dataTransfer.dropEffect = event.dataTransfer.types.includes(GROUP_FILE_DRAG_TYPE)
            ? 'move'
            : 'copy';
          setDropActive(true);
        }
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof NodeClass) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setDropActive(false);
          setDropTarget(null);
        }
      }}
      onDragEnd={() => {
        setDropActive(false);
        setDropTarget(null);
      }}
      onDrop={(event) => drop(event)}
      onContextMenu={(event) => {
        if (
          event.target instanceof ElementClass &&
          event.target.closest(
            'tr,input,button,select,.weq-file-manager-editor,[role="alert"],.weq-file-receipts',
          )
        )
          return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY, keys: [] });
      }}
      onKeyDown={(event) => {
        multi.rootProps.onKeyDown(event);
        if (
          event.defaultPrevented ||
          (event.target instanceof ElementClass &&
            event.target.closest('input,select,textarea,[role="menu"]'))
        )
          return;
        if (event.key === 'F2' && chosen.length === 1 && selectedManageable) {
          event.preventDefault();
          void openEditor('rename', [...selected]);
        } else if (event.key === 'Delete' && selectedManageable) {
          event.preventDefault();
          void operate('delete', [...selected]);
        }
      }}
    >
      <div className="weq-file-manager-toolbar" role="toolbar" aria-label="群文件工具栏">
        <ActionIcon
          label="选择上传文件"
          disabled={locked}
          onClick={() =>
            void a.pickFile().then((file) => {
              if (file && current()) stage([file]);
            })
          }
        >
          <FileUp size={17} />
        </ActionIcon>
        {manager && (
          <ActionIcon
            label="新建文件夹"
            disabled={locked}
            onClick={() => void openEditor('createFolder', [])}
          >
            <FolderPlus size={17} />
          </ActionIcon>
        )}
        {onSaveSelected && (
          <ActionIcon
            label="保存所选项目"
            disabled={loading || saving || !chosen.length}
            onClick={() => void saveRows([...selected])}
          >
            <Download size={17} />
          </ActionIcon>
        )}
        <ActionIcon
          label="重命名所选项目"
          disabled={locked || !selectedManageable || chosen.length !== 1}
          onClick={() => void openEditor('rename', [...selected])}
        >
          <Pencil size={17} />
        </ActionIcon>
        <ActionIcon
          label="移动所选文件"
          disabled={locked || !selectedManageable || chosen.some((row) => row.kind !== 'file')}
          onClick={() => void openEditor('move', [...selected])}
        >
          <FolderInput size={17} />
        </ActionIcon>
        <ActionIcon
          label="删除所选项目"
          disabled={locked || !selectedManageable}
          onClick={() => void operate('delete', [...selected])}
        >
          <Trash2 size={17} />
        </ActionIcon>
        {a.pending && (
          <ActionIcon
            label="停止后续操作"
            onClick={() => {
              stop.current = true;
            }}
          >
            <Square size={16} />
          </ActionIcon>
        )}
        <label className="weq-file-manager-search">
          <Search size={15} />
          <input
            aria-label="搜索当前目录"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          aria-label="群文件排序"
          value={sort}
          onChange={(event) => setSort(event.target.value as GroupFileSort)}
        >
          <option value="name">名称</option>
          <option value="time">最近修改</option>
          <option value="size">文件大小</option>
        </select>
      </div>
      <div className="weq-file-manager-status">
        <span>
          {chosen.length
            ? `已选 ${chosen.length} 项`
            : `${folders.length} 个文件夹 · ${files.length} 个文件`}
        </span>
        {summary.data && (
          <span>
            {summary.data.fileCount} / {summary.data.maxCount} 个文件 ·{' '}
            {formatSize(summary.data.usedSpace)} / {formatSize(summary.data.totalSpace)}
          </span>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {summary.error && <p role="alert">{summary.error.message}</p>}
      {editor && (
        <div className="weq-file-manager-editor weq-qq-action-form" aria-label="文件操作编辑器">
          <div className="weq-file-manager-editor-heading">
            <strong>
              {editor.mode === 'createFolder'
                ? '新建文件夹'
                : editor.mode === 'rename'
                  ? `重命名 ${all.find((row) => row.key === editor.keys[0])?.name ?? '所选项目'}`
                  : `移动 ${editor.keys.length} 个文件`}
            </strong>
            <ActionIcon
              label="取消文件操作"
              disabled={a.pending}
              onClick={() => void closeEditor()}
            >
              <X size={16} />
            </ActionIcon>
          </div>
          {editor.mode !== 'move' ? (
            <input
              aria-label="新名称"
              ref={editorName}
              value={editor.name}
              maxLength={256}
              disabled={a.pending}
              onChange={(event) => setEditor({ ...editor, name: event.target.value })}
            />
          ) : (
            <>
              <nav aria-label="目标目录" className="weq-file-destination">
                <ActionIcon
                  label="目标目录返回上级"
                  disabled={a.pending || editor.crumbs.length < 2}
                  onClick={() => setEditor({ ...editor, crumbs: editor.crumbs.slice(0, -1) })}
                >
                  <ArrowLeft size={15} />
                </ActionIcon>
                {editor.crumbs.map((crumb, index) => (
                  <button
                    type="button"
                    key={crumb.id}
                    disabled={a.pending}
                    onClick={() =>
                      setEditor({ ...editor, crumbs: editor.crumbs.slice(0, index + 1) })
                    }
                  >
                    {crumb.name}
                  </button>
                ))}
              </nav>
              {targets.error ? (
                <p role="alert">{targets.error.message}</p>
              ) : (
                <div className="weq-file-destination-list">
                  {targets.data?.folders.map((folder) => (
                    <button
                      type="button"
                      key={folder.folderId}
                      disabled={a.pending}
                      onClick={() =>
                        setEditor({
                          ...editor,
                          crumbs: [
                            ...editor.crumbs,
                            { id: folder.folderId, name: folder.folderName },
                          ],
                        })
                      }
                    >
                      <img src={fileIconUrl('folder.png')} alt="" draggable={false} />
                      {folder.folderName}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <ActionIcon
            label="执行文件操作"
            disabled={
              locked ||
              (editor.mode === 'createFolder' && !manager) ||
              (editor.mode === 'move'
                ? destination === directory || targets.isFetching || !!targets.error
                : !editor.name.trim())
            }
            onClick={() => void operate(editor.mode, editor.keys, editor.name)}
          >
            <Check size={17} />
          </ActionIcon>
        </div>
      )}
      {uploads.length > 0 && (
        <div className="weq-file-manager-editor weq-qq-action-form" aria-label="待上传文件">
          <div className="weq-file-manager-editor-heading">
            <strong>待上传文件</strong>
            <ActionIcon
              label="上传待处理文件"
              disabled={locked || !uploads.some((item) => item.state === 'ready')}
              onClick={() => void upload()}
            >
              <FileUp size={17} />
            </ActionIcon>
          </div>
          {uploads.map((item) => (
            <div className="weq-file-upload-row" key={item.key}>
              <input
                aria-label={`上传文件名 ${item.name}`}
                value={item.name}
                disabled={a.pending || item.state !== 'ready'}
                onChange={(event) =>
                  setUploads((old) =>
                    old.map((row) =>
                      row.key === item.key ? { ...row, name: event.target.value } : row,
                    ),
                  )
                }
              />
              <span>{item.directoryName}</span>
              <ActionIcon
                label={`移除上传项 ${item.name}`}
                disabled={a.pending}
                onClick={() => setUploads((old) => old.filter((row) => row.key !== item.key))}
              >
                <X size={15} />
              </ActionIcon>
            </div>
          ))}
        </div>
      )}
      <div className="weq-file-manager-table-scroll">
        <table className="weq-file-manager-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="选择当前可见项目"
                  disabled={loading || !rows.length}
                  checked={rows.length > 0 && rows.every((row) => selected.has(row.key))}
                  ref={(input) => {
                    if (input)
                      input.indeterminate =
                        rows.some((row) => selected.has(row.key)) &&
                        !rows.every((row) => selected.has(row.key));
                  }}
                  onChange={(event) =>
                    setSelected((old) => {
                      const next = new Set(old);
                      for (const row of rows)
                        if (event.target.checked) next.add(row.key);
                        else next.delete(row.key);
                      return next;
                    })
                  }
                />
              </th>
              <th>名称</th>
              <th>大小</th>
              <th>上传者</th>
              <th>修改时间</th>
              <th>
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                {...multi.itemProps(row.key)}
                key={row.key}
                data-file-id={row.kind === 'file' ? row.file.fileId : undefined}
                aria-selected={selected.has(row.key)}
                className={cn(
                  row.kind === 'file' && row.file.fileId === highlightedFileId
                    ? 'is-search-hit'
                    : undefined,
                  dropTarget === row.key && 'is-drop-target',
                )}
                draggable={row.kind === 'file' && manageable(row) && !locked}
                onDragStart={(event) => {
                  if (row.kind !== 'file' || !a.binding) return;
                  if (
                    selected.has(row.key) &&
                    chosen.some((item) => item.kind !== 'file' || !manageable(item))
                  ) {
                    event.preventDefault();
                    setError('选择包含文件夹或无权移动的文件');
                    return;
                  }
                  const keys = selected.has(row.key)
                    ? chosen.filter((item) => item.kind === 'file').map((item) => item.key)
                    : [row.key];
                  if (!selected.has(row.key)) selectOne(row.key);
                  event.dataTransfer.setData(
                    GROUP_FILE_DRAG_TYPE,
                    JSON.stringify({
                      version: 1,
                      groupId,
                      directory,
                      uin: a.binding.expectedAccountUin,
                      configId: a.binding.expectedAccountConfigId,
                      ids: keys.map((key) => key.slice(5)),
                    }),
                  );
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event) => {
                  if (
                    row.kind === 'folder' &&
                    !locked &&
                    (event.dataTransfer.types.includes(GROUP_FILE_DRAG_TYPE) ||
                      event.dataTransfer.types.includes('Files'))
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
                      GROUP_FILE_DRAG_TYPE,
                    )
                      ? 'move'
                      : 'copy';
                    setDropActive(false);
                    setDropTarget(row.key);
                  }
                }}
                onDragLeave={(event) => {
                  if (
                    !(event.relatedTarget instanceof NodeClass) ||
                    !event.currentTarget.contains(event.relatedTarget)
                  )
                    setDropTarget((old) => (old === row.key ? null : old));
                }}
                onDrop={
                  row.kind === 'folder'
                    ? (event) => drop(event, row.folder.folderId, row.name)
                    : undefined
                }
                onClick={(event) => {
                  if (
                    !(event.target instanceof ElementClass && event.target.closest('button,input'))
                  )
                    selectOne(row.key);
                }}
                onDoubleClick={() => {
                  if (row.kind === 'folder' && !locked) void openFolder(row.folder);
                }}
                onKeyDown={(event) => {
                  if (
                    event.target === event.currentTarget &&
                    event.key === 'Enter' &&
                    row.kind === 'folder' &&
                    !locked
                  ) {
                    event.preventDefault();
                    void openFolder(row.folder);
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const keys = selected.has(row.key) ? [...selected] : [row.key];
                  if (!selected.has(row.key)) selectionAnchor.current = row.key;
                  setSelected(new Set(keys));
                  setMenu({ x: event.clientX, y: event.clientY, keys });
                }}
              >
                <td>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${row.name}`}
                    checked={selected.has(row.key)}
                    disabled={loading || a.pending}
                    onChange={() => multi.toggle(row.key)}
                  />
                </td>
                <td>
                  <div className="weq-file-manager-name">
                    <img
                      src={fileIconUrl(
                        row.kind === 'folder' ? 'folder.png' : fileExtIcon(row.name),
                      )}
                      alt=""
                      draggable={false}
                    />
                    <span className="weq-file-manager-name-content">
                      <button
                        type="button"
                        title={row.name}
                        disabled={loading}
                        onClick={() =>
                          row.kind === 'folder' ? void openFolder(row.folder) : selectOne(row.key)
                        }
                      >
                        {row.name || '未命名'}
                      </button>
                      <small className="weq-file-manager-name-meta">
                        <span className="weq-file-manager-size-inline">
                          {row.kind === 'folder'
                            ? `${row.folder.totalFileCount} 个文件`
                            : formatSize(row.file.fileSize)}{' '}
                          ·{' '}
                        </span>
                        {[
                          row.kind === 'folder' ? row.folder.creatorName : row.file.uploaderName,
                          formatFileTime(
                            row.kind === 'folder'
                              ? row.folder.modifiedTime || row.folder.createTime
                              : row.file.modifiedTime || row.file.uploadedTime,
                          ),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    </span>
                  </div>
                </td>
                <td>
                  {row.kind === 'folder'
                    ? `${row.folder.totalFileCount} 个文件`
                    : formatSize(row.file.fileSize)}
                </td>
                <td>{row.kind === 'folder' ? row.folder.creatorName : row.file.uploaderName}</td>
                <td>
                  {formatFileTime(
                    row.kind === 'folder'
                      ? row.folder.modifiedTime || row.folder.createTime
                      : row.file.modifiedTime || row.file.uploadedTime,
                  )}
                </td>
                <td>
                  <div className="weq-file-row-tools">
                    {row.kind === 'file' && renderFileAction?.(row.file)}
                    <button
                      type="button"
                      className="weq-set-iconbtn"
                      title={`操作 ${row.name}`}
                      aria-label={`操作 ${row.name}`}
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        const keys = selected.has(row.key) ? [...selected] : [row.key];
                        if (!selected.has(row.key)) selectionAnchor.current = row.key;
                        setSelected(new Set(keys));
                        setMenu({ x: rect.left, y: rect.bottom, keys });
                      }}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !rows.length && (
        <p role="status">{query ? '没有匹配的文件' : '这个目录还没有文件'}</p>
      )}
      <ActionFeedback action={a} />
      {menu && active && (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          label="群文件操作"
          onClose={() => setMenu(null)}
          actions={[
            ...(menu.keys.length === 0
              ? [
                  {
                    label: '选择上传文件',
                    icon: <FileUp size={16} />,
                    disabled: locked,
                    action: () =>
                      void a.pickFile().then((file) => {
                        if (file && current()) stage([file]);
                      }),
                  },
                  ...(manager
                    ? [
                        {
                          label: '新建文件夹',
                          icon: <FolderPlus size={16} />,
                          disabled: locked,
                          action: () => void openEditor('createFolder', []),
                        },
                      ]
                    : []),
                ]
              : []),
            ...(menuRows.length === 1 && menuRows[0]?.kind === 'folder'
              ? [
                  {
                    label: '打开文件夹',
                    icon: <FolderInput size={16} />,
                    disabled: locked,
                    action: () =>
                      void openFolder(
                        (menuRows[0] as Extract<GroupFileEntryRow, { kind: 'folder' }>).folder,
                      ),
                  },
                ]
              : []),
            ...(onSaveSelected
              ? [
                  {
                    label: '保存所选项目',
                    icon: <Download size={16} />,
                    disabled: saving || loading || !menuRows.length,
                    action: () => void saveRows(menu.keys),
                  },
                ]
              : []),
            {
              label: '重命名',
              icon: <Pencil size={16} />,
              disabled: locked || !menuManageable || menuRows.length !== 1,
              action: () => void openEditor('rename', menu.keys),
            },
            {
              label: '移动到',
              icon: <FolderInput size={16} />,
              disabled: locked || !menuManageable || menuRows.some((row) => row.kind !== 'file'),
              action: () => void openEditor('move', menu.keys),
            },
            {
              label: '删除',
              icon: <Trash2 size={16} />,
              disabled: locked || !menuManageable,
              separatorBefore: true,
              action: () => void operate('delete', menu.keys),
            },
          ]}
        />
      )}
    </section>
  );
}
const Scoped = withQQAccountScope(GroupFileManagerBody);
export function GroupFileManager(props: Props) {
  return <Scoped key={`${props.groupId}:${props.directory}`} {...props} />;
}
