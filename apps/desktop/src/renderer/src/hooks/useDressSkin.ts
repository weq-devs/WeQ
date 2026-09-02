/**
 * 全局装扮注入。
 *
 * 之前样式只在 DressUpView 挂载时才注入,于是「不打开装扮页气泡就不显示」—— 这里把
 * 读清单 + 注入提到 MainView 层,进主界面就生效。装扮页只负责改清单,改完
 * invalidate `dressup.getState`,同一份 query 让这个 hook 重新注入。
 */

import { useEffect } from 'react';
import type { DressManifest, ResolvedWidget } from '@weq/service';
import { trpc } from '../trpc/client';
import { applyDressSkin, applyDressSkinPreloaded } from '../lib/dressSkin';
import { dressBackgroundUrl, dressFontUrl, dressUrl } from '../lib/resourceUrl';

/**
 * 从清单里挑出生效的挂件,翻成渲染要的形状(与 service 的 ResolvedWidget 同构)。
 *
 * 挂件是安装时下载好的逐帧动画,帧数/时间轴就在清单条目里 —— 不需要再发一次
 * resolveMsgDecoration 查询,拼 `dressPendantFrameUrl` 就能播。清单里条目缺失
 * (缓存被清等)时返回 null,调用方回退到 QQ 自己的静态挂件。
 */
export function activeWidgetFromManifest(manifest: DressManifest): ResolvedWidget | null {
  const w = manifest.widgets.find((x) => x.itemId === manifest.activeWidget);
  if (!w?.frameCount) return null;
  return {
    animated: true,
    itemId: w.itemId,
    frameCount: w.frameCount,
    frameTimeMs: w.frameTimeMs,
    repeat: w.repeat,
  };
}

/** 从清单里挑出生效的那两款,翻成注入层要的形状。 */
function activeSkins(manifest: DressManifest) {
  const bubble = manifest.bubbles.find((b) => b.itemId === manifest.activeBubble) ?? null;
  const font = manifest.fonts.find((f) => f.itemId === manifest.activeFont) ?? null;
  return {
    bubble: bubble
      ? {
          itemId: bubble.itemId,
          slice: bubble.slice,
          imageSize: bubble.imageSize,
          textColor: bubble.textColor,
          staticUrl: bubble.staticUrl,
          localFile: bubble.localFile,
          animationUrl: bubble.animationUrl,
          animationFrameCount: bubble.animationFrameCount,
          animationFrameTimeMs: bubble.animationFrameTimeMs,
          animationRepeat: bubble.animationRepeat,
        }
      : null,
    font: font ? { itemId: font.itemId, fontUrl: dressFontUrl(font.itemId) } : null,
  };
}

/** 把清单里生效的那几款翻成 CSS 并注入(同步,不等资源)。 */
export function syncDressSkin(manifest: DressManifest | undefined): void {
  if (!manifest) return;
  const { bubble, font } = activeSkins(manifest);
  applyDressSkin(bubble, font, activeWidgetFromManifest(manifest), manifest.scope);
}

/**
 * 同上,但先把图片 / 字体 / 挂件帧拉齐再注入。
 *
 * 切换装扮时用这条:调用方 await 它,加载态就能盖住「资源到齐」为止的全过程,
 * 而不是在样式注入前就收工、把重排甩给用户看(见 lib/dressSkin 的说明)。
 */
export function syncDressSkinPreloaded(manifest: DressManifest | undefined): Promise<void> {
  if (!manifest) return Promise.resolve();
  const { bubble, font } = activeSkins(manifest);
  return applyDressSkinPreloaded(bubble, font, activeWidgetFromManifest(manifest), manifest.scope);
}

/** 进主界面就读清单并注入。装扮页共用同一份 query,所以两边不会重复请求。 */
export function useDressSkin(): void {
  const utils = trpc.useUtils();
  const state = trpc.account.dressup.getState.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const manifest = state.data?.manifest;

  // 开机同步(把手机 QQ 正在用的那两款装上)是网络往返,必然比首屏这次查询晚几秒。
  // 不听这个推送的话,界面会拿着空清单一直等到 staleTime 过期 —— 表现为「已装 0」
  // 且聊天页没气泡,而清单其实早就写好了。
  trpc.account.dressup.onChanged.useSubscription(undefined, {
    onData: () => {
      void utils.account.dressup.getState.invalidate();
    },
  });

  useEffect(() => {
    syncDressSkin(manifest);
  }, [manifest]);
}

/**
 * 聊天背景 + 浮屏挂件的当前选择。
 *
 * 与 {@link useDressSkin} 共用同一份 query(react-query 会去重),所以多处调用不会
 * 多打接口。背景走 DOM 而不是注入 CSS —— 它需要一个真实的层来叠挂件动画。
 */
export function useChatBackdrop(): { imageUrl: string; widgetId: string; opacity: number } {
  const state = trpc.account.dressup.getState.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const manifest = state.data?.manifest;
  const source = manifest?.background ?? 'none';

  let imageUrl = '';
  if (source === 'qq') {
    // QQ 同款走 CDN 代理(主进程落盘缓存),不占本地空间,换了手机上的背景这边跟着变。
    imageUrl = dressUrl(state.data?.own.chatBgUrl ?? '');
  } else if (source === 'custom' && manifest?.backgroundFile) {
    // 文件名固定,所以拿路径当 stamp 穿透浏览器缓存(见 dressBackgroundUrl)。
    imageUrl = dressBackgroundUrl(manifest.backgroundFile);
  }

  return {
    imageUrl,
    widgetId: manifest?.widgetId ?? '',
    opacity: manifest?.backgroundOpacity ?? 1,
  };
}
