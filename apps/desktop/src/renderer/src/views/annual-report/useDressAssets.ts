/**
 * 装扮页的资源预热 —— 只解析当前卡片实际展示的气泡、字体与挂件。
 *
 * 一次 `annualReport.prefetchDress` 批量解析（主进程复用 msgDecoration 的三条链，
 * 同 itemId 全局只解一次），拿到结果后：
 *  - 气泡：直接把 BubbleSkin 交给 {@link DressBubble} 内联渲染；
 *  - 字体：逐款注册 FontFace，成功的才进 `fonts` 集合（页面据此决定写样张还是退回默认）；
 *  - 挂件：动画款注入逐帧 keyframes，静态款留 URL。
 *
 * **全程静默**：任何一款拿不到就在结果里缺席，页面自然缺席那一项。年度报告不弹
 * 「需要在线实例」——那类提示属于装扮商城页。
 *
 * 页面活动时取得渲染资源，离开时释放；报告数据的后台预取不持有字体或解码帧。
 */

import { useEffect, useState } from 'react';
import type { BubbleSkin, DressPageData, ResolvedWidget } from '@weq/service';
import { client } from '../../trpc/client';
import { injectReportPendantCss } from './reportPendant';
import { acquireReportFontFace } from './reportFont';

export type DressAssets = {
  bubbles: Map<number, BubbleSkin>;
  /** ttf 成功注册进 document.fonts 的那些 itemId。 */
  fonts: Set<number>;
  widgets: Map<number, ResolvedWidget>;
  /** 预热是否已经跑完（成功或放弃）。页面用它决定要不要显示骨架。 */
  ready: boolean;
};

const EMPTY: DressAssets = {
  bubbles: new Map(),
  fonts: new Set(),
  widgets: new Map(),
  ready: false,
};

/** 每类最多展示五件单品，另外加上主角身上穿的一套。 */
export const DRESS_CASE_ITEMS = 5;

export function useDressAssets(data: DressPageData | null, active: boolean): DressAssets {
  const [assets, setAssets] = useState<DressAssets>(EMPTY);

  useEffect(() => {
    if (!data || !active) return;
    let cancelled = false;
    const releases: (() => void)[] = [];
    const hero = data.outfits[0];
    const visibleIds = (kind: 'bubble' | 'font' | 'widget', heroId: number | undefined) =>
      [
        ...new Set([
          heroId ?? 0,
          ...data[kind].items.slice(0, DRESS_CASE_ITEMS).map((item) => item.itemId),
        ]),
      ].filter((id) => id > 0);

    void (async () => {
      let resolved: Awaited<ReturnType<typeof client.account.annualReport.prefetchDress.mutate>>;
      try {
        resolved = await client.account.annualReport.prefetchDress.mutate({
          bubbles: visibleIds('bubble', hero?.bubbleId),
          fonts: visibleIds('font', hero?.fontId),
          widgets: visibleIds('widget', hero?.widgetId),
        });
      } catch {
        // 整批失败（没有打开的账号会话等）——页面全部走退化版，不提示。
        if (!cancelled) setAssets({ ...EMPTY, ready: true });
        return;
      }
      if (cancelled) return;

      const bubbles = new Map<number, BubbleSkin>();
      for (const [id, skin] of Object.entries(resolved.bubbles)) {
        if (skin) bubbles.set(Number(id), skin as BubbleSkin);
      }

      const widgets = new Map<number, ResolvedWidget>();
      for (const [id, widget] of Object.entries(resolved.widgets)) {
        if (!widget) continue;
        const value = widget as ResolvedWidget;
        widgets.set(Number(id), value);
        // 动画款的 @keyframes 注给报告自己的挂件元素（聊天侧那份按 .message-line
        // 选中，选择器对不上，见 reportPendant.ts）。同 itemId 只注一次。
        releases.push(injectReportPendantCss(value));
      }

      // 字体的 ttf 已在主进程落盘，这里只负责把 face 注册进 document.fonts；
      // 注册失败（OTS 拒了 / 文件坏）的款不进集合，页面退回默认字形而不是错字形。
      const fontIdsResolved = Object.keys(resolved.fonts).map(Number);
      const okFlags = await Promise.all(
        fontIdsResolved.map((id) => {
          const font = acquireReportFontFace(id);
          releases.push(font.release);
          return font.ready;
        }),
      );
      if (cancelled) return;
      const fonts = new Set<number>(fontIdsResolved.filter((_, index) => okFlags[index]));

      setAssets({ bubbles, fonts, widgets, ready: true });
    })();

    return () => {
      cancelled = true;
      for (const release of releases) release();
    };
  }, [data, active]);

  return assets;
}
