// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { guardTrpcReply } from '../src/main/ipc/reply_guard';

const disposedMessage = 'Render frame was disposed before WebFrameMain could be accessed';

function fixture(hasFrame = true) {
  const sender = { isDestroyed: vi.fn(() => false) };
  const frame = { isDestroyed: vi.fn(() => false), detached: false };
  const reply = vi.fn(function (this: unknown, ..._args: unknown[]) {});
  const event = { sender, senderFrame: hasFrame ? frame : null, reply };
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

  it.each(['destroyed', 'detached', 'sender-destroyed'] as const)(
    '页面不可用时丢弃迟到的订阅推送：%s',
    (state) => {
      const { event, sender, frame, reply } = fixture();
      if (state === 'destroyed') frame.isDestroyed.mockReturnValue(true);
      if (state === 'detached') frame.detached = true;
      if (state === 'sender-destroyed') sender.isDestroyed.mockReturnValue(true);
      event.reply('electron-trpc', { id: 1 });
      expect(reply).not.toHaveBeenCalled();
    },
  );

  it('请求没有来源帧时不发送回复', () => {
    const { event, reply } = fixture(false);
    event.reply('electron-trpc', { id: 1 });
    expect(reply).not.toHaveBeenCalled();
  });

  it('同步保存来源帧，异步回复和订阅推送不再读取事件的帧属性', async () => {
    const sender = { isDestroyed: () => false };
    const frame = { isDestroyed: () => false, detached: false };
    const reply = vi.fn();
    let navigated = false;
    const getFrame = vi.fn(() => {
      if (navigated)
        throw new Error('Frame property was accessed after it navigated or was destroyed');
      return frame;
    });
    const event = {
      sender,
      get senderFrame() {
        return getFrame();
      },
      reply,
    };
    guardTrpcReply(event);
    expect(getFrame).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    navigated = true;
    event.reply('electron-trpc', { id: 1 });
    event.reply('electron-trpc', { id: 2 });
    expect(getFrame).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it('检查后恰好释放页面帧时不会把竞态错误抛出事件回调', () => {
    const { event, reply } = fixture();
    reply.mockImplementation(() => {
      throw new Error(disposedMessage);
    });
    expect(() => event.reply('electron-trpc', { id: 1 })).not.toThrow();
  });

  it('同步保存页面帧时也可能遇到释放竞态', () => {
    const reply = vi.fn();
    const event = {
      sender: { isDestroyed: () => false },
      get senderFrame(): null {
        throw new Error(disposedMessage);
      },
      reply,
    };
    expect(() => guardTrpcReply(event)).not.toThrow();
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

  it('同步保存帧时不吞掉其他错误', () => {
    const error = new Error('unexpected frame lookup failure');
    const event = {
      sender: { isDestroyed: () => false },
      get senderFrame(): null {
        throw error;
      },
      reply: vi.fn(),
    };
    expect(() => guardTrpcReply(event)).toThrow(error);
  });

  it('旧页面的迟到回复不会改发给新页面', () => {
    const old = fixture();
    old.frame.isDestroyed.mockReturnValue(true);
    const current = fixture();
    old.event.senderFrame = current.frame;
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
