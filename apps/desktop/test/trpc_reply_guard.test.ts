import { describe, expect, it, vi } from 'vitest';
import { guardTrpcReply } from '../src/main/ipc/reply_guard';

const disposedMessage = 'Render frame was disposed before WebFrameMain could be accessed';

function fixture() {
  const sender = { isDestroyed: vi.fn(() => false) };
  const frame = { isDestroyed: vi.fn(() => false), detached: false };
  const reply = vi.fn(function (this: unknown, ..._args: unknown[]) {});
  const event = { sender, senderFrame: frame as typeof frame | null, reply };
  guardTrpcReply(event);
  return { event, sender, frame, reply };
}

describe('tRPC 页面帧回复保护', () => {
  it('正常回复保留原接收对象、频道和数据', () => {
    const { event, reply } = fixture();
    const response = { id: 1, result: { type: 'data', data: { at: 123 } } };
    event.reply('electron-trpc', response);
    expect(reply).toHaveBeenCalledWith('electron-trpc', response);
    expect(reply.mock.contexts[0]).toBe(event);
  });

  it.each(['destroyed', 'detached', 'sender-destroyed', 'missing'] as const)(
    '页面不可用时丢弃迟到的订阅推送：%s',
    (state) => {
      const { event, sender, frame, reply } = fixture();
      if (state === 'destroyed') frame.isDestroyed.mockReturnValue(true);
      if (state === 'detached') frame.detached = true;
      if (state === 'sender-destroyed') sender.isDestroyed.mockReturnValue(true);
      if (state === 'missing') event.senderFrame = null;
      event.reply('electron-trpc', { id: 1 });
      expect(reply).not.toHaveBeenCalled();
    },
  );

  it('检查后恰好释放页面帧时不会把竞态错误抛出事件回调', () => {
    const { event, reply } = fixture();
    reply.mockImplementation(() => {
      throw new Error(disposedMessage);
    });
    expect(() => event.reply('electron-trpc', { id: 1 })).not.toThrow();
  });

  it('页面帧属性读取也可能遇到释放竞态', () => {
    const { event, reply } = fixture();
    Object.defineProperty(event, 'senderFrame', {
      get() {
        throw new Error(disposedMessage);
      },
    });
    expect(() => event.reply('electron-trpc', { id: 1 })).not.toThrow();
    expect(reply).not.toHaveBeenCalled();
  });

  it('不吞掉非页面释放错误', () => {
    const { event, reply } = fixture();
    const error = new Error('serialization failed');
    reply.mockImplementation(() => {
      throw error;
    });
    expect(() => event.reply('electron-trpc', { id: 1 })).toThrow(error);
  });

  it('旧页面的迟到回复不会改发给新页面', () => {
    const old = fixture();
    old.frame.isDestroyed.mockReturnValue(true);
    const current = fixture();
    old.event.reply('electron-trpc', { id: 1, result: 'old' });
    current.event.reply('electron-trpc', { id: 1, result: 'current' });
    expect(old.reply).not.toHaveBeenCalled();
    expect(current.reply).toHaveBeenCalledTimes(1);
    expect(current.reply).toHaveBeenCalledWith('electron-trpc', {
      id: 1,
      result: 'current',
    });
  });
});
