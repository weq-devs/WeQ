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
 *   4. Stage routing — booting → splash, home → landing, select → two-pane.
 */

import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { Loader2, X } from 'lucide-react';
import { trpc, client } from '../trpc/client';
import { useViewState } from '../state/view';
import { useDialog } from '../components/Dialog';
import { HomeScreen } from './bootstrap/HomeScreen';
import { SelectScreen } from './bootstrap/SelectScreen';
import logoUrl from '@resources/brand/logo.png';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function BootstrapView(): ReactElement {
  const homeStage = useViewState((s) => s.homeStage);
  const setHomeStage = useViewState((s) => s.setHomeStage);
  const enterSelect = useViewState((s) => s.enterSelect);
  const goTo = useViewState((s) => s.goTo);
  const setOpenedUin = useViewState((s) => s.setOpenedUin);
  const showError = useDialog((s) => s.showError);

  const nativeStatus = trpc.bootstrap.nativeStatus.useQuery(undefined, { refetchOnWindowFocus: false });
  const nativeErr = nativeStatus.data ?? null;
  const nativeOk = nativeStatus.isSuccess && nativeStatus.data === null;

  const install = trpc.bootstrap.describeInstall.useQuery(undefined, {
    enabled: nativeOk,
    refetchOnWindowFocus: false,
  });
  const configs = trpc.bootstrap.listAccountConfigs.useQuery(undefined, {
    enabled: nativeOk,
    refetchOnWindowFocus: false,
  });
  const autoTarget = trpc.bootstrap.getAutoEnter.useQuery(undefined, {
    enabled: nativeOk,
    refetchOnWindowFocus: false,
  });

  // ---- native-init error dialog (blocking) ----
  useEffect(() => {
    if (!nativeErr) return;
    if (nativeErr.kind === 'expired') {
      showError('版本过旧', '本地组件版本过旧，请更新到最新版本后再使用。', { dismissible: false });
    } else {
      showError('安装损坏', 'QQ 助手组件已损坏或被篡改，请重新安装或更新后重试。', { dismissible: false });
    }
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
    if (!nativeOk || !autoTarget.isFetched || !configs.isFetched) return;
    booted.current = true;

    const target = autoTarget.data ?? null;
    const cfg = target ? (configs.data ?? []).find((c) => c.configId === target.configId) : null;
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
              displayName: cfg.displayName ?? '',
              avatarUrl: cfg.avatarUrl ?? '',
            },
            ...(cfg.dbKey ? { dbKey: cfg.dbKey } : {}),
            ...(cfg.algo?.pageHmacAlgorithm ? { algo: cfg.algo } : {}),
          });
        } else {
          const test = await client.bootstrap.testDatabaseKey.mutate({ uin: cfg.uin, dbKey: cfg.dbKey });
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
        // Land on 'home' so closing the account later returns to the landing
        // screen rather than re-running the (now consumed) boot splash.
        setHomeStage('home');
        setOpenedUin(cfg.uin);
        goTo('main');
      } catch (e) {
        setHomeStage('home');
        showError('自动进入失败', errMsg(e));
      }
    })();
  }, [
    homeStage,
    nativeOk,
    nativeErr,
    autoTarget.isFetched,
    autoTarget.data,
    configs.isFetched,
    configs.data,
    setHomeStage,
    setOpenedUin,
    goTo,
    showError,
  ]);

  // ---- render ----
  if (nativeErr) {
    return (
      <Shell>
        <Centered>
          <img src={logoUrl} alt="" width={84} height={84} className="opacity-40 grayscale" />
          <p className="mt-4 text-[14px] text-[#5b6b7d]">
            {nativeErr.kind === 'expired' ? '组件版本过旧，请更新。' : '组件安装损坏，请重新安装。'}
          </p>
        </Centered>
      </Shell>
    );
  }

  if (homeStage === 'booting' || nativeStatus.isLoading) {
    return (
      <Shell>
        <Splash />
      </Shell>
    );
  }

  if (homeStage === 'select') {
    if (!install.data) {
      return (
        <Shell>
          <Splash />
        </Shell>
      );
    }
    return (
      <Shell>
        <SelectScreen install={install.data} />
      </Shell>
    );
  }

  return (
    <Shell>
      <HomeScreen
        hasConfigs={(configs.data?.length ?? 0) > 0}
        onExisting={() => enterSelect('existing')}
        onNew={() => enterSelect('new')}
      />
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }): ReactElement {
  return (
    <main className="weq-home-shell h-screen overflow-hidden font-sans text-[#142235]">
      <button
        type="button"
        className="weq-shell-close-btn absolute right-4 top-4 z-20 flex h-8 w-8 items-center justify-center rounded-full text-[#7a8b9e] transition-colors hover:bg-black/5 hover:text-[#142235]"
        onClick={() => window.close()}
        aria-label="关闭"
      >
        <X size={18} strokeWidth={1.8} />
      </button>
      <div className="relative z-10 h-full">{children}</div>
    </main>
  );
}

function Centered({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex h-full flex-col items-center justify-center">{children}</div>;
}

function Splash(): ReactElement {
  return (
    <Centered>
      <img src={logoUrl} alt="WeQ" width={80} height={80} className="weq-splash-logo" />
      <div className="mt-5 flex items-center gap-2 text-[13px] text-[#3c5368]">
        <Loader2 className="animate-spin text-[#0099ff]" size={15} strokeWidth={1.85} aria-hidden />
        正在初始化…
      </div>
    </Centered>
  );
}
