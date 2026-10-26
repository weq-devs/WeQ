// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { OnlineVoiceTranscriber } from '../src/main/online_transcribe';

const f = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  read: vi.fn(),
  current: vi.fn(),
  send: vi.fn(),
}));
vi.mock('../src/main/capture_session', () => ({
  startAccountCapture: f.start,
  stopAccountCapture: f.stop,
  takeAccountFrames: f.read,
  isAccountCaptureCurrent: f.current,
}));
vi.mock('../src/main/context/app_context', () => ({
  requirePlatform: () => ({ native: { ntHelper: { sendPacket: f.send } } }),
}));
vi.mock('@weq/service', () => ({ getLogger: () => ({ child: () => ({ info: vi.fn() }) }) }));

const handle = {
  pid: 42,
  sessionId: 'synthetic-online',
  elevated: false,
  hasD2Key: true,
  session: {},
};
beforeEach(() => {
  f.start.mockReset().mockResolvedValue(handle);
  f.stop.mockReset().mockResolvedValue(null);
  f.read.mockReset().mockResolvedValue({ frames: [], nextCursor: 7, dropped: 0 });
  f.current.mockReset().mockReturnValue(true);
  f.send.mockReset().mockResolvedValue(Buffer.alloc(0));
});

it('有效在线会话复用，失效后重新建立；旧释放和新释放均携带自己的 ID', async () => {
  const transcriber = new OnlineVoiceTranscriber();
  await transcriber.arm('10001');
  expect(f.read).toHaveBeenCalledWith(42, { waitMs: 0, sessionId: handle.sessionId });
  await transcriber.arm('10001');
  expect(f.start).toHaveBeenCalledOnce();
  f.current.mockReturnValue(false);
  f.start.mockResolvedValue({ ...handle, sessionId: 'synthetic-replacement' });
  await transcriber.arm('10001');
  expect(f.stop).toHaveBeenCalledWith(42, handle.sessionId);
  expect(f.start).toHaveBeenCalledTimes(2);
  await transcriber.disarm();
  expect(f.stop).toHaveBeenLastCalledWith(42, 'synthetic-replacement');
  expect(transcriber.isArmed()).toBe(false);
});

it('缺少解密材料只释放本次建立的会话，不无身份停止整个 pid', async () => {
  f.start.mockResolvedValue({ ...handle, hasD2Key: false });
  const transcriber = new OnlineVoiceTranscriber();
  await expect(transcriber.arm('10001')).rejects.toThrow('d2key');
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.stop).toHaveBeenCalledWith(42, handle.sessionId);
  expect(f.read).not.toHaveBeenCalled();
  expect(transcriber.isArmed()).toBe(false);
});

it('转写拉帧始终带原会话 ID，被工具窗口替换后回退而不读取新归属帧', async () => {
  const transcriber = new OnlineVoiceTranscriber();
  await transcriber.arm('10001');
  f.read.mockRejectedValue(new Error('抓包会话已被替换'));
  const result = await transcriber.transcribe(
    [
      {
        fileName: 'synthetic.amr',
        msgId: '1',
        senderUin: '10001',
        peerUin: '10002',
        isGroup: false,
        uuid: 'synthetic',
        md5: '0'.repeat(32),
        duration: 1,
        size: 1,
        format: 1,
        eventType: 1,
        fileId: 1,
      },
    ],
    1,
  );
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.read).toHaveBeenLastCalledWith(
    42,
    expect.objectContaining({
      cursor: 7,
      sessionId: handle.sessionId,
    }),
  );
  expect(result).toEqual({ texts: {}, missing: ['synthetic.amr'] });
  await transcriber.disarm();
});
