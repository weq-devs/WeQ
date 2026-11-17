import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LockKeyhole } from 'lucide-react';
import { groupResourceWindowName } from '../../../shared/group_resource_window';
import { useToolWindow } from './useCompositionWindow';
import { RenderDocumentContext } from '../lib/renderDocument';
import { useAppLock } from '../state/lock';
import { GroupAlbumDialog, GroupFileDialog } from '../components/lazyMainPanels';
import { OverlayLayer } from '../components/OverlayLayer';
import { TabActivity } from '../components/RetainedTabs';
import { ToastHost } from '../components/Toast';
import { HoverTooltip } from '../components/HoverTooltip';
import { WorkspacePages, WorkspaceContent } from '../components/WorkspacePages';
import '../styles/group-resource-window.css';
import type { Entry } from './useGroupResourceWindows.shared';

export function GroupResourceWindow({ entry, onClose }: { entry: Entry; onClose: () => void }) {
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
export type { GroupResourceRequest } from './useGroupResourceWindows.shared';
