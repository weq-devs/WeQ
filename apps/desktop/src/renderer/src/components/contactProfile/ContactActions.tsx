import { useContext, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { BarChart3, Eye, MessageSquare, Star } from 'lucide-react';
import { ChatNavigationContext } from '../../lib/chatNavigation';
import { ConversationDirectoryContext } from '../../lib/conversationDirectory';
import { QzoneNavigationContext } from '../../lib/qzoneNavigation';
import { client } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { PROFILE_QUERY_OPTIONS, type ProfilePerson } from '../../hooks/useContactCard';
import { Modal } from '../Dialog';
import { MemberAnalyticsDialog } from '../MemberAnalyticsDialog';
import type { AnalysisTarget } from '../../views/analysis/model';

/** 名片操作全部常驻，窄窗口内沿用操作区的自动换行。 */
export function ContactActions({
  person,
  onClose,
  onOpenChat,
  onPreviewChat,
  onAnalyze,
  onNavigate,
  groupOnly = false,
  hideGroup = false,
}: {
  person: ProfilePerson;
  onClose?: () => void;
  onOpenChat?: () => void;
  onPreviewChat?: () => void;
  onAnalyze?: (target: AnalysisTarget) => void;
  onNavigate?: (action: () => void) => void;
  groupOnly?: boolean;
  hideGroup?: boolean;
}) {
  const openChat = useContext(ChatNavigationContext);
  const openSpace = useContext(QzoneNavigationContext);
  const directory = useContext(ConversationDirectoryContext);
  const session = useQQWriteSession(`contact-actions:${person.id}`, true);
  const [groupView, setGroupView] = useState<'speech' | 'analysis' | null>(null);
  const uid = person.uid || (person.id.startsWith('u_') ? person.id : '');
  const known =
    directory?.profileConversationExists?.(person) ||
    directory?.real?.some((item) => item.id === person.id);
  const boundary = useQuery({
    queryKey: ['contact-conversation', session.binding, uid],
    queryFn: () =>
      client.account.conversationBoundary.query({ kind: 'c2c', conv: uid, newest: true }),
    enabled:
      !groupOnly &&
      !person.clone &&
      !known &&
      Boolean((onOpenChat || openChat || onPreviewChat) && uid && session.binding),
    ...PROFILE_QUERY_OPTIONS,
  });
  const exists = Boolean(known || boundary.data);
  const resolved = known || boundary.isSuccess;
  const qq =
    !person.clone &&
    ['QQ', 'UIN'].includes(person.identityLabel) &&
    /^[1-9]\d{4,19}$/.test(person.identityValue);
  const group =
    !hideGroup && !person.clone && person.profileContext && uid ? person.profileContext : null;
  function navigate(action: () => void, close = true) {
    const run = () => {
      if (close) onClose?.();
      action();
    };
    if (onNavigate) onNavigate(run);
    else run();
  }
  const primary = !groupOnly && (onOpenChat || openChat);
  const secondary: Array<{ key: string; label: string; icon: React.ReactNode; run: () => void }> =
    [];
  if (!groupOnly && (exists || person.clone) && onPreviewChat)
    secondary.push({
      key: 'chat-preview',
      label: '预览消息',
      icon: <Eye size={14} />,
      run: () => navigate(onPreviewChat, false),
    });
  if (group)
    secondary.push({
      key: 'group-speech',
      label: '本群发言',
      icon: <MessageSquare size={14} />,
      run: () => setGroupView('speech'),
    });
  if (!groupOnly && qq && openSpace)
    secondary.push({
      key: 'space',
      label: '查看空间',
      icon: <Star size={14} />,
      run: () => navigate(() => openSpace(person.identityValue, person.nick || person.displayName)),
    });
  if (group)
    secondary.push({
      key: 'group-analysis',
      label: '聊天分析',
      icon: <BarChart3 size={14} />,
      run: () =>
        onAnalyze
          ? onAnalyze({
              kind: 'member',
              groupCode: group.groupCode,
              memberUid: uid,
              memberUin: person.identityValue,
            })
          : setGroupView('analysis'),
    });
  return (
    <>
      <div className="weq-profile-actions weq-contact-actions weq-profile-card-actions">
        {primary ? (
          <button
            type="button"
            className="weq-contact-secondary"
            onClick={() =>
              navigate(() => {
                if (onOpenChat) onOpenChat();
                else openChat?.({ kind: 'direct', user: person });
              })
            }
          >
            <MessageSquare size={14} />
            {person.clone || exists || !resolved ? '打开会话' : '发起会话'}
          </button>
        ) : null}
        {secondary.map((item) => (
          <button key={item.key} type="button" className="weq-contact-secondary" onClick={item.run}>
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
      {groupView === 'analysis' && group ? (
        <MemberAnalyticsDialog
          groupCode={group.groupCode}
          groupName={group.groupName}
          member={{
            uid,
            name: person.displayName,
            uin: person.identityValue,
            avatarUrl: person.avatarUrl,
          }}
          onClose={() => setGroupView(null)}
        />
      ) : null}
      {groupView === 'speech' && group ? (
        <Modal title="本群发言" onClose={() => setGroupView(null)} width={680}>
          <GroupSpeech person={person} />
        </Modal>
      ) : null}
    </>
  );
}

export function GroupSpeech({ person }: { person: ProfilePerson }) {
  const session = useQQWriteSession(`contact-speech:${person.id}`, true);
  const query = useInfiniteQuery({
    queryKey: [
      'contact-speech',
      session.binding,
      person.profileContext?.groupCode,
      person.uid || person.id,
    ],
    queryFn: ({ pageParam }) =>
      client.account.browseConversation.query({
        kind: 'group',
        conv: person.profileContext!.groupCode,
        filter: { sender: person.uid || person.id },
        cursor: pageParam,
        limit: 30,
      }),
    getNextPageParam: (page) => (page.hasMore ? (page.cursor ?? undefined) : undefined),
    enabled: Boolean(session.binding && person.profileContext),
    ...PROFILE_QUERY_OPTIONS,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="weq-contact-speech">
      <h3>本群发言</h3>
      {query.isFetching && !query.data ? <p role="status">正在读取…</p> : null}
      {query.error ? (
        <p role="alert">
          读取失败
          <button type="button" onClick={() => void query.refetch()}>
            重试
          </button>
        </p>
      ) : null}
      {query.isSuccess && !rows.length ? <p>暂无本地发言记录</p> : null}
      {rows.map((row) => (
        <article key={row.msgId}>
          <time>
            {new Date(Number(row.sendTime) * 1000).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
            })}
          </time>
          <p>{row.content}</p>
        </article>
      ))}
      {query.hasNextPage ? (
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.fetchNextPage()}
        >
          加载更多
        </button>
      ) : null}
    </section>
  );
}
