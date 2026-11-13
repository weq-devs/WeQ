import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupResourceNavigation } from '../src/renderer/src/components/GroupResourceNavigation';
import { RenderDocumentContext } from '../src/renderer/src/lib/renderDocument';
import {
  mobileBack,
  resetMobileRoot,
  useMobileBack,
} from '../src/renderer/src/hooks/useMobileNavigation';

vi.mock('../src/renderer/src/lib/responsiveLayout', () => ({
  isSingleColumnLayout: () => true,
  isMobileClient: () => true,
}));
afterEach(() => {
  resetMobileRoot();
  vi.unstubAllGlobals();
});
it('统一资源导航显示当前目录并把返回交给本窗口', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const back = vi.fn(),
    select = vi.fn();
  try {
    act(() =>
      root.render(
        h(GroupResourceNavigation, {
          label: '群文件目录',
          items: [
            { id: '/', name: '全部文件' },
            { id: 'folder', name: '资料' },
          ],
          onBack: back,
          onSelect: select,
        }),
      ),
    );
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('资料');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="返回上级目录"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('.group-file-crumb')!.click());
    expect(back).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith(0);
  } finally {
    act(() => root.unmount());
  }
});
it('工具窗的返回动作不注册到主窗口移动导航', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const popup = new HappyWindow();
  const root = createRoot(document.createElement('div'));
  const back = vi.fn();
  function Page() {
    useMobileBack(true, back);
    return null;
  }
  try {
    act(() =>
      root.render(
        h(
          RenderDocumentContext.Provider,
          { value: popup.document as unknown as Document },
          h(Page),
        ),
      ),
    );
    expect(mobileBack()).toBe(false);
    expect(back).not.toHaveBeenCalled();
    act(() => root.render(h(RenderDocumentContext.Provider, { value: document }, h(Page))));
    expect(mobileBack()).toBe(true);
    expect(back).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    popup.close();
  }
});
