import { useEffect, useMemo } from 'react';
import { DeferredSurfaceLoading } from '../../components/DeferredSurfaceLoading';
import { useAppDialog } from '../../lib/dialogUtils';
import { trpc } from '../../trpc/client';
import type { UserProfileWire } from '../workspace/types';
import { startCloneTask } from './cloneTaskStore';
import { NewCloneModal } from './NewCloneModal';
import { NewGroupModal } from './NewGroupModal';

export type CloneCreationRequest = { kind: 'persona'; friendUids?: string[] } | { kind: 'group' };

type DirectoryProps = {
  profiles: ReadonlyMap<string, Pick<UserProfileWire, 'uin' | 'nick' | 'remark' | 'avatarUrl'>>;
  resolveProfiles: (uids: Iterable<string>) => void;
  onClose: () => void;
};

function CreateCloneDialog({
  profiles,
  resolveProfiles,
  onClose,
  friendUids,
}: DirectoryProps & { friendUids?: string[] }) {
  const buddies = trpc.account.listBuddies.useQuery(undefined);
  useEffect(() => {
    if (buddies.data) resolveProfiles(buddies.data.map(({ uid }) => uid));
  }, [buddies.data, resolveProfiles]);
  const options = useMemo(
    () =>
      (buddies.data ?? []).map(({ uid, uin }) => {
        const profile = profiles.get(uid);
        return {
          uid,
          uin: profile?.uin || uin,
          label: profile?.remark || profile?.nick || profile?.uin || uin || uid,
          avatarUrl: profile?.avatarUrl,
        };
      }),
    [buddies.data, profiles],
  );
  if (buddies.isLoading)
    return <DeferredSurfaceLoading title="新建好友克隆" centered width={520} onClose={onClose} />;
  return (
    <NewCloneModal
      buddies={options}
      initialSelectedUids={friendUids}
      onClose={onClose}
      onStart={(args) => {
        onClose();
        void startCloneTask(args);
      }}
    />
  );
}

function CreateCloneGroupDialog({
  profiles,
  resolveProfiles,
  onClose,
  onGroupCreated,
}: DirectoryProps & { onGroupCreated?: (id: string) => void }) {
  const personas = trpc.account.listAgentLabPersonas.useQuery();
  const createGroup = trpc.account.createAgentLabGroup.useMutation();
  const utils = trpc.useUtils();
  const dialog = useAppDialog();
  useEffect(() => {
    if (personas.data) resolveProfiles(personas.data.flatMap((p) => (p ? [p.sourceId] : [])));
  }, [personas.data, resolveProfiles]);
  if (personas.isLoading)
    return <DeferredSurfaceLoading title="新建克隆体群聊" centered width={520} onClose={onClose} />;
  return (
    <NewGroupModal
      personas={(personas.data ?? []).flatMap((p) =>
        p
          ? [
              {
                id: p.id,
                name: p.name,
                uin: profiles.get(p.sourceId)?.uin || p.sourceUin,
                sourceTitle: p.sourceTitle,
              },
            ]
          : [],
      )}
      creating={createGroup.isLoading}
      onClose={onClose}
      onCreate={async (args) => {
        try {
          const { group } = await createGroup.mutateAsync(args);
          onClose();
          await utils.account.listAgentLabGroups.invalidate();
          onGroupCreated?.(group.id);
        } catch (error) {
          dialog.error('建群失败', error instanceof Error ? error.message : String(error));
        }
      }}
    />
  );
}

export function CloneCreationDialog({
  request,
  onGroupCreated,
  ...directory
}: DirectoryProps & { request: CloneCreationRequest; onGroupCreated?: (id: string) => void }) {
  return request.kind === 'group' ? (
    <CreateCloneGroupDialog {...directory} onGroupCreated={onGroupCreated} />
  ) : (
    <CreateCloneDialog {...directory} friendUids={request.friendUids} />
  );
}
