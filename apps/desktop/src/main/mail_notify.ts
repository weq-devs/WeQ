import { Notification } from 'electron';
import type { MailNotice } from '@weq/service/mail';
import { getAppContext } from './context/app_context';
import { getMainWindow } from './main_window';

/** 系统层只给通用提醒，避免锁屏、录屏或隐私模式泄露邮件主题。 */
export function handleMailNotification(uin: string, notice: MailNotice): void {
  const context = getAppContext();
  const mail = context.services?.mail;
  if (
    !mail ||
    String(context.account?.context.uin) !== uin ||
    !mail.status().notifications ||
    !Notification.isSupported()
  )
    return;
  const window = getMainWindow();
  if (window && !window.isDestroyed() && window.isFocused() && !window.isMinimized()) return;
  const notification = new Notification({ title: 'QQ 邮箱', body: '收到新邮件。', silent: false });
  notification.on('click', () => {
    const current = getAppContext();
    if (String(current.account?.context.uin) !== uin || current.services?.mail !== mail) return;
    const target = getMainWindow();
    if (target && !target.isDestroyed()) {
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
    }
    mail.events.emit('change', { type: 'open', notice });
  });
  notification.show();
}
