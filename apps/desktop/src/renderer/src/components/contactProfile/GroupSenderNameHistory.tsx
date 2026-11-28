import { useContext } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { formatDate } from '@weq/time';
import type { ProfilePerson } from '../../hooks/useContactCard';
import { GroupHistoryNavigationContext, GroupSpeechPreviewContext } from '../../lib/chatNavigation';
import { PROFILE_QUERY_OPTIONS } from '../../lib/profileQuery';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { client } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { LoadingIndicator } from '../LoadingIndicator';
import { ContactEmptyState, ContactInlineError, ContactRow, ContactSection } from './ContactRow';
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
  const uid = person.uid || person.id;
  if (person.clone || !/^u_[\w-]+$/.test(uid)) return null;
  return (
    <ProfileDisclosure key={groupCode ?? 'all'} title={groupCode ? '历史称呼' : '在各群的称呼'}>
      <History person={person} uid={uid} groupCode={groupCode} />
    </ProfileDisclosure>
  );
}

function History({
  person,
  uid,
  groupCode,
}: {
  person: ProfilePerson;
  uid: string;
  groupCode?: string;
}) {
  const { binding } = useQQWriteSession(`sender-name-history:${uid}`, true);
  const active = useTabActive();
  const jump = useContext(GroupHistoryNavigationContext);
  const speech = useContext(GroupSpeechPreviewContext);
  const result = useInfiniteQuery({
    ...PROFILE_QUERY_OPTIONS,
    queryKey: ['group-sender-names', binding, uid, groupCode],
    enabled: active && Boolean(binding),
    queryFn: ({ pageParam = 0, signal }) =>
      client.account.groupSenderNames.query(
        { ...binding!, groupCode, senderUid: uid, offset: pageParam },
        { signal },
      ),
    getNextPageParam: (last) => last.nextOffset,
    refetchInterval: (data) =>
      active && data?.pages.some((page) => page.indexPending) ? 1500 : false,
  });
  const indexPending = result.data?.pages.some((page) => page.indexPending);
  const groups = new Map<string, HistoryRow[]>();
  for (const row of result.data?.pages.flatMap((page) => page.rows) ?? []) {
    const existing = groups.get(row.groupCode);
    if (existing) existing.push(row);
    else groups.set(row.groupCode, [row]);
  }
  return (
    <>
      {!binding ? <ContactEmptyState>暂时无法读取历史称呼</ContactEmptyState> : null}
      {result.isInitialLoading ? <LoadingIndicator>正在读取历史称呼…</LoadingIndicator> : null}
      {result.isError ? (
        <ContactInlineError
          message="历史称呼读取失败"
          retrying={result.isFetching}
          onRetry={() => void result.refetch()}
        />
      ) : null}
      {indexPending ? <LoadingIndicator>正在整理历史称呼…</LoadingIndicator> : null}
      {result.isSuccess && !indexPending && !groups.size ? (
        <ContactEmptyState>没有找到保存的称呼</ContactEmptyState>
      ) : null}
      {[...groups].map(([code, rows]) => {
        const name = rows[0]!.groupName;
        const items = rows.map((row) => (
          <ContactRow
            key={JSON.stringify([row.kind, row.name])}
            label={row.kind === 'display' ? '群内称呼' : '昵称'}
          >
            <div className="weq-profile-message-name">
              <span className="weq-profile-message-name-value" data-privacy-sensitive>
                {row.name}
              </span>
              <div className="weq-profile-message-name-dates">
                {(
                  [
                    ['最早见于', row.first],
                    ['最晚见于', row.last],
                  ] as const
                )
                  .filter(
                    ([, reference], index) => index === 0 || reference.msgId !== row.first.msgId,
                  )
                  .map(([label, point]) => {
                    const instant = new Date(point.sendTime * 1000);
                    if (!Number.isFinite(instant.getTime())) return null;
                    const date = (
                      <time
                        key={label}
                        className="weq-number weq-number-inherit"
                        dateTime={instant.toISOString()}
                      >
                        {formatDate(instant)}
                      </time>
                    );
                    return jump ? (
                      <button
                        key={label}
                        type="button"
                        className="weq-profile-section-action"
                        onClick={() => jump({ code, name }, point)}
                      >
                        {label} {date}
                      </button>
                    ) : (
                      <span key={label}>
                        {label} {date}
                      </span>
                    );
                  })}
              </div>
            </div>
          </ContactRow>
        ));
        return groupCode ? (
          <div key={code}>{items}</div>
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
