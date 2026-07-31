/**
 * 顶层视图切换 + 全局弹窗宿主。
 *
 * 当前只有首页和主界面两个活动视图，使用 zustand 保存当前视图。
 * `DialogHost` 常驻挂载，承载全局错误/确认弹窗（替代原生 alert/confirm）。
 */

import { useEffect, type ReactElement, type ReactNode } from 'react';
import { useViewState } from './state/view';
import { BootstrapView } from './views/BootstrapView';
import { MainView } from './views/MainView';
import { DialogHost } from './components/Dialog';
import { ToastHost } from './components/Toast';
import { WelcomeDialog } from './components/WelcomeDialog';
import { CloseConfirmDialog } from './components/CloseConfirmDialog';
import { DesktopOnly } from './lib/target';
import { ImageLightbox } from './components/ImageLightbox';
import { VideoLightbox } from './components/VideoLightbox';
import { MarketFaceLightbox } from './components/MarketFaceLightbox';
import { ForwardWindowHost } from './components/ForwardWindow';
import { AppLockOverlay } from './components/AppLockOverlay';
import { TextMarkdownContext } from './components/QqMessageContent';
import { SelfPendantContext } from './hooks/useSelfPendant';
import { WarmupSplash } from './components/WarmupSplash';
import { trpc } from './trpc/client';
import { dressUrl } from './lib/resourceUrl';
import { setWindowLayout } from './lib/windowLayout';
import { ensureThemeInitialized } from './state/theme';
import { usePrivacyStore } from './state/privacy';
import { useAccountSwitch } from './state/accountSwitch';

/**
 * 把「纯文本消息渲染 Markdown」开关广播给所有消息气泡。
 *
 * 查询只在这一层做一次——QqMessageContent 每条消息一个实例，让它们各自 useQuery 会挂
 * 几百个订阅。必须包住 ForwardWindowHost（它在 MainView 之外，转发窗口里的气泡同样
 * 复用 QqMessageContent）。`?? true` 与 DEFAULT_APP_SETTINGS 一致，settings 还在加载时
 * 不会先闪成关再跳开。
 */
function TextMarkdownProvider({ children }: { children: ReactNode }): ReactElement {
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  return (
    <TextMarkdownContext.Provider value={settings.data?.renderTextMarkdown ?? true}>
      {children}
    </TextMarkdownContext.Provider>
  );
}

/**
 * 把「自己头像的挂件」广播给所有气泡。理由同上——每条消息一个 Avatar，不能各自订阅。
 *
 * `accountOpen` 为假时不查 getHomeDress：那个 procedure 要求已打开账号，在首页
 * （bootstrap 视图）调用会抛错。
 */
function SelfPendantProvider({
  accountOpen,
  children,
}: {
  accountOpen: boolean;
  children: ReactNode;
}): ReactElement {
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const dress = trpc.account.getHomeDress.useQuery(undefined, {
    enabled: accountOpen,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const enabled = settings.data?.showAvatarPendant ?? true;
  const url = enabled ? dressUrl(dress.data?.widgetUrl ?? '') : '';
  return <SelfPendantContext.Provider value={url}>{children}</SelfPendantContext.Provider>;
}

export default function App(): ReactElement {
  const view = useViewState((s) => s.view);
  const openedUin = useViewState((s) => s.openedUin);
  const switching = useAccountSwitch((s) => s.active);
  const switchHint = useAccountSwitch((s) => s.hint);
  const switchProgress = useAccountSwitch((s) => s.progress);

  useEffect(() => {
    setWindowLayout(view === 'main' ? 'chat' : 'home');
  }, [view]);

  useEffect(() => {
    ensureThemeInitialized();
    // 隐私模式：从 localStorage 回填根属性，早于首帧避免闪明文。
    usePrivacyStore.getState().hydrate();
  }, []);

  // Key MainView by openedUin so account switches (without going through
  // bootstrap) force a remount — drops the old onDbChanged subscription and
  // rebinds against the new account.
  //
  // 切号过渡期间整棵 MainView 都不挂载，换成载入页：既盖住「空白头像 + 默认
  // 昵称」的粗糙首屏，也避免 openedUin 短暂变 null 时白挂载一次（那次的查询
  // 全打在已关闭的账号上）。
  return (
    <TextMarkdownProvider>
      <SelfPendantProvider accountOpen={view === 'main' && !switching}>
        {switching ? (
          <main className="weq-home-shell h-screen overflow-hidden font-sans text-[#142235]">
            <WarmupSplash progress={switchProgress} hint={switchHint} />
          </main>
        ) : view === 'bootstrap' ? (
          <BootstrapView />
        ) : (
          <MainView key={openedUin ?? ''} />
        )}
        {/* 首次进入账号后弹出的欢迎说明框（自身决定是否显示）。 */}
        {view === 'main' ? <WelcomeDialog /> : null}
        <DialogHost />
        <ToastHost />
        <DesktopOnly>
          <CloseConfirmDialog />
        </DesktopOnly>
        <DesktopOnly>
          <AppLockOverlay />
        </DesktopOnly>
        <ImageLightbox />
        <VideoLightbox />
        <MarketFaceLightbox />
        <ForwardWindowHost />
      </SelfPendantProvider>
    </TextMarkdownProvider>
  );
}
