import { useContext, useEffect, useId, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { GroupConversation, GroupMember } from '../../im-template/template/types';
import { Avatar } from '../../im-template/template/primitives';
import { displayUserName } from '../../im-template/template/user';
import { RelationshipDirectoryContext } from '../../lib/contactRelationship';
import { mergeGroupPreviewMembers } from '../../lib/groupPreviewMembers';
import { PROFILE_QUERY_OPTIONS } from '../../lib/profileQuery';
import { previewMemberView, useGroupReadScope } from '../../hooks/useGroupProfile';
import { client } from '../../trpc/client';
import { Modal } from '../Dialog';
import { ContactInlineError } from '../contactProfile/ContactRow';

export function GroupCardMemberList({
  conversation,
  ownerUid,
  kind,
  anchor,
  onClose,
  onOpenMember,
}: {
  conversation: GroupConversation;
  ownerUid?: string;
  kind: 'members' | 'friends';
  anchor: HTMLElement;
  onClose: () => void;
  onOpenMember: (member: GroupMember, anchor: { x: number; y: number }) => void;
}) {
  const titleId = useId();
  const title = kind === 'friends' ? '群内好友' : '群成员';
  const { active, binding, key } = useGroupReadScope();
  const directory = useContext(RelationshipDirectoryContext);
  const friendsReady = kind !== 'friends' || directory?.friendsComplete === true;
  const [keyword, setKeyword] = useState('');
  const [needle, setNeedle] = useState('');
  const pendingSearch = keyword.trim() !== needle;
  useEffect(() => {
    const timer = setTimeout(() => setNeedle(keyword.trim()), 250);
    return () => clearTimeout(timer);
  }, [keyword]);
  useEffect(
    () => () => {
      if (anchor.isConnected) anchor.focus({ preventScroll: true });
    },
    [anchor],
  );
  const generated = Boolean(conversation.generated);
  const query = useInfiniteQuery({
    queryKey: ['group-card-member-list', key, conversation.id, needle],
    ...PROFILE_QUERY_OPTIONS,
    enabled: active && Boolean(binding) && !generated && friendsReady && !pendingSearch,
    queryFn: async ({ pageParam = 0 }) => {
      if (needle)
        return client.account.searchGroupMembers.query({
          ...binding!,
          groupCode: conversation.id,
          keyword: needle,
          limit: 100,
          offset: pageParam,
        });
      return {
        members: await client.account.listGroupMembers.query({
          ...binding!,
          groupCode: conversation.id,
          limit: 100,
          offset: pageParam,
        }),
      };
    },
    // 游标按原始页推进，不能按好友过滤后的数量计算。
    getNextPageParam: (last, pages) =>
      last.members.length === 100
        ? pages.reduce((count, page) => count + page.members.length, 0)
        : undefined,
  });
  const rows = mergeGroupPreviewMembers(
    generated
      ? conversation.members
      : (query.data?.pages.flatMap((page) => page.members) ?? []).map((row) =>
          previewMemberView(row, ownerUid),
        ),
  )
    .filter(
      (member) =>
        member.id && member.memberFlag !== 1 && (generated || member.identityValue !== '0'),
    )
    .filter(
      (member) =>
        kind !== 'friends' ||
        directory?.friends.has(member.id) ||
        directory?.friends.has(member.identityValue),
    )
    .filter(
      (member) =>
        !generated ||
        `${displayUserName(member)} ${member.identityValue}`
          .toLocaleLowerCase()
          .includes(keyword.trim().toLocaleLowerCase()),
    );
  const loading = !generated && (pendingSearch || query.isFetching);
  // 好友可能不在第一批成员中，先渐进查到一屏或读完，不能把空的候选页当成空名单。
  useEffect(() => {
    if (
      kind === 'friends' &&
      active &&
      friendsReady &&
      !pendingSearch &&
      rows.length < 30 &&
      query.hasNextPage &&
      !query.isFetching &&
      !query.isError
    )
      void query.fetchNextPage();
  }, [
    kind,
    active,
    friendsReady,
    pendingSearch,
    rows.length,
    query.hasNextPage,
    query.isFetching,
    query.isError,
    query.fetchNextPage,
  ]);
  const visible = pendingSearch && !generated ? [] : rows;
  return (
    <Modal
      presentation="popover"
      anchor={anchor}
      anchorPlacement="side"
      labelledBy={titleId}
      title={title}
      className="weq-group-card-member-list"
      onClose={onClose}
    >
      <header className="weq-group-member-list-header">
        <h3 id={titleId}>{title}</h3>
        <button
          type="button"
          className="weq-group-member-list-close"
          title={`关闭${title}列表`}
          aria-label={`关闭${title}列表`}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <input
        type="search"
        autoFocus
        className="weq-group-member-list-search"
        aria-label={`搜索${title}`}
        placeholder={`搜索${title}`}
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
      />
      {!friendsReady ? <p role="status">好友名单尚未就绪</p> : null}
      {!generated && !binding ? <p role="status">正在确认当前账号…</p> : null}
      <ul
        className="weq-group-member-list-rows"
        aria-label={`${title}列表`}
        onScroll={(event) => {
          const element = event.currentTarget;
          if (
            element.scrollHeight - element.scrollTop - element.clientHeight < 64 &&
            query.hasNextPage &&
            !query.isFetching &&
            !pendingSearch &&
            !query.isError
          )
            void query.fetchNextPage();
        }}
      >
        {visible.map((member) => (
          <li key={member.id}>
            <button
              type="button"
              title={`查看 ${displayUserName(member)} 的资料`}
              aria-label={`查看 ${displayUserName(member)} 的资料`}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onOpenMember(member, { x: rect.right, y: rect.bottom });
              }}
            >
              <Avatar
                name={displayUserName(member)}
                avatarUrl={member.avatarUrl}
                seed={member.identityValue}
              />
              <span>
                <strong>{displayUserName(member)}</strong>
                <small>
                  {member.identityValue}
                  {member.role === 'owner' ? ' · 群主' : member.role === 'admin' ? ' · 管理员' : ''}
                </small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {loading ? <p role="status">正在读取{title}…</p> : null}
      {query.error ? (
        <ContactInlineError
          message={`读取${title}失败，保留已显示的成员。`}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {!loading &&
      !query.error &&
      friendsReady &&
      (generated || query.isSuccess) &&
      !visible.length &&
      !query.hasNextPage ? (
        <p role="status">{keyword.trim() ? '没有匹配的成员' : `暂无本地${title}记录`}</p>
      ) : null}
      {!pendingSearch && query.hasNextPage ? (
        <button
          type="button"
          className="weq-group-member-list-more"
          disabled={query.isFetching}
          onClick={() => void query.fetchNextPage()}
        >
          加载更多
        </button>
      ) : null}
    </Modal>
  );
}
