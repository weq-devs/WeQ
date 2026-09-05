import { createContext, useContext } from 'react';
import type { ExportSlide } from './exportHtml';

/**
 * 报告播放期的共享上下文：页面组件据此决定文案（历史以来 / xxx 年）、
 * 导出入口拿全部已加载页面的数据。entry 阶段不提供。
 */
export type ReportViewContextValue = {
  year: number;
  /** 最早有消息的年份 —— year === startYear 时文案用「历史以来」。 */
  startYear: number;
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
