/**
 * 顶层视图切换 + 全局弹窗宿主。
 *
 * 当前只有首页和主界面两个活动视图，使用 zustand 保存当前视图。
 * `DialogHost` 常驻挂载，承载全局错误/确认弹窗（替代原生 alert/confirm）。
 */

import { useEffect, type ReactElement } from 'react';
import { useViewState } from './state/view';
import { BootstrapView } from './views/BootstrapView';
import { MainView } from './views/MainView';
import { DialogHost } from './components/Dialog';
import { ImageLightbox } from './components/ImageLightbox';
import { ForwardWindowHost } from './components/ForwardWindow';
import { setWindowLayout } from './lib/windowLayout';

export default function App(): ReactElement {
  const view = useViewState((s) => s.view);
  const openedUin = useViewState((s) => s.openedUin);

  useEffect(() => {
    setWindowLayout(view === 'main' ? 'chat' : 'home');
  }, [view]);

  // Key MainView by openedUin so account switches (without going through
  // bootstrap) force a remount — drops the old onDbChanged subscription and
  // rebinds against the new account.
  return (
    <>
      {view === 'bootstrap' ? <BootstrapView /> : <MainView key={openedUin ?? ''} />}
      <DialogHost />
      <ImageLightbox />
      <ForwardWindowHost />
    </>
  );
}
