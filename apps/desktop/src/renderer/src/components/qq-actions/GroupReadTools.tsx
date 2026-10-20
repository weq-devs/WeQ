import { useState } from 'react';
import { CalendarCheck, ChevronLeft, ChevronRight } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { ActionFeedback, ActionIcon, useQQAction } from './shared';

export function GroupReadTools({
  groupId,
  signing = false,
}: {
  groupId: number;
  signing?: boolean;
}) {
  const utils = trpc.useUtils();
  const a = useQQAction(`group-read:${groupId}`),
    [open, setOpen] = useState(false);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [day, setDay] = useState(today);
  const [offset, setOffset] = useState(0);
  const autoRefresh = useQQAutoRefresh(
    (signing || open) && a.available && /^\d{4}-\d{2}-\d{2}$/.test(day),
  );
  const query = trpc.account.qqActions.groupReadTools.useQuery(
    { ...a.binding!, groupId, day: day.replaceAll('-', ''), offset },
    autoRefresh,
  );
  const content = (
    <>
      {signing && (
        <div className="weq-qq-action-bar">
          <button
            type="button"
            className="weq-set-btn"
            aria-label="今日打卡"
            disabled={a.disabled}
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
                  setOffset(0);
                  await utils.account.qqActions.groupReadTools.invalidate();
                },
              )
            }
          >
            <CalendarCheck size={16} />
            今日打卡
          </button>
        </div>
      )}
      <ActionFeedback action={a} />
      <div className="weq-qq-action-form">
        <div className="weq-qq-action-bar">
          <input
            aria-label="打卡日期"
            type="date"
            value={day}
            onChange={(e) => {
              setDay(e.target.value);
              setOffset(0);
            }}
          />
        </div>
        {query.isFetching && <p role="status">读取中…</p>}
        {query.error && <p role="alert">{query.error.message}</p>}
        {query.data && (
          <>
            {!signing && (
              <p>
                @全体成员：{query.data.atAll.canAtAll ? '可用' : '不可用'} · 本账号剩余{' '}
                {query.data.atAll.remainCountForUin} 次 · 群剩余{' '}
                {query.data.atAll.remainCountForGroup} 次
              </p>
            )}
            <ul className="weq-qq-action-list">
              {query.data.signed.map((p) => (
                <li key={`${p.userId}:${p.time}`}>
                  <span>
                    {p.rank}. {p.nick || p.userId}
                  </span>
                  <time>
                    {new Intl.DateTimeFormat('zh-CN', {
                      timeZone: 'Asia/Shanghai',
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(new Date(p.time * 1000))}
                  </time>
                </li>
              ))}
            </ul>
            {query.data.signed.length === 0 && (
              <p>{offset === 0 ? '当日暂无打卡记录' : '本页暂无记录'}</p>
            )}
            <div className="weq-qq-action-bar">
              <ActionIcon
                label="上一页打卡记录"
                disabled={query.isFetching || offset === 0}
                onClick={() => setOffset((value) => Math.max(0, value - 100))}
              >
                <ChevronLeft size={16} />
              </ActionIcon>
              <span>第 {offset / 100 + 1} 页</span>
              <ActionIcon
                label="下一页打卡记录"
                disabled={query.isFetching || query.data.signed.length < 100}
                onClick={() => setOffset((value) => value + 100)}
              >
                <ChevronRight size={16} />
              </ActionIcon>
            </div>
          </>
        )}
      </div>
    </>
  );
  return signing ? (
    <section className="weq-qq-actions" aria-label="群打卡记录">
      {content}
    </section>
  ) : (
    <details className="weq-qq-actions" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>群打卡与 @全体额度</summary>
      {content}
    </details>
  );
}
