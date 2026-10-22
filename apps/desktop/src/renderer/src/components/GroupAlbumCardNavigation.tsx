import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  GroupAlbumCardNavigationContext,
  type GroupAlbumCardTarget,
} from '../lib/groupAlbumNavigation';
import { ConversationDirectoryContext } from '../lib/conversationDirectory';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { GroupAlbumDialog } from './GroupAlbumDialog';
import { GroupAlbumFeedDialog } from './GroupAlbumFeedDialog';
import { useToast } from './Toast';

export interface GroupAlbumCardRequest extends QQWriteBinding {
  target: GroupAlbumCardTarget;
  groupName: string;
  revision: string;
}

export function GroupAlbumCardDialog({
  request,
  onClose,
  onOpenAlbum,
}: {
  request: GroupAlbumCardRequest;
  onClose: () => void;
  onOpenAlbum: () => void;
}) {
  const binding = useMemo(
    () => ({
      expectedAccountUin: request.expectedAccountUin,
      expectedAccountConfigId: request.expectedAccountConfigId,
    }),
    [request.expectedAccountUin, request.expectedAccountConfigId],
  );
  return request.target.kind === 'album' ? (
    <GroupAlbumDialog
      groupCode={request.target.groupCode}
      groupName={request.groupName}
      initialAlbumId={request.target.albumId}
      binding={binding}
      onClose={onClose}
    />
  ) : (
    <GroupAlbumFeedDialog
      target={request.target}
      binding={binding}
      groupName={request.groupName}
      onClose={onClose}
      onOpenAlbum={onOpenAlbum}
    />
  );
}

/** 导航固定点击时的账号来源；旧回调和旧请求不能在新来源中重新绑定。 */
export function GroupAlbumCardNavigationProvider({
  binding,
  children,
}: {
  binding: QQWriteBinding | null;
  children: ReactNode;
}) {
  const directory = useContext(ConversationDirectoryContext);
  const [request, setRequest] = useState<GroupAlbumCardRequest | null>(null);
  const uin = binding?.expectedAccountUin,
    configId = binding?.expectedAccountConfigId;
  const current =
    request && request.expectedAccountUin === uin && request.expectedAccountConfigId === configId
      ? request
      : null;
  useEffect(() => {
    if (request && !current) setRequest(null);
  }, [request, current]);
  const navigate = useCallback(
    (target: GroupAlbumCardTarget) => {
      if (!uin || !configId) {
        useToast.getState().push({ tone: 'error', title: '账号或数据源尚未就绪' });
        return;
      }
      const known = directory?.real?.find(
        (row) => row.type === 'group' && row.id === target.groupCode,
      );
      setRequest({
        target: { ...target },
        groupName: known?.type === 'group' ? known.group.name : `群 ${target.groupCode}`,
        expectedAccountUin: uin,
        expectedAccountConfigId: configId,
        revision: crypto.randomUUID(),
      });
    },
    [directory, uin, configId],
  );
  return (
    <GroupAlbumCardNavigationContext.Provider value={navigate}>
      {children}
      {current ? (
        <GroupAlbumCardDialog
          key={current.revision}
          request={current}
          onClose={() => setRequest(null)}
          onOpenAlbum={() =>
            setRequest((previous) =>
              previous
                ? {
                    ...previous,
                    target: {
                      kind: 'album',
                      groupCode: previous.target.groupCode,
                      albumId: previous.target.albumId,
                    },
                    revision: crypto.randomUUID(),
                  }
                : null,
            )
          }
        />
      ) : null}
    </GroupAlbumCardNavigationContext.Provider>
  );
}
