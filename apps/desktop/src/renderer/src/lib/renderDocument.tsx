import { createContext, useContext } from 'react';
export const USER_ACTIVITY_EVENT = 'weq:user-activity';

/** 独立工作窗复用主 React 树，但浮层与键盘事件必须留在各自文档。 */
export const RenderDocumentContext = createContext<Document | null>(null);
export function useRenderDocument(): Document {
  return useContext(RenderDocumentContext) ?? document;
}

/** about:blank 子窗的资源不能依赖晚于首帧写入的 base 元素。 */
export function resourceForRenderDocument(source: string, ownerDocument: Document): string {
  if (ownerDocument === document) return source;
  try {
    return new URL(source, document.baseURI).href;
  } catch {
    return source;
  }
}
