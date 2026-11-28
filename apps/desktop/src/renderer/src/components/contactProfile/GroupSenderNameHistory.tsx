import { useContext, useLayoutEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { formatDate } from '@weq/time';
import type { ProfilePerson } from '../../hooks/useContactCard';
import { GroupHistoryNavigationContext, GroupSpeechPreviewContext } from '../../lib/chatNavigation';
import { PROFILE_QUERY_OPTIONS } from '../../lib/profileQuery';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { client } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { ContactEmptyState, ContactInlineError, ContactSection } from './ContactRow';
import { ProfileDisclosure } from './ProfileDisclosure';
import '../../styles/contact-workspace.css';

type HistoryRow = Awaited<ReturnType<typeof client.account.groupSenderNames.query>>['rows'][number];

export function GroupSenderNameHistory({
  person,
  groupCode,
}: {
  person: ProfilePerson;
  groupCode?: string;
}) {
  const [loading, setLoading] = useState(false);
  const uid = person.uid || person.id;
  if (person.clone || !/^u_[\w-]+$/.test(uid)) return null;
  return (
    <ProfileDisclosure key={groupCode ?? 'all'} title="历史称呼" loading={loading}>
      <History person={person} uid={uid} groupCode={groupCode} onLoadingChange={setLoading} />
    </ProfileDisclosure>
  );
}

function History({
  person,
  uid,
  groupCode,
  onLoadingChange,
}: {
  person: ProfilePerson;
  uid: string;
  groupCode?: string;
  onLoadingChange: (loading: boolean) => void;
}) {
  const { binding } = useQQWriteSession(`sender-name-history:${uid}`, true);
  const active = useTabActive();
  const speech = useContext(GroupSpeechPreviewContext);
  const result = useInfiniteQuery({
    ...PROFILE_QUERY_OPTIONS,
    queryKey: ['profile-sender-name-periods', binding, uid, groupCode],
    enabled: active && Boolean(binding),
    queryFn: ({ pageParam = 0, signal }) =>
      client.account.groupSenderNames.query(
        { ...binding!, groupCode, senderUid: uid, profileHistory: true, offset: pageParam },
        { signal },
      ),
    getNextPageParam: (last) => last.nextOffset,
    refetchInterval: (data) =>
      active && data?.pages.some((page) => page.indexPending) ? 1500 : false,
  });
  const indexPending = result.data?.pages.some((page) => page.indexPending);
  const loading = result.isInitialLoading || Boolean(indexPending);
  useLayoutEffect(() => onLoadingChange(loading), [loading, onLoadingChange]);
  const rows = result.data?.pages.flatMap((page) => page.rows) ?? [];
  const nicknames: HistoryRow[] = [];
  const groups = new Map<string, { name: string; rows: HistoryRow[] }>();
  for (const row of rows) {
    if (row.kind === 'nickname') {
      nicknames.push(row);
    } else if (row.groupCode) {
      const group = groups.get(row.groupCode);
      if (group) group.rows.push(row);
      else groups.set(row.groupCode, { name: row.groupName || row.groupCode, rows: [row] });
    }
  }
  return (
    <>
      {!binding ? <ContactEmptyState>暂时无法读取历史称呼</ContactEmptyState> : null}
      {result.isError ? (
        <ContactInlineError
          message="历史称呼读取失败"
          retrying={result.isFetching}
          onRetry={() => void result.refetch()}
        />
      ) : null}
      {result.isSuccess && !indexPending && !rows.length ? (
        <ContactEmptyState>没有找到保存的称呼</ContactEmptyState>
      ) : null}
      {nicknames.length > 0 ? (
        <ContactSection title="QQ 昵称">
          <HistoryNames rows={nicknames} currentName={person.nick?.trim()} />
        </ContactSection>
      ) : null}
      {[...groups].map(([code, { name, rows: groupRows }]) => {
        const items = <HistoryNames key={code} rows={groupRows} />;
        return groupCode ? (
          items
        ) : (
          <ContactSection
            key={code}
            title={name}
            action={
              speech ? (
                <button
                  type="button"
                  className="weq-profile-section-action"
                  onClick={() =>
                    speech.open(
                      { ...person, profileContext: { groupCode: code, groupName: name } },
                      'contact',
                    )
                  }
                >
                  查看本群发言
                </button>
              ) : undefined
            }
          >
            {items}
          </ContactSection>
        );
      })}
      {result.hasNextPage && !indexPending ? (
        <button
          type="button"
          className="weq-profile-section-action"
          disabled={result.isFetchingNextPage}
          onClick={() => void result.fetchNextPage()}
        >
          {result.isFetchingNextPage ? '正在加载…' : '加载更多'}
        </button>
      ) : null}
    </>
  );
}

function HistoryNames({ rows, currentName }: { rows: HistoryRow[]; currentName?: string }) {
  return (
    <ul className="weq-profile-message-names" role="list">
      {rows.map(({ name, first, last }, index) => (
        <li
          key={`${first.groupCode}:${first.msgId}`}
          className="weq-profile-message-name"
          data-privacy-sensitive
        >
          <span className="weq-profile-message-name-value">{name}</span>
          <div className="weq-profile-message-name-dates">
            {index === 0 && name === currentName ? <span>当前</span> : null}
            <span className="weq-profile-message-name-range">
              <HistoryDate point={first} label="首条消息" />
              {first.msgId !== last.msgId || first.groupCode !== last.groupCode ? (
                <>
                  <span aria-hidden>~</span>
                  <HistoryDate point={last} label="末条消息" />
                </>
              ) : null}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function HistoryDate({ point, label }: { point: HistoryRow['first']; label: string }) {
  const jump = useContext(GroupHistoryNavigationContext);
  const instant = new Date(point.sendTime * 1000);
  if (!Number.isFinite(instant.getTime())) return null;
  const display = formatDate(instant);
  const date = (
    <time className="weq-number weq-number-inherit" dateTime={instant.toISOString()}>
      {display}
    </time>
  );
  const code = point.groupCode;
  return jump && code ? (
    <button
      type="button"
      className="weq-profile-section-action"
      aria-label={`定位到 ${display} 的${label}`}
      onClick={() => jump({ code, name: point.groupName || code }, point)}
    >
      {date}
    </button>
  ) : (
    date
  );
}
