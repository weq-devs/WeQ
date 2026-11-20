import { createContext } from 'react';

export interface MailOpenTarget {
  id: string;
  folderId?: number;
  revision: string;
}

export const MailCardNavigationContext = createContext<((id: string) => void) | null>(null);

/** QQ 邮箱提醒有网页登录和 QQ 授权码登录两种详情入口。 */
export function mailCardId(jump: string): string | null {
  try {
    const url = new URL(jump);
    if (url.origin !== 'https://wx.mail.qq.com' || url.username || url.password) return null;
    const params = url.searchParams;
    const web =
      url.pathname === '/list/readtemplate' && params.get('name') === 'qq_login_jump.html';
    const qq = url.pathname === '/login/login' && params.get('qq_target') === 'clientreadmail';
    if (!web && !qq) return null;
    const ids = params.getAll('mailid');
    const [id] = ids;
    return ids.length === 1 && id && /^[!-~]{1,2048}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
