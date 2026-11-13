import { dateFormatter, clockFormatter } from '@weq/time';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Loader2, RotateCw } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { ContactEmptyState } from '../contactProfile/ContactRow';
import { ActionFeedback, useQQAction } from './shared';
import { ProfileAvatar } from '../ProfileAvatar';
import { QqAvatar } from '../QqAvatar';
import '../../styles/group-sign.css';

export const GROUP_SIGN_PAGE_SIZE = 100;

export function GroupReadTools({
  groupId,
  groupName,
  signing = false,
}: {
  groupId: number;
  groupName?: string;
  signing?: boolean;
}) {
  const utils = trpc.useUtils();
  const cache = useQueryClient();
  const a = useQQAction(`group-read:${groupId}`),
    [open, setOpen] = useState(false);
  const today = dateFormatter.format(new Date());
  const [day, setDay] = useState(today);
  const listRef = useRef<HTMLUListElement>(null);
  const autoRefresh = useQQAutoRefresh(
    (signing || open) && a.available && /^\d{4}-\d{2}-\d{2}$/.test(day),
  );
  const queryKey = [
    'group-sign-members',
    a.binding?.expectedAccountUin ?? '',
    a.binding?.expectedAccountConfigId ?? '',
    groupId,
  ] as const;
  const scope = JSON.stringify([...queryKey, day]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const failedNextScope = useRef<string | null>(null);
  const query = useInfiniteQuery({
    ...autoRefresh,
    queryKey: [...queryKey, day],
    queryFn: ({ pageParam = 0 }) =>
      client.account.qqActions.groupReadTools.query({
        ...a.binding!,
        groupId,
        day: day.replaceAll('-', ''),
        offset: pageParam,
      }),
    getNextPageParam: (last, pages) => {
      const offset = pages.reduce((count, page) => count + page.signed.length, 0);
      return last.signed.length === GROUP_SIGN_PAGE_SIZE && offset <= 100000 ? offset : undefined;
    },
  });
  const signed = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages ?? [])
      .flatMap((page) => page.signed)
      .filter((entry) => {
        const key = `${entry.userId}:${entry.time}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [query.data]);
  const fetchMore = useCallback(async () => {
    const result = await query.fetchNextPage({ cancelRefetch: false });
    if (currentScope.current === scope) failedNextScope.current = result.isError ? scope : null;
  }, [query.fetchNextPage, scope]);
  useEffect(() => {
    if (query.isRefetching) failedNextScope.current = null;
  }, [query.isRefetching]);
  const loadMore = useCallback(() => {
    if (autoRefresh.enabled && query.hasNextPage && !query.isFetching && !query.isError)
      void fetchMore();
  }, [autoRefresh.enabled, query.hasNextPage, query.isFetching, query.isError, fetchMore]);
  const checkBottom = useCallback(() => {
    const list = listRef.current;
    if (
      list &&
      list.clientHeight > 0 &&
      list.scrollHeight - list.clientHeight - list.scrollTop <= 48
    )
      loadMore();
  }, [loadMore]);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const view = list.ownerDocument.defaultView;
    const frame = view?.requestAnimationFrame(checkBottom);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(checkBottom);
    observer?.observe(list);
    return () => {
      if (frame !== undefined) view?.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [checkBottom, signed.length]);
  const firstPage = query.data?.pages[0];
  const signedToday =
    day === today && signed.some((entry) => String(entry.userId) === a.binding?.expectedAccountUin);
  const dateInput = (
    <input
      aria-label="打卡日期"
      type="date"
      value={day}
      onChange={(event) => {
        setDay(event.target.value);
        if (listRef.current) listRef.current.scrollTop = 0;
      }}
    />
  );
  const content = (
    <>
      {signing && (
        <div className="weq-qq-action-bar weq-group-sign-tools">
          {dateInput}
          <button
            type="button"
            className="weq-set-btn"
            aria-label="今日打卡"
            disabled={a.disabled || signedToday}
            onClick={() =>
              void a.perform(
                (binding) =>
                  client.account.qqActions.groupSettings.mutate({
                    ...binding,
                    groupId,
                    action: 'sign',
                  }),
                async () => {
                  setDay(today);
                  if (listRef.current) listRef.current.scrollTop = 0;
                  await Promise.all([
                    utils.account.qqActions.groupReadTools.invalidate(),
                    cache.invalidateQueries({ queryKey }),
                  ]);
                },
                undefined,
                {
                  readback: async () => {
                    const result = await client.account.qqActions.groupReadTools.query({
                      ...a.binding!,
                      groupId,
                      day: today.replaceAll('-', ''),
                      offset: 0,
                    });
                    return result.signed.some(
                      (entry) => String(entry.userId) === a.binding?.expectedAccountUin,
                    );
                  },
                },
              )
            }
          >
            <CalendarCheck size={16} />
            {signedToday ? '今日已打卡' : '今日打卡'}
          </button>
        </div>
      )}
      <ActionFeedback action={a} />
      <div className="weq-qq-action-form weq-group-sign-records">
        {!signing && <div className="weq-qq-action-bar">{dateInput}</div>}
        {query.isFetching && !query.data && (
          <p className="weq-group-sign-load-state" role="status">
            <Loader2 size={14} className="weq-spin" />
            读取中…
          </p>
        )}
        {!signing && firstPage && (
          <p>
            @全体成员：{firstPage.atAll.canAtAll ? '可用' : '不可用'} · 本账号剩余{' '}
            {firstPage.atAll.remainCountForUin} 次 · 群剩余 {firstPage.atAll.remainCountForGroup} 次
          </p>
        )}
        <ul
          className="weq-qq-action-list weq-group-sign-list"
          aria-label="打卡成员列表"
          ref={listRef}
          onScroll={checkBottom}
        >
          {signed.map((p) => {
            const uin = String(p.userId);
            const valid = Number.isSafeInteger(p.userId) && /^[1-9]\d{4,19}$/.test(uin);
            const name = p.nick || uin;
            return (
              <li key={`${p.userId}:${p.time}`}>
                <span className="weq-group-sign-rank">{p.rank}</span>
                <ProfileAvatar
                  enabled={valid}
                  className="weq-group-sign-member"
                  target={{
                    identity: uin,
                    uin,
                    name,
                    group: { code: String(groupId), name: groupName || String(groupId) },
                  }}
                >
                  <QqAvatar uin={valid ? uin : undefined} size={22} />
                  <span>{name}</span>
                </ProfileAvatar>
                <time>{clockFormatter.format(new Date(p.time * 1000))}</time>
              </li>
            );
          })}
        </ul>
        {query.data && signed.length === 0 && !query.isError && (
          <ContactEmptyState>
            {day === today ? '今天还没有人打卡。' : '这一天没有打卡记录。'}
          </ContactEmptyState>
        )}
        {query.isFetchingNextPage && (
          <p className="weq-group-sign-load-state" role="status">
            <Loader2 size={14} className="weq-spin" />
            加载中…
          </p>
        )}
        {Boolean(query.error) && (
          <div className="weq-group-sign-load-state" role="alert">
            <span>{query.error instanceof Error ? query.error.message : String(query.error)}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="重试读取打卡记录"
              title="重试读取打卡记录"
              disabled={query.isFetching}
              onClick={() =>
                void (failedNextScope.current === scope ? fetchMore() : query.refetch())
              }
            >
              <RotateCw size={15} />
            </button>
          </div>
        )}
      </div>
    </>
  );
  return signing ? (
    <section className="weq-qq-actions weq-group-sign-record-page" aria-label="群打卡记录">
      {content}
    </section>
  ) : (
    <details className="weq-qq-actions" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>群打卡与 @全体额度</summary>
      {content}
    </details>
  );
}
