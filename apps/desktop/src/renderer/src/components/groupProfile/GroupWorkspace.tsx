import { useCallback, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { GroupConversation, GroupMember } from '../../im-template/template/types';
import type { GroupWorkspaceTab } from '../../lib/profileNavigation';
import { GroupRosterPanel } from './GroupRosterPanel';
import { GroupLeftMembersDialog } from '../GroupLeftMembersDialog';
import { GroupEssenceDialog } from '../GroupEssenceDialog';
import { client, trpc } from '../../trpc/client';
import {
  previewMemberView,
  useGroupReadScope,
  type useGroupProfile,
} from '../../hooks/useGroupProfile';
import { PROFILE_QUERY_OPTIONS } from '../../lib/profileQuery';
import { useTabActive } from '../RetainedTabs.shared';
import { projectGroupEssence } from '../../lib/groupEssenceProjection';
import { GroupProfileData } from './GroupProfileData';
import '../../styles/group-card.css';

export function GroupWorkspace({
  data,
  onOpenMember,
  section,
}: {
  data: ReturnType<typeof useGroupProfile>;
  onOpenMember: (member: GroupMember, anchor: { x: number; y: number }) => void;
  section?: GroupWorkspaceTab;
  albumId?: string;
  folderId?: string;
  fileId?: string;
}) {
  const memberPanel = useRef<HTMLDivElement>(null);
  const openMembers = useCallback(() => {
    memberPanel.current?.scrollIntoView?.({ block: 'nearest' });
    memberPanel.current
      ?.querySelector<HTMLInputElement>('[aria-label="搜索群成员"]')
      ?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (section === 'members') openMembers();
  }, [section, openMembers]);
  const { conversation, ownerUid } = data;
  return (
    <div className="weq-group-profile-columns">
      <div className="weq-group-profile-information">
        <GroupProfileData data={data} onOpenMembers={openMembers} onOpenMember={onOpenMember} />
      </div>
      <div ref={memberPanel} className="weq-group-profile-members">
        <GroupMembers conversation={conversation} ownerUid={ownerUid} onOpenMember={onOpenMember} />
      </div>
    </div>
  );
}
function GroupMembers({
  conversation,
  ownerUid,
  onOpenMember,
}: {
  conversation: GroupConversation;
  ownerUid?: string;
  onOpenMember: (member: GroupMember, anchor: { x: number; y: number }) => void;
}) {
  const { active, binding } = useGroupReadScope(!conversation.generated);
  const [leftOpen, setLeftOpen] = useState(false);
  useEffect(() => {
    if (!active) setLeftOpen(false);
  }, [active]);
  const owner = ownerUid ?? conversation.members.find((member) => member.role === 'owner')?.id;
  const map = useCallback(
    (row: Parameters<typeof previewMemberView>[0]) => previewMemberView(row, owner),
    [owner],
  );
  const left = trpc.account.listGroupLeftMembers.useQuery(
    { ...binding!, groupCode: conversation.id, limit: 300, offset: 0 },
    { ...PROFILE_QUERY_OPTIONS, enabled: active && leftOpen && !conversation.generated },
  );
  return (
    <>
      <GroupRosterPanel
        membersOnly
        layout="profile"
        conversation={conversation}
        mapMember={map}
        onOpenMember={onOpenMember}
        onOpenLeftMembers={conversation.generated ? undefined : () => setLeftOpen(true)}
      />
      {leftOpen ? (
        <GroupLeftMembersDialog
          groupCode={conversation.id}
          groupName={conversation.group.name}
          members={(left.data ?? []).map((row) => ({
            id: row.uid,
            displayName: row.card || row.nick || row.uin,
            identity: row.uin,
            avatarUrl: map(row).avatarUrl,
          }))}
          loading={left.isFetching}
          error={left.error?.message}
          onClose={() => setLeftOpen(false)}
        />
      ) : null}
    </>
  );
}
export function GroupProfileEssence({
  conversation,
  anchor,
  onClose,
}: {
  conversation: GroupConversation;
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const active = useTabActive();
  const { binding, key } = useGroupReadScope();
  const local = trpc.account.listGroupEssenceMessages.useQuery(
    { ...binding!, groupCode: conversation.id, limit: 100, offset: 0 },
    { ...PROFILE_QUERY_OPTIONS, enabled: active && Boolean(binding) },
  );
  const online = useInfiniteQuery({
    queryKey: ['group-profile-essence', key, conversation.id],
    ...PROFILE_QUERY_OPTIONS,
    enabled: active && Boolean(binding),
    queryFn: ({ pageParam = 0 }) =>
      client.account.getGroupEssencePageWithContent.query({
        ...binding!,
        groupCode: conversation.id,
        pageStart: pageParam,
        pageLimit: 50,
      }),
    getNextPageParam: (last, pages) =>
      !last.complete && last.messages.length
        ? pages.reduce((n, page) => n + page.messages.length, 0)
        : undefined,
  });
  return (
    <GroupEssenceDialog
      presentation="popover"
      anchor={anchor}
      loadMore={
        online.hasNextPage
          ? { loading: online.isFetching, onLoad: () => void online.fetchNextPage() }
          : undefined
      }
      groupCode={conversation.id}
      groupName={conversation.group.name}
      essenceMessages={projectGroupEssence(
        local.data ?? [],
        online.data?.pages.flatMap((page) => page.messages) ?? [],
        online.data?.pages.at(-1)?.complete === true,
      )}
      loading={local.isFetching || online.isFetching}
      onlineError={Boolean(online.error)}
      onClose={onClose}
    />
  );
}
