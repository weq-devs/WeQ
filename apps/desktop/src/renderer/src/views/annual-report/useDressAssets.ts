/**
 * 装扮页的资源预热 —— 把这一页要画的气泡 / 字体 / 挂件全部拉到本地。
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
 * 关键时序：这个 hook 由页面在**数据一到手**时就调用（不等翻到那一页），所以用户
 * 还在看总览页时，第二页的资源已经在下载了。
 */

import { useEffect, useState } from 'react';
import type { BubbleSkin, DressPageData, ResolvedWidget } from '@weq/service';
import { client } from '../../trpc/client';
import { injectReportPendantCss } from './reportPendant';
import { ensureReportFontFace } from './reportFont';

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

/** 每类最多预热多少款 —— 与 IPC 侧的 max(60) 对齐，兜住异常庞大的榜单。 */
const MAX_PER_KIND = 60;

/**
 * 装扮页新增了「单品展柜」：除整套穿的 outfit 外，单类榜前几款也可能不在
 * 截断后的 outfit 列表里。这里多预热前 8 款，让展柜陈列所需的 id 也有资源。
 */
const PREFETCH_CASE_ITEMS = 8;

export function useDressAssets(data: DressPageData | null): DressAssets {
  const [assets, setAssets] = useState<DressAssets>(EMPTY);

  // 要预热的 id 从「套装」与单类榜前几款里并集取出 —— 主体画套装，展柜画单品。
  // 这里只算出三条**字符串**当依赖：id 列表本身每次渲染都是新数组，直接依赖会让
  // 预热在每次重渲时重跑（真正的 id 列表在 effect 内部重新取）。
  const bubbleKey = unique([
    ...(data?.outfits ?? []).map((o) => o.bubbleId),
    ...(data?.bubble.items ?? []).slice(0, PREFETCH_CASE_ITEMS).map((item) => item.itemId),
  ]).join(',');
  const fontKey = unique([
    ...(data?.outfits ?? []).map((o) => o.fontId),
    ...(data?.font.items ?? []).slice(0, PREFETCH_CASE_ITEMS).map((item) => item.itemId),
  ]).join(',');
  const widgetKey = unique([
    ...(data?.outfits ?? []).map((o) => o.widgetId),
    ...(data?.widget.items ?? []).slice(0, PREFETCH_CASE_ITEMS).map((item) => item.itemId),
  ]).join(',');

  useEffect(() => {
    if (!data) return undefined;
    let cancelled = false;
    const bubbleIds = unique([
      ...data.outfits.map((o) => o.bubbleId),
      ...data.bubble.items.slice(0, PREFETCH_CASE_ITEMS).map((item) => item.itemId),
    ]);
    const fontIds = unique([
      ...data.outfits.map((o) => o.fontId),
      ...data.font.items.slice(0, PREFETCH_CASE_ITEMS).map((item) => item.itemId),
    ]);
    const widgetIds = unique([
      ...data.outfits.map((o) => o.widgetId),
      ...data.widget.items.slice(0, PREFETCH_CASE_ITEMS).map((item) => item.itemId),
    ]);

    void (async () => {
      let resolved: Awaited<ReturnType<typeof client.account.annualReport.prefetchDress.mutate>>;
      try {
        resolved = await client.account.annualReport.prefetchDress.mutate({
          bubbles: bubbleIds.slice(0, MAX_PER_KIND),
          fonts: fontIds.slice(0, MAX_PER_KIND),
          widgets: widgetIds.slice(0, MAX_PER_KIND),
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
        injectReportPendantCss(value);
      }

      // 字体的 ttf 已在主进程落盘，这里只负责把 face 注册进 document.fonts；
      // 注册失败（OTS 拒了 / 文件坏）的款不进集合，页面退回默认字形而不是错字形。
      const fontIdsResolved = Object.keys(resolved.fonts).map(Number);
      const okFlags = await Promise.all(fontIdsResolved.map((id) => ensureReportFontFace(id)));
      if (cancelled) return;
      const fonts = new Set<number>(fontIdsResolved.filter((_, index) => okFlags[index]));

      setAssets({ bubbles, fonts, widgets, ready: true });
    })();

    return () => {
      cancelled = true;
    };
    // itemId 列表变了才重新预热；data 对象每次渲染换引用，不能直接依赖它。
  }, [data, bubbleKey, fontKey, widgetKey]);

  return assets;
}

function unique(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => id > 0))];
}
