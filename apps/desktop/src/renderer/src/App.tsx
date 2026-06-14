/**
 * 顶层视图切换 + 全局弹窗宿主。
 *
 * 当前只有首页和主界面两个活动视图，使用 zustand 保存当前视图。
 * `DialogHost` 常驻挂载，承载全局错误/确认弹窗（替代原生 alert/confirm）。
 */

import type { ReactElement } from 'react';
import { useViewState } from './state/view';
import { BootstrapView } from './views/BootstrapView';
import { MainView } from './views/MainView';
import { DialogHost } from './components/Dialog';

export default function App(): ReactElement {
  const view = useViewState((s) => s.view);
  return (
    <>
      {view === 'bootstrap' ? <BootstrapView /> : <MainView />}
      <DialogHost />
    </>
  );
}
