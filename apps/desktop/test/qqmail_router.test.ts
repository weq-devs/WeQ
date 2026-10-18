import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  context: {} as { services?: unknown; account?: unknown },
  selectedFile: null as string | null,
}));
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => mocks.context }));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  getHost: () => ({ pickFile: async () => mocks.selectedFile }),
}));
import { mailRouter } from '../src/main/ipc/routers/mail';
import { MailFailure } from '@weq/service/mail';

const input = { selfUin: '12345678', requestId: '11111111-1111-4111-8111-111111111111' };
const message = {
  subject: 'fixture',
  content: 'body',
  plainText: true,
  to: [{ email: 'to@example.invalid', name: '' }],
  cc: [],
  bcc: [],
  attachments: [],
};
const api = mailRouter.createCaller({});
function fixture() {
  return {
    status: vi.fn(() => ({
      state: 'ready',
      unread: 0,
      notifications: false,
      lastSync: 0,
      error: null,
    })),
    connect: vi.fn(async () => ({
      state: 'ready',
      unread: 0,
      notifications: false,
      lastSync: 0,
      error: null,
    })),
    folders: vi.fn(async () => []),
    list: vi.fn(async () => ({ items: [], page: 0, total: 0, unread: 0, hasMore: false })),
    read: vi.fn(),
    send: vi.fn(async () => ({ id: 'accepted-fixture', messageId: 'message-fixture' })),
    upload: vi.fn(),
    disconnect: vi.fn(),
    setShowUnread: vi.fn(),
    events: new EventEmitter(),
    setNotifications: vi.fn(async (enabled: boolean) => ({
      state: 'ready',
      unread: 0,
      notifications: enabled,
      lastSync: 0,
      error: null,
    })),
  };
}
let mail: ReturnType<typeof fixture>;
let preferences: {
  setMailNotifications: ReturnType<typeof vi.fn>;
  setMailShowUnread: ReturnType<typeof vi.fn>;
  getRecord: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  mail = fixture();
  preferences = {
    setMailNotifications: vi.fn(),
    setMailShowUnread: vi.fn(),
    getRecord: vi.fn(() => ({})),
  };
  mocks.selectedFile = null;
  mocks.context = {
    services: { mail, accountConfig: preferences },
    account: { context: { uin: input.selfUin } },
  };
});

describe('原生邮箱 IPC 边界', () => {
  it('旧配置默认显示未读数，并读取现有提醒偏好', async () => {
    expect(await api.preferences({ selfUin: input.selfUin })).toEqual({
      showUnread: true,
      notifications: false,
    });
    preferences.getRecord.mockReturnValue({ mailShowUnread: false, mailNotifications: true });
    expect(await api.preferences({ selfUin: input.selfUin })).toEqual({
      showUnread: false,
      notifications: true,
    });
  });
  it('未读数显示开关独立保存，拒绝跨账号读取与写入', async () => {
    await expect(api.setShowUnread({ selfUin: input.selfUin, enabled: false })).resolves.toBe(
      false,
    );
    expect(preferences.setMailShowUnread).toHaveBeenCalledWith(false);
    expect(mail.setShowUnread).toHaveBeenCalledWith(false);
    expect(preferences.setMailNotifications).not.toHaveBeenCalled();
    expect(mail.setNotifications).not.toHaveBeenCalled();
    await expect(api.preferences({ selfUin: '87654321' })).rejects.toThrow('账号已切换');
    await expect(api.setShowUnread({ selfUin: '87654321', enabled: true })).rejects.toThrow(
      '账号已切换',
    );
    expect(preferences.setMailShowUnread).toHaveBeenCalledOnce();
  });
  it('提醒偏好只写入当前账号，断开连接同步清除偏好', async () => {
    await expect(api.notifications({ ...input, enabled: true })).resolves.toMatchObject({
      notifications: true,
    });
    expect(preferences.setMailNotifications).toHaveBeenCalledWith(true);
    await expect(
      api.notifications({ ...input, selfUin: '87654321', enabled: false }),
    ).rejects.toThrow('账号已切换');
    expect(preferences.setMailNotifications).toHaveBeenCalledTimes(1);
    await api.disconnect({ selfUin: input.selfUin });
    expect(preferences.setMailNotifications).toHaveBeenLastCalledWith(false);
  });
  it('每次请求校验账号，不读其他账号的服务', async () => {
    expect(await api.status({ selfUin: input.selfUin })).toMatchObject({ state: 'ready' });
    await expect(api.list({ ...input, selfUin: '87654321', folderId: 1, page: 0 })).rejects.toThrow(
      '账号已切换',
    );
    expect(mail.list).not.toHaveBeenCalled();
  });
  it('晚到的读取不能越过重开账号后的服务边界', async () => {
    let release: (() => void) | undefined;
    mail.folders.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    const pending = api.folders(input);
    await vi.waitFor(() => expect(release).toBeDefined());
    mocks.context.services = { mail: fixture() };
    release!();
    await expect(pending).rejects.toThrow('账号状态已变化');
  });
  it('用户取消文件选择不上传，也不接收任意本机路径输入', async () => {
    expect(await api.upload(input)).toBeNull();
    expect(mail.upload).not.toHaveBeenCalled();
  });
  it('取消只作用于当前账号的请求，结束后释放请求编号', async () => {
    mocks.selectedFile = '/fixture/user-selected.txt';
    let signal: AbortSignal | undefined;
    mail.upload.mockImplementation(
      (_path: string, active: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal = active;
          active.addEventListener('abort', () => reject(new MailFailure('business', '已取消')), {
            once: true,
          });
        }),
    );
    const pending = api.upload(input);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await expect(api.cancel({ ...input, selfUin: '87654321' })).rejects.toThrow('账号已切换');
    expect(signal!.aborted).toBe(false);
    await api.cancel(input);
    await expect(pending).rejects.toThrow('已取消');
    await expect(api.connect(input)).resolves.toMatchObject({ state: 'ready' });
  });
  it('提交成功、明确拒绝和结果未知具有不同的返回状态', async () => {
    expect(await api.send({ ...input, message })).toMatchObject({
      state: 'accepted',
      id: 'accepted-fixture',
    });
    mail.send.mockRejectedValueOnce(new MailFailure('business', '收件人无效。'));
    expect(await api.send({ ...input, message })).toEqual({
      state: 'rejected',
      message: '收件人无效。',
    });
    mail.send.mockRejectedValueOnce(new MailFailure('unknown-send', '发送结果未知。'));
    expect(await api.send({ ...input, message })).toEqual({
      state: 'unknown',
      message: '发送结果未知。',
    });
  });
  it('意外异常不泄露底层响应或带票据URL', async () => {
    mail.folders.mockRejectedValueOnce(new Error('https://wx.mail.qq.com/path?sid=fixture-secret'));
    await expect(api.folders(input)).rejects.toThrow('邮箱操作失败');
    mail.send.mockRejectedValueOnce(new Error('cookie=fixture-secret'));
    expect(JSON.stringify(await api.send({ ...input, message }))).not.toContain('fixture-secret');
  });
});
