import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, RotateCw, Square, X } from 'lucide-react';
import { client, trpc } from '../trpc/client';
import { useQQAutoRefresh } from '../hooks/useQQAutoRefresh';
import { useExportSavePolicy } from '../hooks/useExportSavePolicy';
import { useMediaSave, MediaSaveControls } from './MediaSaveControls';
import { ServerSavePrompt } from './ServerSavePrompt';
import { OverlayLayer } from './OverlayLayer';
import { GroupFileManager } from './GroupFileManager';
import { useQQAction, withQQAccountScope } from './qq-actions/shared';
import { useToast } from './Toast';
import { collectGroupFileSubtree, resolveGroupFileSelection } from '../lib/groupFileSelection';
import type { GroupFileWire, GroupFolderWire } from '../lib/groupFile';
import '../styles/group-media.css';

interface Props {
  groupCode: string;
  groupName: string;
  initialFolderId?: string;
  initialFileId?: string;
  onClose: () => void;
}
interface Crumb {
  id: string;
  name: string;
  known?: boolean;
}
const ROOT: Crumb = { id: '/', name: '全部文件' };
function GroupFileDialogBody({
  groupCode,
  groupName,
  initialFolderId,
  initialFileId,
  onClose,
}: Props) {
  const a = useQQAction(`group-file-window:${groupCode}`);
  const mediaSave = useMediaSave(),
    save = useExportSavePolicy();
  const toast = useToast((s) => s.push);
  const [crumbs, setCrumbs] = useState<Crumb[]>(
    initialFolderId && initialFolderId !== '/'
      ? [ROOT, { id: initialFolderId, name: '定位目录', known: false }]
      : [ROOT],
  );
  const root = useRef<HTMLElement | null>(null),
    mounted = useRef(true);
  const navigationGuard = useRef<(() => Promise<boolean>) | null>(null);
  const setGuard = useCallback((guard: (() => Promise<boolean>) | null) => {
    navigationGuard.current = guard;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = crumbs.at(-1) ?? ROOT;
  const read = trpc.account.listGroupFiles.useQuery(
    { ...a.binding!, groupCode, folderId: current.id },
    useQQAutoRefresh(a.available),
  );
  const listing = read.data?.targetDirectory === current.id ? read.data : null;
  const error = read.error?.message ?? (read.data && !listing ? '返回目录与目标不一致' : null);
  const loading = read.isFetching && !listing;
  const searchMissing =
    !!initialFileId &&
    !loading &&
    !error &&
    !!listing &&
    current.id === (initialFolderId ?? '/') &&
    !listing.files.some((file) => file.fileId === initialFileId);
  useEffect(() => {
    if (!initialFileId || !listing || current.id !== (initialFolderId ?? '/')) return;
    const row = [...(root.current?.querySelectorAll<HTMLElement>('[data-file-id]') ?? [])].find(
      (element) => element.dataset.fileId === initialFileId,
    );
    row?.scrollIntoView({ block: 'center' });
  }, [initialFileId, initialFolderId, current.id, listing]);
  const leave = async (action: () => void) => {
    if ((await navigationGuard.current?.()) ?? true) {
      if (mounted.current) action();
    }
  };
  const refresh = async () => {
    const result = await read.refetch();
    if (result.error) throw result.error;
  };
  async function saveSelected(files: GroupFileWire[], folders: GroupFolderWire[]) {
    if (!listing || !a.binding || !save.binding) throw new Error('账号或目录尚未就绪');
    const binding = { ...a.binding };
    const isCurrent = () => mounted.current && save.isCurrent();
    const path = crumbs
      .slice(1)
      .filter((crumb) => crumb.known !== false)
      .map((crumb) => crumb.name);
    const selected = await resolveGroupFileSelection({
      keys: new Set([
        ...files.map((file) => `file:${file.fileId}`),
        ...folders.map((folder) => `folder:${folder.folderId}`),
      ]),
      selected: new Map(),
      listing,
      path,
      cache: new Map(),
      load: (folder) =>
        collectGroupFileSubtree(
          { id: folder.folderId, path: [...path, folder.folderName || folder.folderId] },
          (directory) =>
            client.account.listGroupFiles.query({ ...binding, groupCode, folderId: directory }),
          isCurrent,
        ),
    });
    if (!isCurrent()) return;
    if (!selected.size) throw new Error('所选文件夹中没有可保存的文件');
    const name = `${groupName} 群文件`;
    const savePolicy = await save.prepareSave(undefined, { kind: 'bundle', name });
    if (!savePolicy || !isCurrent()) return;
    await client.account.startGroupFileExport.mutate({
      ...binding,
      groupCode,
      name,
      savePolicy,
      files: [...selected.values()].map((file) => ({
        fileId: file.fileId,
        fileName: file.fileName,
        busId: file.busId,
        path: file.path,
      })),
      concurrency: 4,
    });
    if (isCurrent()) toast({ tone: 'info', title: '群文件保存任务已创建' });
  }
  return (
    <OverlayLayer
      presentation="sidecar"
      title="群文件"
      className="modal-scrim group-album-scrim"
      onClose={() => void leave(onClose)}
    >
      <section
        className="group-album-dialog group-file-dialog"
        ref={root}
        role="region"
        aria-label={`${groupName}的群文件`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {mediaSave.prompt}
        {save.serverLocation && (
          <ServerSavePrompt name={save.serverLocation.name} onChoose={save.chooseServerLocation} />
        )}
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
          <button
            className="icon-button"
            type="button"
            title="关闭"
            aria-label="关闭群文件"
            onClick={() => void leave(onClose)}
          >
            <X size={18} />
          </button>
        </header>
        <div className="group-album-body">
          <nav className="group-file-toolbar" aria-label="群文件目录">
            <div className="group-file-crumbs">
              <button
                type="button"
                className="icon-button"
                title={current.known === false ? '返回全部文件' : '返回上级目录'}
                aria-label={current.known === false ? '返回全部文件' : '返回上级目录'}
                disabled={crumbs.length < 2}
                onClick={() => void leave(() => setCrumbs((old) => old.slice(0, -1)))}
              >
                <ArrowLeft size={16} />
              </button>
              {crumbs.map((crumb, index) => (
                <button
                  className="group-file-crumb"
                  type="button"
                  key={crumb.id}
                  aria-current={index === crumbs.length - 1 ? 'page' : undefined}
                  onClick={() => void leave(() => setCrumbs((old) => old.slice(0, index + 1)))}
                >
                  {crumb.name}
                </button>
              ))}
            </div>
          </nav>
          {!a.available && <p role="status">QQ 在线能力未就绪</p>}
          {searchMissing && <p role="status">搜索命中的文件已删除或当前目录不可见。</p>}
          {error && (
            <div className="weq-file-read-error">
              <p role="alert">{error}</p>
              <button
                type="button"
                className="weq-set-iconbtn"
                title="重试读取目录"
                aria-label="重试读取目录"
                disabled={read.isFetching}
                onClick={() => void read.refetch()}
              >
                <RotateCw size={16} />
              </button>
            </div>
          )}
          {loading && (
            <div className="group-album-state" role="status">
              <Loader2 size={18} className="weq-spin" />
              <span>正在读取群文件…</span>
            </div>
          )}
          <GroupFileManager
            groupId={Number(groupCode)}
            directory={current.id}
            files={listing?.files ?? []}
            folders={listing?.folders ?? []}
            loading={loading || !!error || !a.available}
            highlightedFileId={current.id === (initialFolderId ?? '/') ? initialFileId : undefined}
            onChanged={refresh}
            onNavigationGuard={setGuard}
            onOpenFolder={(folder) =>
              setCrumbs((old) => [
                ...old,
                { id: folder.folderId, name: folder.folderName || folder.folderId },
              ])
            }
            onSaveSelected={saveSelected}
            renderFileAction={(file) => (
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
            )}
          />
        </div>
      </section>
    </OverlayLayer>
  );
}
const Scoped = withQQAccountScope(GroupFileDialogBody);
export function GroupFileDialog(props: Props) {
  return <Scoped key={props.groupCode} {...props} />;
}
