/**
 * 全局装扮注入。
 *
 * 之前样式只在 DressUpView 挂载时才注入,于是「不打开装扮页气泡就不显示」—— 这里把
 * 读清单 + 注入提到 MainView 层,进主界面就生效。装扮页只负责改清单,改完
 * invalidate `dressup.getState`,同一份 query 让这个 hook 重新注入。
 */

import { useEffect } from 'react';
import type { DressManifest } from '@weq/service';
import { trpc } from '../trpc/client';
import { applyDressSkin } from '../lib/dressSkin';
import { dressFontUrl } from '../lib/resourceUrl';

/** 把清单里生效的那两款翻成 CSS 并注入。 */
export function syncDressSkin(manifest: DressManifest | undefined): void {
  if (!manifest) return;
  const bubble = manifest.bubbles.find((b) => b.itemId === manifest.activeBubble) ?? null;
  const font = manifest.fonts.find((f) => f.itemId === manifest.activeFont) ?? null;
  applyDressSkin(
    bubble
      ? {
          itemId: bubble.itemId,
          slice: bubble.slice,
          imageSize: bubble.imageSize,
          textColor: bubble.textColor,
          staticUrl: bubble.staticUrl,
          localFile: bubble.localFile,
          animationUrl: bubble.animationUrl,
        }
      : null,
    font ? { itemId: font.itemId, fontUrl: dressFontUrl(font.itemId) } : null,
    manifest.scope,
  );
}

/** 进主界面就读清单并注入。装扮页共用同一份 query,所以两边不会重复请求。 */
export function useDressSkin(): void {
  const state = trpc.account.dressup.getState.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const manifest = state.data?.manifest;

  useEffect(() => {
    syncDressSkin(manifest);
  }, [manifest]);
}
