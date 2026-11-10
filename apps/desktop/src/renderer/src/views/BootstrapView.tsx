/**
 * Bootstrap (home) view orchestrator.
 *
 *   1. Native-init gate — if the QQ helper bundle failed to load, show a
 *      blocking error dialog (版本过旧 / 安装损坏) and nothing else.
 *   2. Install warnings — no QQ.exe ⇒ "未检测到 QQ"; no wrapper.node ⇒
 *      "安装损坏"; missing user-data dir is handled inline (pick button);
 *      missing login.db is silent (fallback covers it).
 *   3. Auto-enter — on first load, if a global auto-enter target exists,
 *      silently test its key and enter; on failure drop to the home screen
 *      with an error dialog.
 *   4. 启动探测完成后直接进入账号工作区。
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { trpc, client } from '../trpc/client';
import { useViewState } from '../state/view';
import { useDialog } from '../components/Dialog';
import { BootstrapWindowActions } from '../components/BootstrapWindowActions';
import { SelectScreen } from './bootstrap/SelectScreen';
import { WarmupSplash } from '../components/WarmupSplash';
import { NativeExpiredDialog } from '../components/NativeExpiredDialog';
import { runAccountWarmup, type WarmupProgress } from '../lib/accountWarmup';
import { setWindowLayout } from '../lib/windowLayout';
import { IS_MAC, IS_WEB } from '../lib/target';
import logoUrl from '@resources/brand/logo.png';
import { BackupSection } from '../components/settings/BackupSection';
import '../styles/startup-shell.css';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function BootstrapView(): ReactElement {
  const homeStage = useViewState((s) => s.homeStage);
  const setHomeStage = useViewState((s) => s.setHomeStage);
  const goTo = useViewState((s) => s.goTo);
  const setOpenedUin = useViewState((s) => s.setOpenedUin);
  const showError = useDialog((s) => s.showError);
  const utils = trpc.useUtils();
  /** 非 null 时 splash 显示预热进度条（自动进入的第二段）。 */
  const [warmup, setWarmup] = useState<WarmupProgress | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);

  const nativeStatus = trpc.bootstrap.nativeStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const nativeErr = nativeStatus.data ?? null;
  const nativeOk = nativeStatus.isSuccess && nativeStatus.data === null;

  const currentAccount = trpc.bootstrap.currentAccount.useQuery(undefined, {
    enabled: nativeOk && homeStage === 'booting',
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: false,
  });
  const needsStartup =
    nativeOk && (homeStage !== 'booting' || (currentAccount.isSuccess && !currentAccount.data));

  const dataAccess = trpc.bootstrap.qqDataAccess.useQuery(undefined, {
    enabled: needsStartup && IS_MAC,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  const install = trpc.bootstrap.describeInstall.useQuery(undefined, {
    enabled: needsStartup,
    refetchOnWindowFocus: false,
  });
  const configs = trpc.bootstrap.listAccountConfigs.useQuery(undefined, {
    enabled: needsStartup,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const autoTarget = trpc.bootstrap.getAutoEnter.useQuery(
    { startup: !IS_WEB },
    {
      enabled: needsStartup,
      refetchOnWindowFocus: false,
    },
  );
  const startupPage = trpc.bootstrap.getStartupPage.useQuery(undefined, {
    enabled: needsStartup && !IS_WEB && homeStage === 'booting',
    refetchOnWindowFocus: false,
    retry: false,
  });

  // 过期弹窗要显示构建/过期时间。注意这个 query 不看 nativeOk：构建过期时它照样能
  // 读出来（`readNativeBuildInfo` 绕过了初始化校验）。
  const nativeBuildInfo = trpc.bootstrap.getNativeBuildInfo.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  // ---- native-init error dialog (blocking) ----
  // expired 走专有的 NativeExpiredDialog（内嵌更新组件），damaged 仍用通用错误框。
  useEffect(() => {
    if (!nativeErr || nativeErr.kind === 'expired') return;
    showError('安装损坏', 'QQ 助手组件已损坏或被篡改，请重新安装或更新后重试。', {
      dismissible: false,
    });
  }, [nativeErr, showError]);

  // ---- install warnings (once) ----
  const installWarned = useRef(false);
  useEffect(() => {
    if (!install.data || installWarned.current) return;
    installWarned.current = true;
    if (!install.data.hasQqExe) {
      showError('未检测到 QQ', '未找到 QQ 安装，请先安装 QQ NT 后重试。');
    } else if (!install.data.hasWrapper) {
      showError('安装损坏', 'QQ 安装可能已损坏或版本不受支持。');
    }
  }, [install.data, showError]);

  // ---- auto-enter (first load) ----
  const booted = useRef(false);
  useEffect(() => {
    if (homeStage !== 'booting' || booted.current) return;
    if (nativeErr) {
      booted.current = true;
      setHomeStage('home');
      return;
    }
    if (nativeOk) {
      if (currentAccount.isError) {
        booted.current = true;
        setHomeStage('home');
        showError('读取当前账号失败', errMsg(currentAccount.error));
        return;
      }
      if (!currentAccount.isSuccess) return;
      if (currentAccount.data) {
        // 重载只接回主进程中的账号；不能重开数据库、切到自动进入目标或重置窗口。
        booted.current = true;
        const uin = currentAccount.data.uin;
        void (async () => {
          await utils.account.getAccountConfig.fetch();
          // Web 只等待挂载必需配置，身份与会话列表在工作区内异步读取。
          if (!IS_WEB) {
            await runAccountWarmup(utils, setWarmup);
          }
          setOpenedUin(uin);
          goTo('main');
          setHomeStage('home');
        })().catch((error: unknown) => {
          setWarmup(null);
          setHomeStage('home');
          showError('恢复工作区失败', errMsg(error));
        });
        return;
      }
    }
    if (!nativeOk || !autoTarget.isFetched || !configs.isFetched) return;
    if (!IS_WEB && !startupPage.isFetched) return;
    if (IS_MAC && !dataAccess.isFetched) return;
    booted.current = true;
    useViewState.setState({
      startupPage:
        !IS_WEB && (startupPage.data === 'home' || startupPage.data === 'messages')
          ? startupPage.data
          : null,
    });

    const target = autoTarget.data ?? null;
    const cfg = target ? (configs.data ?? []).find((c) => c.configId === target.configId) : null;
    if (
      IS_MAC &&
      !cfg?.static &&
      (dataAccess.isError ||
        dataAccess.data?.status === 'denied' ||
        dataAccess.data?.status === 'error')
    ) {
      setHomeStage('home');
      return;
    }
    if (!target || !cfg) {
      setHomeStage('home');
      return;
    }

    void (async () => {
      try {
        if (cfg.static) {
          // Static (offline) account — no live key gate; re-open from its
          // saved decrypted-db directory.
          if (!cfg.dataDir) throw new Error('该静态账号缺少数据库目录，请重新导入。');
          await client.bootstrap.openStaticAccount.mutate({
            dirPath: cfg.dataDir,
            preview: {
              uin: cfg.uin,
              uid: cfg.uid ?? '',
              displayName: cfg.displayName ?? '',
              avatarUrl: cfg.avatarUrl ?? '',
            },
            ...(cfg.dbKey ? { dbKey: cfg.dbKey } : {}),
            ...(cfg.algos?.['nt_msg.db'] ? { algo: cfg.algos['nt_msg.db'] } : {}),
            ...(cfg.mobile ? { mobile: true } : {}),
          });
        } else {
          const test = await client.bootstrap.testDatabaseKey.mutate({
            uin: cfg.uin,
            dbKey: cfg.dbKey,
          });
          if (!test.success) throw new Error(test.error ?? '数据库密钥不正确');
          await client.bootstrap.openAccount.mutate({
            uin: cfg.uin,
            dbKey: cfg.dbKey,
            algo: test.algo,
            ...(cfg.displayName ? { displayName: cfg.displayName } : {}),
            ...(cfg.avatarUrl ? { avatarUrl: cfg.avatarUrl } : {}),
            ...(cfg.dataDir ? { dataDir: cfg.dataDir } : {}),
          });
        }
        // 账号已打开，但先别进 MainView。两件事必须发生在它挂载之前：
        //
        //  1. resize 到 chat 尺寸。App.tsx 的 layout effect 是在 view 变成 'main'
        //     *之后* 才发 IPC，也就是 MainView 会先按 home 的 580 高度画一帧——
        //     左栏上下贴边的按钮在这个高度会重叠。提前调好就不会有这一帧。
        //  2. 预热 MainView 那 8 个查询，否则首屏是空白头像 + 默认昵称 "WeQ"。
        setWindowLayout('chat');
        if (!IS_WEB) await runAccountWarmup(utils, setWarmup);

        // Land on 'home' so closing the account later returns to the landing
        // screen rather than re-running the (now consumed) boot splash.
        setHomeStage('home');
        setOpenedUin(cfg.uin);
        goTo('main');
      } catch (e) {
        // 已经调大过窗口就调回来——失败要落回 home 屏，不能留着 chat 的尺寸。
        setWarmup(null);
        setWindowLayout('home');
        setHomeStage('home');
        showError('自动进入失败', errMsg(e));
      }
    })();
  }, [
    homeStage,
    nativeOk,
    nativeErr,
    currentAccount.isSuccess,
    currentAccount.isError,
    currentAccount.error,
    currentAccount.data,
    autoTarget.isFetched,
    autoTarget.data,
    startupPage.isFetched,
    startupPage.data,
    configs.isFetched,
    configs.data,
    dataAccess.isFetched,
    dataAccess.isError,
    dataAccess.data,
    setHomeStage,
    setOpenedUin,
    goTo,
    showError,
    utils,
  ]);

  // ---- render ----
  if (nativeErr) {
    if (backupOpen)
      return (
        <BootstrapShell>
          <div className="weq-backup-native">
            <button type="button" className="weq-set-btn" onClick={() => setBackupOpen(false)}>
              <X size={14} />
              返回组件诊断
            </button>
            <BackupSection />
          </div>
        </BootstrapShell>
      );
    return (
      <BootstrapShell>
        <Centered>
          <img src={logoUrl} alt="" width={84} height={84} className="opacity-40 grayscale" />
          <p className="mt-4 text-[14px] text-muted-foreground">
            {nativeErr.kind === 'expired' ? '组件版本过旧，请更新。' : '组件安装损坏，请重新安装。'}
          </p>
          <button type="button" className="weq-set-btn" onClick={() => setBackupOpen(true)}>
            备份与恢复
          </button>
        </Centered>
        {nativeErr.kind === 'expired' ? (
          <NativeExpiredDialog
            buildTime={nativeBuildInfo.data?.buildTime ?? null}
            expireTime={nativeBuildInfo.data?.expireTime ?? null}
            onBackup={() => setBackupOpen(true)}
          />
        ) : null}
      </BootstrapShell>
    );
  }

  if (homeStage === 'booting' || nativeStatus.isLoading) {
    return (
      <BootstrapShell>
        <Splash progress={warmup} />
      </BootstrapShell>
    );
  }

  if (!install.data) {
    return (
      <BootstrapShell>
        <Splash />
      </BootstrapShell>
    );
  }

  return (
    <BootstrapShell showWindowActions={false}>
      <SelectScreen install={install.data} />
    </BootstrapShell>
  );
}

export function BootstrapShell({
  children,
  showWindowActions = true,
}: {
  children: ReactNode;
  showWindowActions?: boolean;
}): ReactElement {
  return (
    <main className="weq-home-shell h-screen overflow-hidden font-sans text-foreground">
      {showWindowActions && (
        <header className="weq-startup-titlebar">
          <div className="weq-startup-drag" />
          <BootstrapWindowActions />
        </header>
      )}
      <div className="relative z-10 h-full">{children}</div>
    </main>
  );
}

function Centered({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex h-full flex-col items-center justify-center">{children}</div>;
}

function Splash({ progress }: { progress?: WarmupProgress | null }): ReactElement {
  return <WarmupSplash progress={progress} />;
}
