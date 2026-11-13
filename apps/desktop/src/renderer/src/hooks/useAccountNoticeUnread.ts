import { useEffect, useMemo, useState } from 'react';
import { client } from '../trpc/client';
import type { NoticeSeenState } from '../../../shared/notice_seen';
import { mergeNoticeSeen } from '../../../shared/notice_seen';
import { useNoticeUnread } from './useNoticeUnread';

/** 连接电脑端的账号状态；断线不建立新基线，也不把已有已读回退。 */
export function useAccountNoticeUnread(
  accountKey: string,
  kind: 'friend' | 'group',
  ids: string[],
  open: boolean,
  ready: boolean,
) {
  const [remote, setRemote] = useState<{ key: string; state: NoticeSeenState | null } | null>(null);
  const scope = `${accountKey}:${kind}`;
  const transport = useMemo(() => {
    if (!accountKey) return null;
    const separator = accountKey.indexOf(':');
    const binding = {
      expectedAccountUin: accountKey.slice(0, separator),
      expectedAccountConfigId: accountKey.slice(separator + 1),
      kind,
    };
    let active = true;
    let pending: NoticeSeenState | null = null;
    let writing = false;
    const receive = (state: NoticeSeenState | null) => {
      if (!active) return;
      setRemote((previous) => {
        const merged = state
          ? mergeNoticeSeen(previous?.key === scope ? previous.state : null, state)
          : previous?.key === scope
            ? previous.state
            : null;
        return previous?.key === scope && JSON.stringify(previous.state) === JSON.stringify(merged)
          ? previous
          : { key: scope, state: merged };
      });
    };
    const flush = async () => {
      if (!active || writing || !pending) return;
      writing = true;
      const state = pending;
      pending = null;
      let saved = false;
      try {
        receive(await client.account.noticeRead.merge.mutate({ ...binding, state }));
        saved = true;
      } catch (error) {
        pending = mergeNoticeSeen(pending, state);
        console.error('[notice-read] 保存已读失败，稍后重试', error);
      } finally {
        writing = false;
        if (saved && pending) void flush();
      }
    };
    return {
      binding,
      receive,
      flush,
      start: () => {
        active = true;
      },
      publish: (state: NoticeSeenState) => {
        pending = mergeNoticeSeen(pending, state);
        void flush();
      },
      dispose: () => {
        active = false;
      },
    };
  }, [accountKey, kind, scope]);
  useEffect(() => {
    if (!transport) return;
    transport.start();
    const refresh = () => {
      void client.account.noticeRead.snapshot
        .query(transport.binding)
        .then(transport.receive, (error) => {
          console.error('[notice-read] 读取已读失败', error);
        });
      void transport.flush();
    };
    const sub = client.account.noticeRead.changed.subscribe(transport.binding, {
      onData: transport.receive,
      onError: (error) => console.error('[notice-read] 订阅失败', error),
    });
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => {
      transport.dispose();
      sub.unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [transport]);
  const sync = useMemo(
    () =>
      remote?.key === scope && transport
        ? { state: remote.state, publish: transport.publish }
        : undefined,
    [remote, scope, transport],
  );
  return useNoticeUnread(accountKey, kind, ids, open, ready && Boolean(sync), sync);
}
