/**
 * 左栏底部：当前账号大头像 + 右侧弹层（其他账号 / 退出）。
 *
 * 切换/退出都走 closeAccount → 后端 clearAccount 显式停掉
 * accountMonitor（QQ 登录实例监听）和 dbWatchHandle（数据库监听），
 * 切换时再 openAccount 重新开启。MainView 在 App.tsx 中用
 * key={openedUin} 强制重挂载，避免 onDbChanged 订阅绑到旧账号。
 *
 * 关键：切换/退出时必须用 queryClient.removeQueries 把 React Query
 * 里所有 `trpc.account.*` 的缓存条目「彻底清除」（不仅 invalidate）。
 * 否则新账号挂载 MainView 时，useQuery 会把旧账号的 listRecentContacts
 * 缓存数据当作初始值返回，导致 recent_contact 残留旧账号会话。
 * staleTime=5min + refetchOnMount=false 会把这个窗口放大到几分钟。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { LogOut } from 'lucide-react';
import { trpc, client } from '../trpc/client';
import { useViewState } from '../state/view';
import { useDialog } from './Dialog';
import { QqAvatar } from './QqAvatar';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function RailAccountFooter({
  currentUin,
  currentName,
  currentAvatarUrl,
}: {
  currentUin: string;
  currentName: string;
  currentAvatarUrl?: string | null;
}): ReactElement {
  const setOpenedUin = useViewState((s) => s.setOpenedUin);
  const goTo = useViewState((s) => s.goTo);
  const showError = useDialog((s) => s.showError);
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Drop EVERY cached `trpc.account.*` entry (recent contacts, profiles,
  // buddies, group details, …) so the next account's MainView mount cannot
  // read the previous account's data while its own fetch is still in flight.
  // We use removeQueries (not invalidateQueries) because invalidate would
  // still hand stale data to the next subscriber until the refetch resolves.
  // Also cancel any in-flight account-scoped requests — those would
  // otherwise land in the cache after the wipe, under the new account.
  function purgeAccountCache(): void {
    const accountKey = getQueryKey(trpc.account);
    void queryClient.cancelQueries({ queryKey: accountKey });
    queryClient.removeQueries({ queryKey: accountKey });
  }

  const configs = trpc.bootstrap.listAccountConfigs.useQuery(undefined, {
    enabled: open,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!open) return undefined;
    function onMouseDown(e: MouseEvent): void {
      if (!(e.target instanceof Node)) return;
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function signOut(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      await client.bootstrap.closeAccount.mutate();
      // Wipe the previous account's cached queries before the renderer
      // re-paints — otherwise recent_contact / buddies / groups flash
      // through on the way back to bootstrap.
      purgeAccountCache();
      setOpenedUin(null);
      goTo('bootstrap');
    } catch (e) {
      showError('退出失败', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function switchTo(cfg: {
    uin: string;
    dbKey: string;
    algo?: { pageHmacAlgorithm: string; kdfHmacAlgorithm: string } | null;
    displayName?: string;
    avatarUrl?: string | null;
    dataDir?: string;
  }): Promise<void> {
    if (busy) return;
    if (cfg.uin === currentUin) return;
    setBusy(true);
    setOpen(false);
    try {
      await client.bootstrap.closeAccount.mutate();
      // Purge BEFORE we drop openedUin: any account-scoped useQuery that
      // re-renders during the brief null-uin window must not be served the
      // outgoing account's data from the React Query cache.
      purgeAccountCache();
      setOpenedUin(null);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await client.bootstrap.openAccount.mutate({
        uin: cfg.uin,
        dbKey: cfg.dbKey,
        ...(cfg.algo ? { algo: cfg.algo } : {}),
        ...(cfg.displayName ? { displayName: cfg.displayName } : {}),
        ...(cfg.avatarUrl ? { avatarUrl: cfg.avatarUrl } : {}),
        ...(cfg.dataDir ? { dataDir: cfg.dataDir } : {}),
      });
      // Second purge: anything an in-flight component re-issued between the
      // first purge and openAccount completion (e.g. a useQuery refetch
      // triggered by the unmount/remount transition) would have hit the
      // CLOSED backend and either errored or returned old data. Wipe again
      // so the freshly-mounted MainView starts from a clean slate.
      purgeAccountCache();
      setOpenedUin(cfg.uin);
    } catch (e) {
      // Already closed; fall back to bootstrap so the user can recover.
      purgeAccountCache();
      setOpenedUin(null);
      goTo('bootstrap');
      showError('切换账号失败', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const others = (configs.data ?? []).filter((c) => c.uin !== currentUin);

  return (
    <div ref={wrapRef} className="weq-rail-account-footer">
      <button
        type="button"
        className="weq-rail-account-avatar"
        title={`${currentName}（点击切换账号）`}
        aria-label="切换账号"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
      >
        <QqAvatar uin={currentUin} url={currentAvatarUrl ?? null} size={44} />
      </button>
      {open ? (
        <section className="weq-rail-account-popover" role="menu">
          <div className="weq-rail-account-popover-head">
            <span className="weq-rail-account-popover-title">切换账号</span>
          </div>
          {configs.isLoading ? (
            <div className="weq-rail-account-empty">加载中…</div>
          ) : others.length === 0 ? (
            <div className="weq-rail-account-empty">暂无其它账号</div>
          ) : (
            <ul className="weq-rail-account-list">
              {others.map((cfg) => (
                <li key={cfg.configId}>
                  <button
                    type="button"
                    className="weq-rail-account-item"
                    onClick={() => void switchTo(cfg)}
                    disabled={busy}
                  >
                    <QqAvatar uin={cfg.uin} url={cfg.avatarUrl} size={40} />
                    <span className="weq-rail-account-item-text">
                      <span className="weq-rail-account-item-name">
                        {cfg.displayName || cfg.uin}
                      </span>
                      <span className="weq-rail-account-item-uin">{cfg.uin}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="weq-rail-account-signout"
            onClick={() => void signOut()}
            disabled={busy}
          >
            <span>退出登录</span>
            <LogOut size={18} strokeWidth={1.8} aria-hidden />
          </button>
        </section>
      ) : null}
    </div>
  );
}
