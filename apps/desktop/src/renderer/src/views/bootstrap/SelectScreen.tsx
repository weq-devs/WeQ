/**
 * Two-pane account/key selection screen.
 *
 *   left  (~34%) — login panel: account selector + key field + enter
 *   right (~66%) — diagnostics + storage stats
 *
 * Normalizes both sources (saved configs / historical accounts) into one
 * `UiAccount[]`, owns the selected account (so switching it drives the right
 * pane), and threads counts + auto-enter target down.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useViewState } from '../../state/view';
import type { GlobalInstallInfo } from '@weq/service';
import { LoginPanel } from './LoginPanel';
import { StatsPanel } from './StatsPanel';
import type { UiAccount } from './types';

export function SelectScreen({ install }: { install: GlobalInstallInfo }): ReactElement {
  const mode = useViewState((s) => s.selectMode);
  const backHome = useViewState((s) => s.backHome);
  const goTo = useViewState((s) => s.goTo);
  const setOpenedUin = useViewState((s) => s.setOpenedUin);
  const utils = trpc.useUtils();

  const root = install.tencentFilesRoot;

  const savedConfigs = trpc.bootstrap.listAccountConfigs.useQuery(undefined, { refetchOnWindowFocus: false });
  const historical = trpc.bootstrap.listAccounts.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const userDataDirs = trpc.bootstrap.countUserDataDirs.useQuery(undefined, { refetchOnWindowFocus: false });
  const autoTarget = trpc.bootstrap.getAutoEnter.useQuery(undefined, { refetchOnWindowFocus: false });

  const allUins = useMemo(
    () => Array.from(new Set((historical.data ?? []).map((a) => a.uin))),
    [historical.data],
  );
  // Online-instance count must track QQ launching/quitting, so poll it (and
  // refetch on window focus) instead of probing once on mount.
  const online = trpc.bootstrap.probeOnline.useQuery(
    { knownUins: allUins },
    {
      enabled: !historical.isLoading,
      refetchInterval: 4000,
      refetchOnWindowFocus: true,
    },
  );

  const accounts: UiAccount[] = useMemo(() => {
    if (mode === 'existing') {
      return (savedConfigs.data ?? []).map((cfg) => ({
        key: cfg.configId,
        uin: cfg.uin,
        name: cfg.displayName || cfg.uin,
        hasName: !!cfg.displayName,
        avatarUrl: cfg.avatarUrl ?? null,
        configId: cfg.configId,
        dbKey: cfg.dbKey,
        algo: cfg.algo,
        ...(cfg.dataDir ? { dataDir: cfg.dataDir } : root ? { dataDir: `${root}\\${cfg.uin}` } : {}),
        lastLoginAt: cfg.lastLoginAt,
        ...(cfg.static ? { static: true } : {}),
      }));
    }
    return (historical.data ?? []).map((a) => ({
      key: a.uin,
      uin: a.uin,
      name: a.userName || a.uin,
      hasName: !!a.userName,
      avatarUrl: a.avatarUrl || null,
      a1Key: a.a1Key,
      ...(root ? { dataDir: `${root}\\${a.uin}` } : {}),
    }));
  }, [mode, savedConfigs.data, historical.data, root]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(() => {
    // Default to the first account; keep selection if still present.
    if (accounts.length === 0) {
      setSelectedKey(null);
      return;
    }
    setSelectedKey((prev) => (prev && accounts.some((a) => a.key === prev) ? prev : accounts[0]!.key));
  }, [accounts]);

  const selected = accounts.find((a) => a.key === selectedKey) ?? null;

  const loading =
    (mode === 'existing' ? savedConfigs.isLoading : historical.isLoading);

  function onEntered(uin: string): void {
    setOpenedUin(uin);
    goTo('main');
  }

  async function onDeleteAccount(acc: UiAccount): Promise<void> {
    if (!acc.configId) return;
    try {
      await client.bootstrap.deleteAccountConfig.mutate({ configId: acc.configId });
      await savedConfigs.refetch();
      // Also invalidate the account config list for RailAccountFooter
      void utils.bootstrap.listAccountConfigs.invalidate();
    } catch {
      // silently ignore
    }
  }

  async function pickRoot(): Promise<void> {
    const picked = await client.bootstrap.pickTencentFilesRoot.mutate();
    if (picked) {
      // pickTencentFilesRoot already persisted the override + re-probed install.
      await utils.bootstrap.describeInstall.invalidate();
      await Promise.all([userDataDirs.refetch(), savedConfigs.refetch(), historical.refetch()]);
    }
  }

  return (
    <div className="weq-select weq-anim-screen">
      <header className="weq-select-head">
        <button className="weq-icon-button" onClick={backHome} title="返回" aria-label="返回主页">
          <ArrowLeft size={17} strokeWidth={1.85} aria-hidden />
        </button>
        <div className="weq-select-head-title">
          <span className="weq-select-head-tag">{mode === 'existing' ? '现有账号配置' : '新的开始'}</span>
          <h2 className="weq-display weq-select-head-h">选择账号 · 验证密钥</h2>
        </div>
        {/* Drag handle is a dedicated spacer so the title + back button remain
            normal hit targets; the popover's outside-click handler then fires
            when the user clicks anywhere on the header. */}
        <div className="weq-select-head-drag" aria-hidden />
      </header>

      <div className="weq-select-body">
        <section className="weq-select-left">
          {loading ? (
            <div className="weq-select-loading">
              <Loader2 className="animate-spin text-[#0099ff]" size={22} strokeWidth={1.8} aria-hidden />
              <span>正在准备账号…</span>
            </div>
          ) : accounts.length === 0 ? (
            <div className="weq-select-empty">
              {mode === 'existing' ? '暂无保存的账号配置' : '未发现可用账号'}
            </div>
          ) : (
            <LoginPanel
              mode={mode === 'existing' ? 'existing' : 'new'}
              accounts={accounts}
              selected={selected}
              onSelect={(a) => setSelectedKey(a.key)}
              onDeleteAccount={mode === 'existing' ? (a) => void onDeleteAccount(a) : undefined}
              installRoot={root}
              allUins={allUins}
              autoTarget={autoTarget.data ?? null}
              onEntered={onEntered}
            />
          )}
        </section>

        <section className="weq-select-right">
          <StatsPanel
            install={install}
            selectedUin={selected?.uin ?? null}
            counts={{
              userData: userDataDirs.data ?? 0,
              online: online.data?.count ?? 0,
            }}
            onPickRoot={() => void pickRoot()}
          />
        </section>
      </div>
    </div>
  );
}
