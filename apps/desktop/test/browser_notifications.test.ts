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
    target: { kind: 'c2c', conv: 'peer', seq: '1' },
  };
  const opened = vi.fn();
  window.addEventListener(WEB_NOTICE_OPEN, opened);
  try {
    for (let i = 0; i < 21; i++) expect(channel.show(notice)).toBe(true);
    expect(items.filter((item) => !item.closed)).toHaveLength(20);
    items.at(-1)?.onclick?.();
    expect(opened).toHaveBeenCalledOnce();
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual(notice);
    channel.close();
    expect(items.every((item) => item.closed)).toBe(true);
    TestNotification.permission = 'denied';
    expect(channel.show(notice)).toBe(false);
  } finally {
    window.removeEventListener(WEB_NOTICE_OPEN, opened);
    channel.close();
  }
});
