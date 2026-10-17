import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  context: {} as { services?: unknown; account?: unknown },
  focused: false,
  options: [] as { title: string; body: string }[],
  click: null as (() => void) | null,
  show: vi.fn(),
  focus: vi.fn(),
}));
vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return true;
    }
    constructor(options: { title: string; body: string }) {
      mocks.options.push(options);
    }
    on(_event: string, listener: () => void): void {
      mocks.click = listener;
    }
    show(): void {
      mocks.show();
    }
  },
}));
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => mocks.context }));
vi.mock('../src/main/main_window', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    isFocused: () => mocks.focused,
    isMinimized: () => false,
    show: () => {},
    focus: mocks.focus,
  }),
}));
import { handleMailNotification } from '../src/main/mail_notify';
const notice = {
  id: 'fixture-id',
  subject: 'private-fixture-subject',
  sender: 'private-fixture-sender',
  folderId: 1,
};
let mail: { status(): { notifications: boolean }; events: { emit: ReturnType<typeof vi.fn> } };
beforeEach(() => {
  mocks.options = [];
  mocks.focused = false;
  mocks.click = null;
  mocks.show.mockReset();
  mocks.focus.mockReset();
  mail = { status: () => ({ notifications: true }), events: { emit: vi.fn() } };
  mocks.context = { services: { mail }, account: { context: { uin: '12345678' } } };
});
describe('邮箱系统通知', () => {
  it('只显示通用文案，当前账号点击后打开邮件', () => {
    handleMailNotification('12345678', notice);
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.options)).not.toContain('private-fixture');
    mocks.click!();
    expect(mocks.focus).toHaveBeenCalledOnce();
    expect(mail.events.emit).toHaveBeenCalledWith('change', { type: 'open', notice });
  });
  it('前台不重复弹系统通知，切号或重开后旧通知不可导航', () => {
    mocks.focused = true;
    handleMailNotification('12345678', notice);
    expect(mocks.show).not.toHaveBeenCalled();
    mocks.focused = false;
    handleMailNotification('12345678', notice);
    mocks.context.services = { mail: { ...mail } };
    mocks.click!();
    expect(mail.events.emit).not.toHaveBeenCalled();
    expect(mocks.focus).not.toHaveBeenCalled();
    mocks.context.account = { context: { uin: '87654321' } };
    mocks.click!();
    expect(mail.events.emit).not.toHaveBeenCalled();
  });
});
