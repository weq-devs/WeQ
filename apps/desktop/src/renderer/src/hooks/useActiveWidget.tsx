/**
 * 生效的「头像挂件」（个性装扮页选的挂件，appId 4）广播。
 *
 * 与 {@link ./useSelfPendant} 同构：每条消息一个 Avatar 实例，不能各自 useQuery，
 * 所以由 App 根部一个 provider 读 `dressup.getState`（与 useDressSkin / SelfPendant
 * 共用同一份 query 缓存，不重复请求），把生效挂件 + 作用范围广播给所有气泡。
 *
 * 渲染优先级（见 messageBubble 的 PendantOverlay）：
 *   per-message 装饰（40801，发送者自己的 QQ 挂件）> 生效挂件 > 自己的 QQ 静态挂件。
 *
 * 生效挂件永远是「已装」的逐帧动画（frameCount 等时间轴在清单条目里），所以这里
 * 不需要发 resolveMsgDecoration 查询 —— 直接拼 dressPendantFrameUrl 就能播。
 *
 * 同一份清单顺带广播**生效字体的炫彩素材**（`eimg` 帧）：它和挂件一样是「全局生效、
 * 每条消息都要用」的数据，而它多一个条件 —— 挂不挂 `data-fontfx` 要量完气泡尺寸才知道
 * （气泡比动画画布还大就不放，见 lib/dressSkin 的 pickFontFxFariant），所以只能广播给
 * 组件、由组件在量完后自己挂。再查一次 getState 没必要：同一份 query 已经被 react-query
 * 去重了。
 */

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import type { DressScope, ResolvedWidget } from '@weq/service';
import { trpc } from '../trpc/client';
import { activeFontFxFromManifest, activeWidgetFromManifest } from './useDressSkin';
import type { FontFxSkin } from '../lib/dressSkin';

/** 生效挂件 + 作用范围。`widget` 为 null = 没选或清单里已查不到（回退 QQ 自己的挂件）。 */
export interface ActiveWidgetInfo {
  widget: ResolvedWidget | null;
  scope: DressScope;
}

export const ActiveWidgetContext = createContext<ActiveWidgetInfo>({
  widget: null,
  scope: 'mine',
});

export function useActiveWidget(): ActiveWidgetInfo {
  return useContext(ActiveWidgetContext);
}

/**
 * 生效字体的炫彩素材。null = 没选字体、或这款字体没有 `eimg`（绝大多数款如此）。
 */
export const ActiveFontFxContext = createContext<FontFxSkin | null>(null);

export function useActiveFontFx(): FontFxSkin | null {
  return useContext(ActiveFontFxContext);
}

/** 广播生效挂件。必须包住 ForwardWindowHost（转发窗口里的头像同样要叠）。 */
export function ActiveWidgetProvider({ children }: { children: ReactNode }): ReactElement {
  const state = trpc.account.dressup.getState.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const manifest = state.data?.manifest;
  return (
    <ActiveWidgetContext.Provider
      value={{
        widget: manifest ? activeWidgetFromManifest(manifest) : null,
        scope: manifest?.scope ?? 'mine',
      }}
    >
      <ActiveFontFxContext.Provider value={manifest ? activeFontFxFromManifest(manifest) : null}>
        {children}
      </ActiveFontFxContext.Provider>
    </ActiveWidgetContext.Provider>
  );
}
