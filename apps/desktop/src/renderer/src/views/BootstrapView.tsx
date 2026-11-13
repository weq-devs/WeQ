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

import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { trpc, client } from '../trpc/client';
import { useViewState } from '../state/view';
import { useDialog } from '../components/Dialog';
import { BootstrapWindowActions } from '../components/BootstrapWindowActions';
import { SelectScreen } from './bootstrap/SelectScreen';
import { WarmupSplash } from '../components/WarmupSplash';
import { NativeExpiredDialog } from '../components/NativeExpiredDialog';
import { runDesktopStartupWarmup, type WarmupProgress } from '../lib/accountWarmup';
import { setWindowLayout } from '../lib/windowLayout';
import { IS_MAC, IS_WEB } from '../lib/target';
import logoUrl from '@resources/brand/logo.png';
const BackupSection = lazy(() =>
  import('../components/settings/BackupSection').then((module) => ({
    default: module.BackupSection,
  })),
);
import '../styles/startup-shell.css';
import { WebStartupCache, WEB_STARTUP_CACHE_KEY } from '../lib/webStartupCache';
import { advanceStartup } from '../state/startupProgress';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function BootstrapView(): ReactElement {
  const queryCache = useContext(WebStartupCache);
  const initialSnapshot = useRef(
    IS_WEB && queryCache?.getQueryData(WEB_STARTUP_CACHE_KEY) === true,
  ).current;
  useEffect(() => {
    if (initialSnapshot)
      queryCache?.removeQueries({ queryKey: WEB_STARTUP_CACHE_KEY, exact: true });
  }, [initialSnapshot, queryCache]);
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
  useEffect(() => {
    advanceStartup(nativeOk ? 'account' : 'environment');
  }, [nativeOk]);

  const desktopStartup = trpc.bootstrap.desktopStartup.useQuery(undefined, {
    enabled: !IS_WEB && nativeOk && homeStage === 'booting',
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Infinity,
  });

  const currentAccount = trpc.bootstrap.currentAccount.useQuery(undefined, {
    enabled: nativeOk && homeStage === 'booting' && (IS_WEB || desktopStartup.isSuccess),
    staleTime: initialSnapshot ? 30_000 : 0,
    refetchOnMount: initialSnapshot ? false : 'always',
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
    staleTime: initialSnapshot ? 30_000 : 0,
    refetchOnMount: initialSnapshot ? false : 'always',
  });
  const autoTarget = trpc.bootstrap.getAutoEnter.useQuery(
    { startup: !IS_WEB },
    {
      enabled: needsStartup && IS_WEB,
      refetchOnWindowFocus: false,
    },
  );
  // Remote 的新页面是手机端的一次启动，不受电脑进程的启动快照约束。
  const webSettings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: IS_WEB && nativeOk && homeStage === 'booting',
    staleTime: initialSnapshot ? 30_000 : 0,
    refetchOnMount: initialSnapshot ? false : 'always',
    refetchOnWindowFocus: false,
    retry: false,
  });
  const requestedStartupPage = webSettings.data?.startupPage;

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
      if (!IS_WEB) {
        if (desktopStartup.isError) {
          booted.current = true;
          setHomeStage('home');
          showError('读取启动状态失败', errMsg(desktopStartup.error));
          return;
        }
        if (!desktopStartup.isSuccess) return;
      }
      if (currentAccount.isError) {
        booted.current = true;
        setHomeStage('home');
        showError('读取当前账号失败', errMsg(currentAccount.error));
        return;
      }
      if (!currentAccount.isSuccess) return;
      if (IS_WEB) {
        if (!webSettings.isFetched) return;
        if (webSettings.isError) {
          booted.current = true;
          setHomeStage('home');
          showError('读取启动设置失败', errMsg(webSettings.error));
          return;
        }
      }
      if (currentAccount.data) {
        // 只接回实际账号，不重开数据库或切号；桌面重载保留现场，Web 新页面应用启动设置。
        booted.current = true;
        const uin = currentAccount.data.uin;
        void (async () => {
          advanceStartup('identity');
          if (!initialSnapshot || utils.account.getAccountConfig.getData()?.uin !== uin)
            await utils.account.getAccountConfig.fetch();
          // Web 只等待挂载必需配置，身份与会话列表在工作区内异步读取。
          if (!IS_WEB) {
            setWindowLayout('chat');
            await runDesktopStartupWarmup(utils, (progress) => {
              setWarmup(progress);
              advanceStartup('identity', progress.done / Math.max(1, progress.total));
            });
          }
          const page = IS_WEB ? requestedStartupPage : desktopStartup.data?.page;
          if (IS_WEB || page)
            useViewState.setState({
              startupPage: page === 'home' || page === 'messages' ? page : null,
            });
          setOpenedUin(uin);
          advanceStartup('workspace');
          goTo('main');
          setHomeStage('home');
        })().catch((error: unknown) => {
          setWarmup(null);
          setHomeStage('home');
          showError('恢复工作区失败', errMsg(error));
        });
        return;
      }
      if (!IS_WEB) {
        // 后台已完成本轮自动进入；未打开或失败都回首页，不由界面再试一次。
        booted.current = true;
        setHomeStage('home');
        if (desktopStartup.data?.error) showError('自动进入失败', desktopStartup.data.error);
        return;
      }
    }
    if (!nativeOk || !autoTarget.isFetched || !configs.isFetched) return;
    if (IS_MAC && !dataAccess.isFetched) return;
    booted.current = true;
    useViewState.setState({
      startupPage:
        requestedStartupPage === 'home' || requestedStartupPage === 'messages'
          ? requestedStartupPage
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
        // Web 自动进入不预热全量目录，工作区内按需加载。
        setWindowLayout('chat');

        // Land on 'home' so closing the account later returns to the landing
        // screen rather than re-running the (now consumed) boot splash.
        setHomeStage('home');
        setOpenedUin(cfg.uin);
        advanceStartup('workspace');
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
    desktopStartup.isSuccess,
    desktopStartup.isError,
    desktopStartup.error,
    desktopStartup.data,
    currentAccount.isSuccess,
    currentAccount.isError,
    currentAccount.error,
    currentAccount.data,
    autoTarget.isFetched,
    autoTarget.data,
    requestedStartupPage,
    webSettings.isFetched,
    webSettings.isError,
    webSettings.error,
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
    initialSnapshot,
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
            <Suspense fallback={<WarmupSplash hint="正在加载备份设置" />}>
              <BackupSection />
            </Suspense>
          </div>
        </BootstrapShell>
      );
    return (
      <BootstrapShell ready>
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
        <WarmupSplash
          progress={warmup}
          hint={
            !nativeOk
              ? '正在检查启动环境'
              : !IS_WEB && !desktopStartup.isSuccess
                ? '正在打开账号'
                : '正在准备工作区'
          }
        />
      </BootstrapShell>
    );
  }

  if (!install.data) {
    return (
      <BootstrapShell>
        <WarmupSplash hint="正在加载账号列表" />
      </BootstrapShell>
    );
  }

  return (
    <BootstrapShell ready showWindowActions={false}>
      <SelectScreen install={install.data} />
    </BootstrapShell>
  );
}

export function BootstrapShell({
  children,
  showWindowActions = true,
  ready = false,
}: {
  children: ReactNode;
  showWindowActions?: boolean;
  ready?: boolean;
}): ReactElement {
  return (
    <main
      className="weq-home-shell h-screen overflow-hidden font-sans text-foreground"
      data-weq-startup-surface={ready || undefined}
    >
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
