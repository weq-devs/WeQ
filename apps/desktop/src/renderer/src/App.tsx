/**
 * 顶层视图切换。
 *
 * 当前只有首页和主界面两个活动视图，使用 zustand 保存当前视图即可。
 */

import type { ReactElement } from 'react';
import { useViewState } from './state/view';
import { BootstrapView } from './views/BootstrapView';
import { MainView } from './views/MainView';

export default function App(): ReactElement {
  const view = useViewState((s) => s.view);
  if (view === 'bootstrap') return <BootstrapView />;
  return <MainView />;
}
