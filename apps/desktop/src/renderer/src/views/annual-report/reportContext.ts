import { createContext, useContext } from 'react';
import type { ExportSlide } from './exportHtml';

/**
 * 报告播放期的共享上下文：导出入口拿全部已加载页面的数据。entry 阶段不提供。
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
};

export const ReportViewContext = createContext<ReportViewContextValue | null>(null);

export function useReportView(): ReportViewContextValue {
  const value = useContext(ReportViewContext);
  if (!value) {
    throw new Error('useReportView must be used inside the report deck');
  }
  return value;
}
