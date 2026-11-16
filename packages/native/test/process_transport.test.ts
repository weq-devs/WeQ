import { describe, expect, it, vi } from 'vitest';
import { withProcessTransport } from '../src/process_transport';
import type { NtHelperBinding } from '../src/types';

function fixture() {
  return {
    sendPacket: vi.fn<NtHelperBinding['sendPacket']>(async () => Buffer.from('session packet')),
    sendOidbPacket: vi.fn<NtHelperBinding['sendOidbPacket']>(async () =>
      Buffer.from('session oidb'),
    ),
  };
}

describe('WeQ 进程号传输适配', () => {
  it('旧发布构建保持原绑定和原发送入口', () => {
    const binding = fixture();
    expect(withProcessTransport(binding)).toBe(binding);
  });

  it('新构建优先使用显式 PID 入口，不把同值进程号交给会话表', async () => {
    const binding = {
      ...fixture(),
      sendPacketByPid: vi.fn<NtHelperBinding['sendPacket']>(async () => Buffer.from('pid packet')),
      sendOidbPacketByPid: vi.fn<NtHelperBinding['sendOidbPacket']>(async () =>
        Buffer.from('pid oidb'),
      ),
      other: { unchanged: true },
    };
    const adapted = withProcessTransport(binding);
    const body = Buffer.from([1, 2, 3]);
    expect(await adapted.sendPacket(959, 'fixture.Command', body, false, 1)).toEqual(
      Buffer.from('pid packet'),
    );
    expect(await adapted.sendOidbPacket(959, 1, 2, body, true, false, 1)).toEqual(
      Buffer.from('pid oidb'),
    );
    expect(binding.sendPacketByPid).toHaveBeenCalledWith(959, 'fixture.Command', body, false, 1);
    expect(binding.sendOidbPacketByPid).toHaveBeenCalledWith(959, 1, 2, body, true, false, 1);
    expect(binding.sendPacket).not.toHaveBeenCalled();
    expect(binding.sendOidbPacket).not.toHaveBeenCalled();
    expect(adapted.other).toBe(binding.other);
  });

  it('只提供部分新入口时独立适配，保留接收者和原错误', async () => {
    const failure = new Error('pid transport failed');
    const binding = {
      ...fixture(),
      sendPacketByPid: vi.fn(async function (this: object) {
        expect(this).toBe(binding);
        throw failure;
      }),
    };
    const adapted = withProcessTransport(binding);
    await expect(adapted.sendPacket(959, 'fixture.Command', Buffer.alloc(0))).rejects.toBe(failure);
    expect(await adapted.sendOidbPacket(959, 1, 2, Buffer.alloc(0), false)).toEqual(
      Buffer.from('session oidb'),
    );
  });
});
