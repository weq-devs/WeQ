/** 启动账号工作区：最近使用、本机账号与备份导入共用一个入口。 */

import { useMemo, useState, type ReactElement } from 'react';
import {
  ChevronDown,
  FolderOpen,
  FolderInput,
  History,
  Loader2,
  RefreshCw,
  Settings2,
  UserPlus,
  ArrowLeft,
} from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useDialog } from '../../components/Dialog';
import { useViewState } from '../../state/view';
import type { GlobalInstallInfo } from '@weq/service';
import { AccountSelector } from './AccountSelector';
import { LoginPanel } from './LoginPanel';
import { StaticBackupPanel } from './StaticBackupPanel';
import { StatsPanel } from './StatsPanel';
import type { UiAccount } from './types';
import logoUrl from '@resources/brand/logo.png';
import '../../styles/bootstrap-select.css';

export function SelectScreen({ install }: { install: GlobalInstallInfo }): ReactElement {
  const mode = useViewState((s) => s.selectMode);
  const enterSelect = useViewState((s) => s.enterSelect);
  const goTo = useViewState((s) => s.goTo);
  const setOpenedUin = useViewState((s) => s.setOpenedUin);
  const showError = useDialog((s) => s.showError);
  const confirm = useDialog((s) => s.confirm);
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [selection, setSelection] = useState<{ existing: string | null; new: string | null }>({
    existing: null,
    new: null,
  });

  const savedConfigs = trpc.bootstrap.listAccountConfigs.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const historical = trpc.bootstrap.listAccounts.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const autoTarget = trpc.bootstrap.getAutoEnter.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const accounts: UiAccount[] = useMemo(() => {
    if (mode === 'existing')
      return (savedConfigs.data ?? []).map((cfg) => ({
        key: cfg.configId,
        uin: cfg.uin,
        name: cfg.displayName || cfg.uin,
        hasName: !!cfg.displayName,
        avatarUrl: cfg.avatarUrl ?? null,
        configId: cfg.configId,
        dbKey: cfg.dbKey,
        algos: cfg.algos,
        dataDir: cfg.dataDir,
        sourceDir: cfg.backupAccountDir ?? cfg.dataDir,
        lastLoginAt: cfg.lastLoginAt,
        static: cfg.static,
        mobile: cfg.mobile,
        a1Key: historical.data?.find((a) => a.uin === cfg.uin)?.a1Key,
      }));
    return (historical.data ?? []).map((a) => ({
      key: a.uin,
      uin: a.uin,
      name: a.userName || a.uin,
      hasName: !!a.userName,
      avatarUrl: a.avatarUrl || null,
      a1Key: a.a1Key,
    }));
  }, [mode, savedConfigs.data, historical.data]);
  const accountMode = mode === 'existing' ? 'existing' : 'new';
  const selected = accounts.find((a) => a.key === selection[accountMode]) ?? accounts[0] ?? null;
  const accountQuery = mode === 'existing' ? savedConfigs : historical;

  function onEntered(uin: string): void {
    setOpenedUin(uin);
    useViewState.getState().backHome();
    goTo('main');
  }

  async function onDeleteAccount(acc: UiAccount): Promise<void> {
    if (!acc.configId || busy) return;
    if (
      !(await confirm(
        '移除已保存账号？',
        `从 WeQ 移除「${acc.name}」的配置，QQ 聊天记录和备份文件不会删除。`,
        { okLabel: '移除配置' },
      ))
    )
      return;
    setBusy(true);
    try {
      await client.bootstrap.deleteAccountConfig.mutate({ configId: acc.configId });
      await utils.bootstrap.listAccountConfigs.invalidate();
      await savedConfigs.refetch();
    } catch (e) {
      showError('移除失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickRoot(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const res = await client.bootstrap.pickTencentFilesRoot.mutate();
      if (res.ok) {
        await utils.bootstrap.describeInstall.invalidate();
        await Promise.all([savedConfigs.refetch(), historical.refetch()]);
      } else if (res.error) showError('目录不正确', res.error);
    } catch (e) {
      showError('选择目录失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="weq-select weq-account-workspace">
      <header className="weq-account-head">
        <div className="weq-account-brand">
          <img src={logoUrl} alt="" width={32} height={32} />
          <span>WeQ</span>
        </div>
        {mode !== 'existing' && (
          <button
            type="button"
            className="weq-icon-button weq-account-back"
            title="返回账号主页"
            aria-label="返回账号主页"
            disabled={busy}
            onClick={() => enterSelect('existing')}
          >
            <ArrowLeft size={17} aria-hidden />
          </button>
        )}
        <h1 id="account-page-title">
          {mode === 'existing' ? '打开账号' : mode === 'new' ? '添加账号' : '导入备份'}
        </h1>
      </header>
      <div className="weq-account-content">
        <section
          id="account-source-panel"
          aria-labelledby="account-page-title"
          className={mode === 'backup' ? 'weq-account-import' : 'weq-account-grid'}
        >
          {mode === 'backup' ? (
            <StaticBackupPanel onEntered={onEntered} onBusyChange={setBusy} />
          ) : (
            <>
              <section className="weq-account-detail" aria-label="打开选中账号">
                {!accountQuery.isLoading && (selected || mode === 'new') ? (
                  <LoginPanel
                    mode={accountMode}
                    accounts={accounts}
                    selected={selected}
                    onSelect={(a) => setSelection((prev) => ({ ...prev, [accountMode]: a.key }))}
                    autoTarget={autoTarget.data ?? null}
                    onEntered={onEntered}
                    onBusyChange={setBusy}
                    disabled={busy}
                  />
                ) : (
                  <div className="weq-account-detail-empty">
                    <img src={logoUrl} alt="" width={64} height={64} />
                    <span>{accountQuery.isLoading ? '正在读取账号' : '暂无可打开的账号'}</span>
                  </div>
                )}
              </section>
              <section
                className="weq-account-accounts"
                aria-label={mode === 'existing' ? '最近使用的账号' : '本机 QQ 账号'}
              >
                <div className="weq-account-section-head">
                  <h2>{mode === 'existing' ? '最近使用' : '本机 QQ 账号'}</h2>
                  <button
                    type="button"
                    className="weq-icon-button"
                    title="重新读取账号"
                    aria-label="重新读取账号"
                    disabled={busy || accountQuery.isFetching}
                    onClick={() => void accountQuery.refetch()}
                  >
                    <RefreshCw
                      size={15}
                      className={accountQuery.isFetching ? 'weq-spin' : undefined}
                      aria-hidden
                    />
                  </button>
                </div>
                {accountQuery.error && (
                  <div className="weq-select-error" role="alert">
                    读取账号失败：{accountQuery.error.message}
                  </div>
                )}
                {accountQuery.isLoading ? (
                  <div className="weq-account-empty" role="status">
                    <Loader2 className="weq-spin" size={20} aria-hidden />
                    正在准备账号…
                  </div>
                ) : accounts.length ? (
                  <AccountSelector
                    accounts={accounts}
                    selected={selected}
                    disabled={busy}
                    onSelect={(a) => setSelection((prev) => ({ ...prev, [accountMode]: a.key }))}
                    onDeleteAccount={
                      mode === 'existing' ? (a) => void onDeleteAccount(a) : undefined
                    }
                  />
                ) : (
                  !accountQuery.error && (
                    <div className="weq-account-empty">
                      <History size={28} aria-hidden />
                      <h3>{mode === 'existing' ? '还没有保存的账号' : '未发现本机 QQ 账号'}</h3>
                      {mode === 'existing' ? (
                        <button
                          type="button"
                          className="weq-action-soft"
                          onClick={() => enterSelect('new')}
                        >
                          <UserPlus size={15} aria-hidden />
                          添加账号
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="weq-action-soft"
                          disabled={busy}
                          onClick={() => void pickRoot()}
                        >
                          <FolderOpen size={15} aria-hidden />
                          选择 QQ 数据目录
                        </button>
                      )}
                    </div>
                  )
                )}
              </section>
            </>
          )}
        </section>

        {mode === 'existing' && (
          <nav className="weq-account-actions" aria-label="账号管理">
            <button
              type="button"
              data-mode="new"
              disabled={busy}
              onClick={() => enterSelect('new')}
            >
              <UserPlus size={16} aria-hidden />
              添加账号
            </button>
            <button
              type="button"
              data-mode="backup"
              disabled={busy}
              onClick={() => enterSelect('backup')}
            >
              <FolderInput size={16} aria-hidden />
              导入备份
            </button>
          </nav>
        )}

        <section className="weq-account-diagnostics">
          <button
            type="button"
            className="weq-diagnostics-trigger"
            aria-expanded={diagnostics}
            aria-controls="account-diagnostics"
            onClick={() => setDiagnostics((value) => !value)}
          >
            <Settings2 size={15} aria-hidden />
            <span>环境诊断</span>
            <ChevronDown size={15} aria-hidden />
          </button>
          {diagnostics && (
            <div id="account-diagnostics">
              <Diagnostics
                install={install}
                selectedUin={
                  mode !== 'backup' && !selected?.static ? (selected?.uin ?? null) : null
                }
                busy={busy}
                onPickRoot={() => void pickRoot()}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** 仅展开时挂载，避免打开账号前就扫描整个目录或轮询 QQ 进程。 */
function Diagnostics({
  install,
  selectedUin,
  busy,
  onPickRoot,
}: {
  install: GlobalInstallInfo;
  selectedUin: string | null;
  busy: boolean;
  onPickRoot: () => void;
}): ReactElement {
  const historical = trpc.bootstrap.listAccounts.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const dirs = trpc.bootstrap.countUserDataDirs.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const online = trpc.bootstrap.probeOnline.useQuery(
    { knownUins: (historical.data ?? []).map((a) => a.uin) },
    { enabled: !historical.isLoading, refetchInterval: 4000, refetchOnWindowFocus: true },
  );
  return (
    <StatsPanel
      install={install}
      selectedUin={selectedUin}
      counts={{ userData: dirs.data ?? null, online: online.data?.count ?? null }}
      onPickRoot={onPickRoot}
      disabled={busy}
    />
  );
}
