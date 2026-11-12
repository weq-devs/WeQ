import { useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { GroupConversation, GroupMember } from '../../im-template/template/types';
import { ProfileWorkspace } from '../ProfileWorkspace';
import type { GroupWorkspaceTab } from '../../lib/profileNavigation';
import { GroupExtendedProfile } from '../GroupExtendedProfile';
import { GroupProfileMetrics } from '../GroupProfileMetrics';
import { GroupDescription, GroupTags, groupCreationDate } from './GroupContent';
import { GroupLabelSources } from '../GroupLabelSources';
import { ContactRow, ContactTechnicalDetails } from '../contactProfile/ContactRow';
import { GroupInfoPanel } from '../../im-template/template/groupInfoPanel';
import { GroupLeftMembersDialog } from '../GroupLeftMembersDialog';
import { GroupAnnouncementsDialog } from '../GroupAnnouncementsDialog';
import { GroupAlbumDialog } from '../GroupAlbumDialog';
import { GroupFileDialog } from '../GroupFileDialog';
import { GroupEssenceDialog } from '../GroupEssenceDialog';
import { GroupSignDialog } from '../GroupSignDialog';
import { GroupActions, GroupTodos } from '../qq-actions/GroupActions';
import { ContactHistory } from '../ContactHistory';
import { client, trpc } from '../../trpc/client';
import { previewMemberView, useGroupReadScope } from '../../hooks/useGroupProfile';
import { PROFILE_QUERY_OPTIONS } from '../../lib/profileQuery';
import { useTabActive } from '../RetainedTabs';
import { projectGroupEssence } from '../../lib/groupEssenceProjection';
import { ChatNavigationContext } from '../../lib/chatNavigation';
import '../../styles/group-card.css';

const sections: Array<[GroupWorkspaceTab, string]> = [
  ['profile', '概览'],
  ['details', '详细资料'],
  ['members', '成员'],
  ['announcements', '公告'],
  ['albums', '相册'],
  ['files', '文件'],
  ['essence', '精华'],
  ['sign', '打卡'],
  ['management', '群管理'],
  ['history', '资料历史'],
];
const noop = () => {};
export function GroupWorkspace({
  conversation,
  ownerUid,
  summary,
  members,
  onOpenMember,
  section,
  albumId,
  folderId,
  fileId,
}: {
  conversation: GroupConversation;
  ownerUid?: string;
  summary: ReactNode;
  members: ReactNode;
  onOpenMember: (member: GroupMember, anchor: { x: number; y: number }) => void;
  section?: GroupWorkspaceTab;
  albumId?: string;
  folderId?: string;
  fileId?: string;
}) {
  const [selected, setSelected] = useState<GroupWorkspaceTab>(section ?? 'profile');
  useEffect(() => {
    setSelected(section ?? 'profile');
  }, [section]);
  const openChat = useContext(ChatNavigationContext);
  const group = conversation.group;
  const options = conversation.generated
    ? sections.filter(([key]) => ['profile', 'details', 'members'].includes(key))
    : sections;
  return (
    <ProfileWorkspace
      label="群详情分区"
      sections={options}
      selected={options.some(([key]) => key === selected) ? selected : 'profile'}
      onSelect={setSelected}
      render={(key) => {
        if (key === 'profile')
          return (
            <>
              {summary}
              {members}
              {!conversation.generated ? (
                <GroupTodos groupId={Number(conversation.id)} groupName={group.name} />
              ) : null}
            </>
          );
        if (key === 'details') return <GroupDetails conversation={conversation} />;
        if (key === 'members')
          return (
            <GroupMembers
              conversation={conversation}
              ownerUid={ownerUid}
              onOpenMember={onOpenMember}
            />
          );
        if (key === 'history') return <ContactHistory entity={`group:${conversation.id}`} />;
        if (key === 'announcements')
          return (
            <GroupAnnouncementsDialog
              embedded
              groupCode={conversation.id}
              groupName={group.name}
              currentAnnouncement={group.announcement}
              onClose={noop}
            />
          );
        if (key === 'albums')
          return (
            <GroupAlbumDialog
              embedded
              groupCode={conversation.id}
              groupName={group.name}
              initialAlbumId={albumId}
              onClose={noop}
            />
          );
        if (key === 'files')
          return (
            <GroupFileDialog
              embedded
              groupCode={conversation.id}
              groupName={group.name}
              initialFolderId={folderId}
              initialFileId={fileId}
              onClose={noop}
            />
          );
        if (key === 'essence') return <GroupEssence conversation={conversation} />;
        if (key === 'sign')
          return (
            <GroupSignDialog
              embedded
              groupCode={conversation.id}
              groupName={group.name}
              onClose={noop}
            />
          );
        return (
          <>
            <GroupActions groupId={Number(conversation.id)} />
            {openChat ? (
              <button
                className="weq-group-text-action"
                type="button"
                onClick={() => openChat({ kind: 'group', conversation })}
              >
                在消息页查看会话设置
              </button>
            ) : null}
          </>
        );
      }}
    />
  );
}
export function GroupDetails({ conversation }: { conversation: GroupConversation }) {
  const group = conversation.group;
  return (
    <section className="weq-group-details">
      <GroupDescription text={group.description} full />
      <GroupTags group={group} />
      <div className="weq-group-details-rows">
        <ContactRow label="群名称" value={group.name} />
        <ContactRow label="群号" value={group.identityValue} mono />
        <ContactRow label="创建时间" value={groupCreationDate(group.createTime) || null} />
        <ContactRow
          label="成员／容量"
          value={
            group.memberCount > 0 || conversation.generated
              ? `${group.memberCount}${group.maxMemberCount ? ` / ${group.maxMemberCount}` : ''}`
              : null
          }
        />
        <ContactRow label="入群问题" value={group.entranceQ} />
        <ContactRow label="群地点" value={group.addressName} />
        <ContactRow
          label="我的身份"
          value={
            group.role === 'owner'
              ? '群主'
              : group.role === 'admin'
                ? '管理员'
                : group.role === 'member'
                  ? '成员'
                  : null
          }
        />
      </div>
      <GroupLabelSources group={group} members={conversation.members} />
      {!conversation.generated ? (
        <>
          <GroupProfileMetrics groupCode={conversation.id}>
            {(rows) =>
              rows.length ? (
                <ContactTechnicalDetails>
                  {rows.map(([label, value]) => (
                    <ContactRow key={label} label={label} value={value} />
                  ))}
                </ContactTechnicalDetails>
              ) : null
            }
          </GroupProfileMetrics>
          <GroupExtendedProfile groupCode={conversation.id} />
        </>
      ) : null}
    </section>
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
  const { active, binding, key } = useGroupReadScope();
  const [keyword, setKeyword] = useState('');
  const [needle, setNeedle] = useState('');
  const pendingSearch = !conversation.generated && keyword.trim() !== needle;
  useEffect(() => {
    const timer = setTimeout(() => setNeedle(keyword.trim()), 250);
    return () => clearTimeout(timer);
  }, [keyword]);
  const [leftOpen, setLeftOpen] = useState(false);
  useEffect(() => {
    if (!active) setLeftOpen(false);
  }, [active]);
  const owner = ownerUid ?? conversation.members.find((member) => member.role === 'owner')?.id;
  const map = useCallback(
    (row: Parameters<typeof previewMemberView>[0]) => previewMemberView(row, owner),
    [owner],
  );
  const query = useInfiniteQuery({
    queryKey: ['group-profile-members', key, conversation.id, needle],
    ...PROFILE_QUERY_OPTIONS,
    enabled: active && Boolean(binding) && !conversation.generated && !pendingSearch,
    queryFn: async ({ pageParam = 0 }) => {
      if (needle)
        return client.account.searchGroupMembers.query({
          ...binding!,
          groupCode: conversation.id,
          keyword: needle,
          limit: 50,
          offset: pageParam,
        });
      return {
        members: await client.account.listGroupMembers.query({
          ...binding!,
          groupCode: conversation.id,
          limit: 50,
          offset: pageParam,
        }),
      };
    },
    getNextPageParam: (last, pages) =>
      last.members.length === 50
        ? pages.reduce((count, page) => count + page.members.length, 0)
        : undefined,
  });
  const left = trpc.account.listGroupLeftMembers.useQuery(
    { ...binding!, groupCode: conversation.id, limit: 300, offset: 0 },
    { ...PROFILE_QUERY_OPTIONS, enabled: active && leftOpen && !conversation.generated },
  );
  const rows = conversation.generated
    ? conversation.members.filter((member) =>
        `${member.displayName} ${member.username} ${member.identityValue}`
          .toLocaleLowerCase()
          .includes(keyword.trim().toLocaleLowerCase()),
      )
    : pendingSearch
      ? []
      : [
          ...new Map(
            (query.data?.pages.flatMap((page) => page.members) ?? []).map((row) => [
              row.uid,
              map(row),
            ]),
          ).values(),
        ];
  return (
    <>
      <GroupInfoPanel
        membersOnly
        layout="profile"
        conversation={{ ...conversation, members: rows }}
        memberSearch={
          keyword
            ? {
                keyword,
                members: rows,
                loading: pendingSearch || (query.isFetching && !query.data),
                loadingMore: query.isFetchingNextPage,
                total:
                  query.data?.pages[0] && 'total' in query.data.pages[0]
                    ? query.data.pages[0].total
                    : rows.length,
                hasMore: Boolean(query.hasNextPage),
                error: query.error instanceof Error ? query.error.message : null,
              }
            : {
                keyword,
                members: [],
                loading: false,
                loadingMore: false,
                total: 0,
                hasMore: false,
                error: null,
              }
        }
        onMemberSearchChange={setKeyword}
        onLoadMoreSearch={() => {
          if (!pendingSearch && !query.isFetching && query.hasNextPage) void query.fetchNextPage();
        }}
        onLoadMoreMembers={() => {
          if (!pendingSearch && !query.isFetching && query.hasNextPage) void query.fetchNextPage();
        }}
        loadingMoreMembers={pendingSearch || query.isFetching}
        loadingError={query.error instanceof Error ? query.error.message : null}
        onRetryMembers={() => void query.refetch()}
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
function GroupEssence({ conversation }: { conversation: GroupConversation }) {
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
    <>
      <GroupEssenceDialog
        embedded
        groupCode={conversation.id}
        groupName={conversation.group.name}
        essenceMessages={projectGroupEssence(
          local.data ?? [],
          online.data?.pages.flatMap((page) => page.messages) ?? [],
          online.data?.pages.at(-1)?.complete === true,
        )}
        loading={local.isFetching || online.isFetching}
        onlineError={Boolean(online.error)}
        onClose={noop}
      />
      {online.hasNextPage ? (
        <button
          type="button"
          className="weq-group-text-action"
          disabled={online.isFetching}
          onClick={() => void online.fetchNextPage()}
        >
          加载更多精华
        </button>
      ) : null}
    </>
  );
}
