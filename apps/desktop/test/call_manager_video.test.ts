// @vitest-environment node
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import type { NtHelperBinding } from '@weq/native';
import type { Platform } from '@weq/platform';
import {
  AUDIO_STX,
  CallEvent,
  GcsBodyType,
  VIDEO_CTRL_SUB_TYPE,
  VideoFrameAssembler,
  VideoSubType,
  buildGcsHead,
  buildGcsPacket,
  parseVideoPacket,
  pbBytes,
  pbVarint,
} from '@weqbot/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallManager } from '../src/main/call';
import { CAMERA_PROFILE } from '../src/shared/call_video_profile';

const SELF_UIN = 10001;
const PEER_UIN = 10002;
const ROOM_ID = 777n;
const SERVER = { ip: '192.0.2.1', port: 8000, type: 1 };

vi.mock('@weq/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weq/service')>()),
  protocolSignaling: () => ({
    start: async () => ({
      room: {
        roomId: ROOM_ID,
        sessionId: 88n,
        relationId: 1,
        authKey: new Uint8Array(80).fill(1),
        servers: [SERVER],
      },
      authToken: 1234,
    }),
    end: async () => {},
  }),
}));

class OfflineSocket extends EventEmitter {
  readonly sent: Uint8Array[] = [];

  bind(_port: number, callback: () => void): void {
    callback();
  }

  address() {
    return { address: '::', port: 51348 };
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.removeAllListeners();
  }

  deliver(bodyType: number, body: Uint8Array): void {
    const head = buildGcsHead({
      roomId: ROOM_ID,
      selfUin: SELF_UIN,
      sessionTs: 999,
      typeId: bodyType,
      bodyType,
    });
    this.emit('message', buildGcsPacket(head, body), { address: SERVER.ip, port: SERVER.port });
  }

  media(subType: number): Uint8Array[] {
    return this.sent.filter((packet) => packet[0] === AUDIO_STX && packet[3] === subType);
  }
}

const callParams = {
  pid: 1,
  selfUin: String(SELF_UIN),
  selfUid: 'u_self',
  peerUin: String(PEER_UIN),
  peerUid: 'u_peer',
};
const keyframe = [0, 0, 0, 1, 0x26, 0x01, 0x80];
const followingFrame = [0, 0, 0, 1, 0x02, 0x01, 0x80];
let activeManager: CallManager | undefined;

function setup() {
  vi.useFakeTimers();
  const control = new OfflineSocket();
  const createSocket = vi
    .spyOn(dgram, 'createSocket')
    .mockImplementation(() => new OfflineSocket() as unknown as dgram.Socket);
  const nt = {
    openCallCodec: vi.fn(async () => {}),
    closeCallCodec: vi.fn(),
    encodeCallFrame: vi.fn(() => Buffer.from([1])),
    openVideoEncoder: vi.fn(async () => {}),
    closeVideoEncoder: vi.fn(),
    encodeVideoFrame: vi.fn(() => ({ data: Buffer.from(followingFrame), keyframe: false })),
  };
  const platform = { qqWrapperNodePath: () => '/fixture/qq/wrapper.node' } as Platform;
  const manager = new CallManager(nt as unknown as NtHelperBinding, platform);
  activeManager = manager;

  async function connect(media: 'audio' | 'video' = 'audio') {
    createSocket.mockReturnValueOnce(control as unknown as dgram.Socket);
    await manager.start({ ...callParams, media });
    control.deliver(GcsBodyType.authRsp, pbVarint(1, 1));
    const peer = new Uint8Array([...pbVarint(1, PEER_UIN), ...pbVarint(3, CallEvent.dataChange)]);
    control.deliver(
      GcsBodyType.notifyPush,
      new Uint8Array([...pbVarint(1, 1), ...pbBytes(2, peer)]),
    );
    expect(manager.current()?.state).toBe('connected');
  }

  function pushCameraFrame() {
    const y = new Uint8Array(CAMERA_PROFILE.width * CAMERA_PROFILE.height);
    return manager.pushVideoFrame(y, new Uint8Array(y.length / 4), new Uint8Array(y.length / 4));
  }

  return { manager, nt, control, connect, pushCameraFrame };
}

