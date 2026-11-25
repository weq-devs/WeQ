/** 启动账号工作区：最近使用、本机账号与备份导入共用一个入口。 */

import { useMemo, useState, type ReactElement } from 'react';
import {
  ChevronLeft,
  FolderInput,
  FolderOpen,
  History,
  Loader2,
  RefreshCw,
  UserPlus,
  X,
} from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { Modal } from '../../components/Dialog';
import { useDialog } from '../../components/Dialog.shared';
import { useViewState } from '../../state/view';
import type { GlobalInstallInfo } from '@weq/service';
import { AccountSelector } from './AccountSelector';
import { LoginPanel } from './LoginPanel';
import { StaticBackupPanel } from './StaticBackupPanel';
import { StatsPanel } from './StatsPanel';
import { IS_MAC } from '../../lib/target.shared';
import { useRemoteClient } from '../../lib/remoteClient';
import { BootstrapWindowActions } from '../../components/BootstrapWindowActions';
import type { UiAccount } from './types';
import logoUrl from '@resources/brand/logo.png';
import '../../styles/bootstrap-select.css';

export function SelectScreen({ install }: { install: GlobalInstallInfo }): ReactElement {
  const remote = useRemoteClient();
  const mode = useViewState((s) => s.selectMode);
  const enterSelect = useViewState((s) => s.enterSelect);
  const goTo = useViewState((s) => s.goTo);
  const setOpenedUin = useViewState((s) => s.setOpenedUin);
  const showError = useDialog((s) => s.showError);
  const confirm = useDialog((s) => s.confirm);
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<UiAccount | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [qrActionHost, setQrActionHost] = useState<HTMLDivElement | null>(null);
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
  const savedAccounts = useMemo<UiAccount[]>(
    () =>
      (savedConfigs.data ?? []).map((cfg) => ({
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
      })),
    [savedConfigs.data, historical.data],
  );
  const localAccounts = useMemo<UiAccount[]>(
    () =>
      (historical.data ?? []).map((a) => ({
        key: a.uin,
        uin: a.uin,
        name: a.userName || a.uin,
        hasName: !!a.userName,
        avatarUrl: a.avatarUrl || null,
        a1Key: a.a1Key,
      })),
    [historical.data],
  );
  const adding = mode === 'new';
  const savedSelected =
    savedAccounts.find((account) => account.key === selection.existing) ?? savedAccounts[0] ?? null;
  const localSelected = adding
    ? (localAccounts.find((account) => account.key === selection.new) ?? null)
    : null;
  const selected = localSelected ?? savedSelected;
  const accounts = adding ? localAccounts : savedAccounts;
  const accountQuery = adding ? historical : savedConfigs;
  const dataAccess = trpc.bootstrap.qqDataAccess.useQuery(undefined, {
    enabled: IS_MAC,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const dataDenied = IS_MAC && dataAccess.data?.status === 'denied';

  function showLocalAccounts(): void {
    setSelection((previous) => ({ ...previous, new: null }));
    enterSelect('new');
  }

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
        { danger: 'outline', okLabel: '移除配置' },
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
    if (busy || remote) return;
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

  const sectionTitle = (
    <h2 aria-labelledby="account-section-title">
      {mode === 'existing' ? (
        <span id="account-section-title">最近使用</span>
      ) : (
        <button
          type="button"
          className="weq-account-back"
          aria-label="返回账号主页"
          disabled={busy || backupBusy}
          onClick={() => enterSelect('existing')}
        >
          <ChevronLeft size={16} aria-hidden />
          <span id="account-section-title">
            {mode === 'new' ? '添加本机 QQ 账号' : '导入 QQ 备份'}
          </span>
        </button>
      )}
    </h2>
  );

  return (
    <div className="weq-select weq-account-workspace" data-mode={mode}>
      <header className="weq-account-head">
        <div className="weq-account-heading">
          <div className="weq-account-brand">
            <img src={logoUrl} alt="" width={32} height={32} />
            <span>WeQ</span>
          </div>
          <h1 id="account-page-title">打开账号</h1>
        </div>
        <BootstrapWindowActions showAnnouncements />
      </header>
      <div className="weq-account-content">
        <section
          id="account-source-panel"
          aria-labelledby="account-page-title"
          className="weq-account-grid"
        >
          <section className="weq-account-detail" aria-label="打开选中账号">
            <LoginPanel
              mode={localSelected ? 'new' : 'existing'}
              accounts={localAccounts}
              selected={selected}
              onSelect={(account) => setSelection((prev) => ({ ...prev, new: account.key }))}
              autoTarget={autoTarget.data ?? null}
              onEntered={onEntered}
              onBusyChange={setBusy}
              disabled={busy || backupBusy || (dataDenied && !selected?.static)}
              qrActionHost={adding ? qrActionHost : null}
              qrActionDisabled={dataDenied || historical.isLoading}
              emptyContent={
                <div className="weq-account-detail-empty">
                  <img src={logoUrl} alt="" width={64} height={64} />
                  <span>{savedConfigs.isLoading ? '正在读取账号' : '请选择账号'}</span>
                </div>
              }
            />
          </section>
          <section className="weq-account-accounts" aria-labelledby="account-section-title">
            {mode === 'backup' ? (
              remote ? (
                <>
                  <div className="weq-account-section-head">{sectionTitle}</div>
                  <p role="status">WeQ Remote 不支持导入电脑目录。配置备份可在设置中从设备上传。</p>
                </>
              ) : (
                <StaticBackupPanel
                  heading={sectionTitle}
                  onEntered={onEntered}
                  onBusyChange={setBackupBusy}
                  disabled={busy}
                />
              )
            ) : (
              <>
                <div className="weq-account-section-head">
                  {sectionTitle}
                  {mode === 'existing' ? (
                    <div className="weq-account-section-tools">
                      <button
                        type="button"
                        className="weq-icon-button"
                        title="添加本机 QQ 账号"
                        aria-label="添加本机 QQ 账号"
                        disabled={busy}
                        onClick={showLocalAccounts}
                      >
                        <UserPlus size={15} aria-hidden />
                      </button>
                      {!remote && (
                        <button
                          type="button"
                          className="weq-icon-button"
                          title="导入 QQ 备份"
                          aria-label="导入 QQ 备份"
                          disabled={busy}
                          onClick={() => enterSelect('backup')}
                        >
                          <FolderInput size={15} aria-hidden />
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="weq-account-section-tools" ref={setQrActionHost} />
                  )}
                </div>
                {accountQuery.error && (
                  <div className="weq-select-error" role="alert">
                    <span>读取账号失败，请确认 QQ 数据目录可访问后重试。</span>
                    <button
                      type="button"
                      className="weq-action-soft weq-retry-button"
                      disabled={busy || accountQuery.isFetching}
                      onClick={() => void accountQuery.refetch()}
                    >
                      <RefreshCw size={14} aria-hidden />
                      重试
                    </button>
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
                    selected={adding ? localSelected : savedSelected}
                    disabled={busy}
                    onSelect={(account) =>
                      setSelection((prev) => ({
                        ...prev,
                        [adding ? 'new' : 'existing']: account.key,
                      }))
                    }
                    onDeleteAccount={
                      mode === 'existing' ? (a) => void onDeleteAccount(a) : undefined
                    }
                    onDiagnose={remote ? undefined : setDiagnostics}
                  />
                ) : (
                  !accountQuery.error && (
                    <div className="weq-account-empty">
                      <History size={28} aria-hidden />
                      <h3>
                        {mode === 'existing'
                          ? '还没有保存的账号'
                          : remote
                            ? '电脑端还没有可用账号'
                            : '未发现本机 QQ 账号'}
                      </h3>
                      {mode === 'existing' ? null : remote ? (
                        /* Remote 不能选电脑目录：按钮保留原位但不可点，并把原因和下一步写出来，
                           而不是给一个没有说明的死按钮。 */
                        <>
                          <p>
                            数据目录只能在电脑上选择。请先在电脑端选好目录并完成登录，再回到这里选择账号。
                          </p>
                          <button
                            type="button"
                            className="weq-action-soft"
                            disabled
                            title="电脑数据目录只能在电脑端选择"
                          >
                            <FolderOpen size={15} aria-hidden />
                            选择 QQ 数据目录
                          </button>
                        </>
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
              </>
            )}
          </section>
        </section>
        {diagnostics && !remote && (
          <Modal
            open
            centered
            labelledBy="account-diagnostics-title"
            onClose={() => setDiagnostics(null)}
            width={400}
            className="weq-select weq-account-diagnostics"
          >
            <div className="weq-dialog-head">
              <h3 id="account-diagnostics-title" className="weq-dialog-title">
                环境诊断
              </h3>
              <button
                type="button"
                className="weq-dialog-x"
                aria-label="关闭环境诊断"
                title="关闭"
                onClick={() => setDiagnostics(null)}
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            <Diagnostics
              install={install}
              selectedUin={diagnostics.uin}
              busy={busy}
              onPickRoot={() => void pickRoot()}
            />
          </Modal>
        )}
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
