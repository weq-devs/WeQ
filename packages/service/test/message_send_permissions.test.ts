import { describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { MessageSendService } from '../src/account/message_send';
import { GroupFileService } from '../src/account/group_file';

describe('所有发送入口在协议调用前检查群发言能力', () => {
  it('文本不能绕过服务端禁言检查', async () => {
    const nt = { sendPacket: vi.fn(), sendOidbPacket: vi.fn() };
    const session = { context: { uin: '10001' }, selfUid: 'u_self' } as unknown as AccountSession;
    const authorize = vi.fn(async () => {
      throw new Error('当前被禁言');
    });
    const service = new MessageSendService(
      nt,
      session,
      () => 123,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      authorize,
    );
    await expect(
      service.sendText({ peerType: 'group', targetId: '12345', text: '不应发送' }),
    ).rejects.toThrow('禁言');
    expect(authorize).toHaveBeenCalledWith(12345, false);
    expect(nt.sendPacket).not.toHaveBeenCalled();
    expect(nt.sendOidbPacket).not.toHaveBeenCalled();
  });
  it('成员上传者不能通过底层群文件服务移动文件', async () => {
    const nt = { sendOidbPacket: vi.fn() };
    const session = {} as AccountSession;
    const service = new GroupFileService(
      nt,
      session,
      () => 123,
      async () => ({ role: 'member', owned: true }),
    );
    await expect(service.moveFile(12345, 'file-id', '/', '/folder')).rejects.toThrow('无权');
    expect(nt.sendOidbPacket).not.toHaveBeenCalled();
  });
});
