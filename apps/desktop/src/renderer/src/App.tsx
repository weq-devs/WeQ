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
import { ImageLightbox } from './components/ImageLightbox';
import { VideoLightbox } from './components/VideoLightbox';
import { MarketFaceLightbox } from './components/MarketFaceLightbox';
import { ForwardWindowHost } from './components/ForwardWindow';
import { AppLockOverlay } from './components/AppLockOverlay';
import { TextMarkdownContext } from './components/QqMessageContent';
import { trpc } from './trpc/client';
import { setWindowLayout } from './lib/windowLayout';
import { ensureThemeInitialized } from './state/theme';
import { usePrivacyStore } from './state/privacy';

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

export default function App(): ReactElement {
  const view = useViewState((s) => s.view);
  const openedUin = useViewState((s) => s.openedUin);

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
  return (
    <TextMarkdownProvider>
      {view === 'bootstrap' ? <BootstrapView /> : <MainView key={openedUin ?? ''} />}
      {/* 首次进入账号后弹出的欢迎说明框（自身决定是否显示）。 */}
      {view === 'main' ? <WelcomeDialog /> : null}
      <DialogHost />
      <ToastHost />
      <CloseConfirmDialog />
      <AppLockOverlay />
      <ImageLightbox />
      <VideoLightbox />
      <MarketFaceLightbox />
      <ForwardWindowHost />
    </TextMarkdownProvider>
  );
}
