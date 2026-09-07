import { createContext, useContext } from 'react';
import type { ExportSlide } from './exportHtml';

/**
 * 报告播放期的共享上下文：导出入口拿全部已加载页面的数据，装扮页拿「主字体」的
 * 当前值与切换入口。entry 阶段不提供。
 *
 * 刻意不再带 `startYear`：口径文案（历史以来 / xxxx 年）现在完全由 `year`
 * 自证 —— `ALL_TIME_YEAR` 就是「历史以来」，不用再和「最早有记录的年份」
 * 比较。少一个必须在四种产物之间保持同步的参数。
 */
export type ReportViewContextValue = {
  year: number;
  scopeLabel: string;
  /** 已加载成功的页面（含数据），供结尾页拼装导出产物。 */
  slides: ExportSlide[];
  /**
   * 当前的报告主字体 itemId（0 = 用默认排印）。由装扮页设置，作用于**整份报告**
   * ——包括已经翻过的总览页和之后加入的任何一页。
   */
  reportFontId: number;
  /** 换主字体。传 null / 0 还原默认。加载失败时静默不换（见 reportFont.ts）。 */
  setReportFontId: (itemId: number | null) => void;
  /**
   * 注册「翻页守卫」—— 让当前页在翻页真正发生前吃掉这一次手势。
   *
   * 目前没有任何页面使用它；留给需要「先展开内层、再翻页」的交互页（例如未来的
   * 详情抽屉）。返回 `true` = 这次手势页面处理了，舞台不要翻页。
   *
   * 只有**当前页**该注册（守卫会挡住所有翻页输入：滚轮、键盘、触摸、刻度点击除外）。
   * 页面翻走时用返回的 dispose 注销，否则后一页会被前一页的守卫挡住。
   */
  registerPageGuard: (guard: PageTurnGuard) => () => void;
};

/**
 * 翻页守卫。`direction` = 1 向下（下一页）、-1 向上（上一页）。
 * 返回 true 表示这一次翻页被页面自己消费掉了。
 */
export type PageTurnGuard = (direction: 1 | -1) => boolean;

export const ReportViewContext = createContext<ReportViewContextValue | null>(null);

export function useReportView(): ReportViewContextValue {
  const value = useContext(ReportViewContext);
  if (!value) {
    throw new Error('useReportView must be used inside the report deck');
  }
  return value;
}
