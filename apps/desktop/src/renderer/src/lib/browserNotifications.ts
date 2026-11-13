import type { WebNotice } from '../../../main/web/notices';

export const WEB_NOTICE_OPEN = 'weq:web-notice-open';

/** 浏览器与 Remote 的既有通知通道，共用容量限制、关闭清理及会话跳转。 */
export function browserNoticeChannel() {
  const visible = new Set<Notification>();
  return {
    show(notice: WebNotice) {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted')
        return false;
      try {
        const item = new Notification(notice.title, {
          body: notice.body,
          tag: `weq:${notice.kind}:${notice.target?.conv ?? ''}`,
        });
        visible.add(item);
        item.onclose = () => visible.delete(item);
        item.onclick = () => {
          window.focus();
          window.dispatchEvent(new CustomEvent(WEB_NOTICE_OPEN, { detail: notice }));
          item.close();
        };
        while (visible.size > 20) {
          const first = visible.values().next().value!;
          first.close();
          visible.delete(first);
        }
        return true;
      } catch {
        return false;
      }
    },
    close() {
      for (const item of visible) item.close();
      visible.clear();
    },
  };
}
