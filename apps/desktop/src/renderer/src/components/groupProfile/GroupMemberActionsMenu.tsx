import { useEffect, useRef, useState } from 'react';
import { UserRoundPlus, UsersRound } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import type { GroupConversation, GroupMember } from '../../im-template/template/types';
import { ConversationActionsMenu, type ConversationMenuAction } from '../ConversationActionsMenu';
import { NumericText } from '../NumericText';
import { GroupCardMemberList } from './GroupCardMemberList';

export function GroupMemberActionsMenu({
  conversation,
  menu,
  actions,
  onClose,
  onOpenMember,
}: {
  conversation: GroupConversation;
  menu: { x: number; y: number; anchor: HTMLElement };
  actions: ConversationMenuAction[];
  onClose: () => void;
  onOpenMember?: (member: GroupMember, anchor: { x: number; y: number }) => void;
}) {
  const { binding, available } = useQQWriteSession(`group-friend-sources:${conversation.id}`, true);
  const [list, setList] = useState<'friends' | 'addedFriends' | null>(null);
  const [collecting, setCollecting] = useState(false);
  const collectRun = useRef<AbortController | null>(null);
  const accountScope = JSON.stringify(binding);
  useEffect(() => {
    setList(null);
    setCollecting(false);
    return () => {
      collectRun.current?.abort();
      collectRun.current = null;
    };
  }, [accountScope]);

  const summary = trpc.account.contactMetrics.groupFriendSources.useQuery(
    { ...binding!, groupCode: conversation.id },
    {
      enabled: Boolean(binding),
      staleTime: 0,
      cacheTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const data = binding ? summary.data : undefined;
  const incomplete = Boolean(data && (!data.rosterComplete || data.pendingUids.length));

  async function collect() {
    if (!binding || collectRun.current || !available) return;
    const run = new AbortController();
    collectRun.current = run;
    setCollecting(true);
    try {
      const { data: current, isError } = await summary.refetch();
      if (!current || isError || run.signal.aborted) return;
      let next = 0;
      const worker = async () => {
        while (!run.signal.aborted && next < current.pendingUids.length) {
          const uid = current.pendingUids[next++]!;
          await client.account.qqWrite.friendClue
            .query({ ...binding, uid }, { signal: run.signal })
            .catch(() => undefined);
        }
      };
      await Promise.all([worker(), worker()]);
      if (!run.signal.aborted) await summary.refetch();
    } finally {
      if (collectRun.current === run) {
        collectRun.current = null;
        if (!run.signal.aborted) setCollecting(false);
      }
    }
  }

  if (list) {
    return (
      <GroupCardMemberList
        conversation={conversation}
        anchor={menu.anchor}
        ownerUid={conversation.members.find((member) => member.role === 'owner')?.id}
        kind={list}
        includedUids={
          data ? new Set(list === 'addedFriends' ? data.addedUids : data.friendUids) : undefined
        }
        onClose={onClose}
        onOpenMember={onOpenMember}
      />
    );
  }

  const count = data ? `${data.addedUids.length}${incomplete || data.unknown ? '+' : ''}` : '';
  return (
    <ConversationActionsMenu
      x={menu.x}
      y={menu.y}
      dropdown
      label="成员操作"
      onClose={onClose}
      actions={[
        {
          label: '群内好友',
          icon: <UsersRound size={15} />,
          detail: data ? (
            <NumericText>{`${data.friendUids.length}${data.rosterComplete ? '' : '+'}`}</NumericText>
          ) : undefined,
          keepOpen: true,
          action: () => setList('friends'),
        },
        {
          label: '在本群添加的好友',
          icon: <UserRoundPlus size={15} />,
          detail: collecting ? (
            '统计中…'
          ) : data ? (
            <>
              <NumericText>{count}</NumericText>
              {incomplete ? '（点击统计）' : null}
            </>
          ) : summary.isError ? (
            '读取失败，点击重试'
          ) : (
            '读取中…'
          ),
          disabled: collecting || (data ? incomplete && !available : !summary.isError),
          reason: incomplete && !available ? 'QQ 在线后可补齐好友线索' : undefined,
          keepOpen: true,
          action: () => {
            if (!data) void summary.refetch();
            else if (incomplete) void collect();
            else setList('addedFriends');
          },
        },
        ...actions,
      ]}
    />
  );
}
