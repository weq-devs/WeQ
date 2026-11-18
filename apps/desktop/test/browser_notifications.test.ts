import { afterEach, expect, it, vi } from 'vitest';
import {
  browserNoticeChannel,
  WEB_NOTICE_OPEN,
} from '../src/renderer/src/lib/browserNotifications';
import type { WebNotice } from '../src/main/web/notices';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('普通消息复用浏览器通知生命周期与跳转，数量有界且关闭清理', () => {
  const items: TestNotification[] = [];
  class TestNotification {
    static permission = 'granted';
    onclose?: () => void;
    onclick?: () => void;
    closed = false;
    constructor(readonly title: string) {
      items.push(this);
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
  }
  vi.stubGlobal('Notification', TestNotification);
  vi.spyOn(window, 'focus').mockImplementation(() => undefined);
  const channel = browserNoticeChannel();
  const notice: WebNotice = {
    uin: '10001',
    configId: 'fixture',
    kind: 'message',
    title: '联系人',
    body: '正文',
    target: { kind: 'group', conv: '20001', seq: '1' },
  };
  const opened = vi.fn();
  window.addEventListener(WEB_NOTICE_OPEN, opened);
  const notices = Array.from({ length: 21 }, (_, index) => ({
    ...notice,
    target: { ...notice.target!, seq: String(index + 1) },
  }));
  try {
    for (const message of notices) expect(channel.show(message)).toBe(true);
    expect(channel.show({ ...notices.at(-1)!, kind: 'keyword' })).toBe(true);
    expect(items).toHaveLength(21);
    expect(items.filter((item) => !item.closed)).toHaveLength(20);
    items.at(-1)?.onclick?.();
    expect(opened).toHaveBeenCalledOnce();
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual(notices.at(-1));
    channel.close();
    expect(items.every((item) => item.closed)).toBe(true);
    TestNotification.permission = 'denied';
    expect(channel.show(notice)).toBe(false);
  } finally {
    window.removeEventListener(WEB_NOTICE_OPEN, opened);
    channel.close();
  }
});
