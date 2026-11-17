import type { ReactNode } from 'react';
import { ContactFieldHistoryContext } from './contactFieldHistoryContext.shared';

/** 弹窗里的其他对象不继承宿主资料的历史；完整资料页可显式建立自己的上下文。 */
export function ContactFieldHistoryBoundary({ children }: { children: ReactNode }) {
  return (
    <ContactFieldHistoryContext.Provider value={null}>
      {children}
    </ContactFieldHistoryContext.Provider>
  );
}
