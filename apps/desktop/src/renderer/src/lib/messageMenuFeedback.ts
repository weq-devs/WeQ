import { createContext } from 'react';

/** 菜单动作结果放在图标网格之外，其他宿主保持原位置。 */
export const MessageMenuFeedbackContext = createContext<HTMLElement | null>(null);