afterEach(async () => {
  try {
    await activeManager?.hangup();
  } finally {
    activeManager = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe('私聊摄像头发送', () => {
  it('语音接通后首次开启，编码器就绪再发控制包和连续视频帧', async () => {
    const { manager, nt, control, connect, pushCameraFrame } = setup();
    await connect();
    expect(nt.openVideoEncoder).not.toHaveBeenCalled();

    const ready = Promise.withResolvers<void>();
    nt.openVideoEncoder.mockReturnValueOnce(ready.promise);
    const opening = manager.setCamera(true);
    expect(manager.current()?.videoSending).toBe(false);
    expect(control.media(VIDEO_CTRL_SUB_TYPE)).toHaveLength(0);
    expect(pushCameraFrame()).toBe(false);

    ready.resolve();
    await expect(opening).resolves.toBe(true);
    const { width, height, fps } = CAMERA_PROFILE;
    expect(manager.current()).toMatchObject({
      videoSending: true,
      videoProfile: { width, height, fps },
    });
    expect(control.media(VIDEO_CTRL_SUB_TYPE)).toHaveLength(2);

    nt.encodeVideoFrame.mockReturnValueOnce({ data: Buffer.from(keyframe), keyframe: true });
    for (let index = 0; index < 3; index++) {
      expect(pushCameraFrame()).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
    }

    const assembler = new VideoFrameAssembler();
    const frames = control.media(VideoSubType.max).flatMap((packet) => {
      const parsed = parseVideoPacket(packet);
      const frame = parsed && assembler.push(parsed, 0);
      return frame ? [Array.from(frame.frameData.subarray(frame.frameData[0]))] : [];
    });
    expect(frames).toEqual([keyframe, followingFrame, followingFrame]);

    expect(pushCameraFrame()).toBe(true);
    await manager.setCamera(false);
    await manager.setCamera(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(nt.encodeVideoFrame).toHaveBeenCalledTimes(3);
    expect(nt.openVideoEncoder).toHaveBeenCalledTimes(1);
    await manager.hangup();
    expect(nt.closeVideoEncoder).toHaveBeenCalledTimes(1);
  });

  it('编码器打开失败时保持通话和摄像头关闭，随后可以重试', async () => {
    const { manager, nt, control, connect } = setup();
    await connect();
    nt.openVideoEncoder.mockRejectedValueOnce(new Error('测试初始化失败'));
    await expect(manager.setCamera(true)).rejects.toThrow('测试初始化失败');
    expect(manager.current()).toMatchObject({ state: 'connected', videoSending: false });
    expect(control.media(VIDEO_CTRL_SUB_TYPE)).toHaveLength(0);
    await expect(manager.setCamera(true)).resolves.toBe(true);
    expect(manager.current()?.videoSending).toBe(true);
  });

  it('并发请求复用一次初始化，关闭可以取消尚未完成的开启', async () => {
    const { manager, nt, control, connect } = setup();
    await connect();
    const ready = Promise.withResolvers<void>();
    nt.openVideoEncoder.mockReturnValueOnce(ready.promise);
    const first = manager.setCamera(true);
    const second = manager.setCamera(true);
    expect(nt.openVideoEncoder).toHaveBeenCalledTimes(1);
    await manager.setCamera(false);
    ready.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(manager.current()?.videoSending).toBe(false);
    expect(control.media(VIDEO_CTRL_SUB_TYPE)).toHaveLength(0);
    expect(nt.closeVideoEncoder).toHaveBeenCalledTimes(1);
    await expect(manager.setCamera(true)).resolves.toBe(true);
  });

  it('挂断后清理迟到的编码器，清理完成后可以发起新通话', async () => {
    const { manager, nt, control, connect } = setup();
    await connect();
    const ready = Promise.withResolvers<void>();
    nt.openVideoEncoder.mockReturnValueOnce(ready.promise);
    const opening = manager.setCamera(true);
    await manager.hangup();
    expect(manager.current()).toBeNull();
    expect(manager.busy).toBe(true);
    await expect(manager.start(callParams)).rejects.toThrow('当前已有通话');
    ready.resolve();
    await expect(opening).resolves.toBe(false);
    expect(manager.busy).toBe(false);
    expect(nt.closeVideoEncoder).toHaveBeenCalledTimes(1);
    expect(control.media(VIDEO_CTRL_SUB_TYPE)).toHaveLength(0);
    await connect();
    expect(manager.current()?.videoSending).toBe(false);
  });

  it('直接视频仍在拨号时打开编码器，接通后自动发送', async () => {
    const { manager, nt, control, connect, pushCameraFrame } = setup();
    await connect('video');
    expect(nt.openVideoEncoder).toHaveBeenCalledTimes(1);
    expect(manager.current()?.videoSending).toBe(true);
    expect(pushCameraFrame()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(control.media(VideoSubType.max)).toHaveLength(1);
  });
});
