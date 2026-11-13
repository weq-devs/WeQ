import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LockKeyhole } from 'lucide-react';
import {
  groupResourceWindowName,
  readGroupResourceWindowName,
  type GroupResourceKind,
} from '../../../shared/group_resource_window';
import { openToolPopup, useToolWindow } from './useCompositionWindow';
import { RenderDocumentContext } from '../lib/renderDocument';
import { useAppLock } from '../state/lock';
import { GroupAlbumDialog } from '../components/GroupAlbumDialog';
import { GroupFileDialog } from '../components/GroupFileDialog';
import { OverlayLayer } from '../components/OverlayLayer';
import { TabActivity } from '../components/RetainedTabs';
import { ToastHost } from '../components/Toast';
import { HoverTooltip } from '../components/HoverTooltip';
import { WorkspacePages, WorkspaceContent } from '../components/WorkspacePages';
import '../styles/group-resource-window.css';

export interface GroupResourceRequest {
  kind: GroupResourceKind;
  groupCode: string;
  groupName: string;
  initialAlbumId?: string;
  initialFolderId?: string;
  initialFileId?: string;
  onJumpToMessage?: (sequence: string, messageId: string) => void;
}

interface Entry {
  ownerKey: string;
  key: string;
  request: GroupResourceRequest;
  popup: Window | null;
  instance: number;
}

function GroupResourceWindow({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const { request } = entry;
  const title = `${request.groupName || request.groupCode} · 群${request.kind === 'albums' ? '相册' : '文件'}`;
  const locked = useAppLock((state) => state.locked);
  const tool = useToolWindow({
    name: groupResourceWindowName(entry.ownerKey, request.groupCode, request.kind),
    title,
    width: 1060,
    height: 780,
    bodyClass: 'weq-group-resource-window-body',
    initialWindow: entry.popup,
  });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (entry.popup && !tool.popup) closeRef.current();
  }, [entry.popup, tool.popup]);
  const content = (
    <div
      className="weq-group-resource-surface"
      data-resource-kind={request.kind}
      hidden={locked}
      inert={locked}
    >
      {request.kind === 'albums' ? (
        <GroupAlbumDialog
          embedded
          standalone
          groupCode={request.groupCode}
          groupName={request.groupName}
          initialAlbumId={request.initialAlbumId}
          onClose={onClose}
        />
      ) : (
        <GroupFileDialog
          embedded
          standalone
          groupCode={request.groupCode}
          groupName={request.groupName}
          initialFolderId={request.initialFolderId}
          initialFileId={request.initialFileId}
          onJumpToMessage={request.onJumpToMessage}
          onClose={onClose}
        />
      )}
    </div>
  );
  const workspace = (
    <WorkspacePages navigationKey={entry.key}>
      <WorkspaceContent>{content}</WorkspaceContent>
    </WorkspacePages>
  );
  if (tool.fallback)
    return locked ? null : (
      <OverlayLayer presentation="page" title={title} onClose={onClose}>
        {workspace}
      </OverlayLayer>
    );
  const popup = tool.popup && !tool.popup.closed ? tool.popup : null;
  return popup
    ? createPortal(
        <RenderDocumentContext.Provider value={popup.document}>
          <TabActivity active={!locked}>
            {workspace}
            <ToastHost />
            {!locked ? <HoverTooltip /> : null}
          </TabActivity>
          {locked ? (
            <div className="weq-group-resource-locked" role="status">
              <LockKeyhole size={24} />
              <span>应用已锁定</span>
            </div>
          ) : null}
        </RenderDocumentContext.Provider>,
        popup.document.body,
      )
    : null;
}

/** 群资源窗固定绑定打开时的群；会话切换不销毁，账号或数据源变更才释放。 */
export function useGroupResourceWindows({ ownerKey }: { ownerKey: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const registry = useRef(new Map<string, Entry>());
  const sequence = useRef(0);
  const close = useCallback((key: string, instance?: number) => {
    const entry = registry.current.get(key);
    if (!entry || (instance !== undefined && instance !== entry.instance)) return;
    registry.current.delete(key);
    if (entry.popup && !entry.popup.closed) entry.popup.close();
    setEntries((current) => current.filter((item) => item.key !== key));
  }, []);
  useEffect(() => {
    for (const [key, entry] of registry.current) if (entry.ownerKey !== ownerKey) close(key);
  }, [ownerKey, close]);
  const open = useCallback(
    (request: GroupResourceRequest) => {
      if (!ownerKey || useAppLock.getState().locked) return false;
      const key = groupResourceWindowName(ownerKey, request.groupCode, request.kind);
      if (!readGroupResourceWindowName(key)) return false;
      const existing = registry.current.get(key);
      if (existing && !existing.popup?.closed) {
        existing.popup?.focus();
        return true;
      }
      const entry: Entry = {
        ownerKey,
        key,
        request: { ...request },
        popup: openToolPopup(key, 1060, 780),
        instance: ++sequence.current,
      };
      registry.current.set(key, entry);
      setEntries((current) => [...current.filter((item) => item.key !== key), entry]);
      return true;
    },
    [ownerKey],
  );
  return {
    open,
    windows: entries
      .filter((entry) => entry.ownerKey === ownerKey)
      .map((entry) => (
        <GroupResourceWindow
          key={`${entry.key}:${entry.instance}`}
          entry={entry}
          onClose={() => close(entry.key, entry.instance)}
        />
      )),
  };
}
