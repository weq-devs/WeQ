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
import { WebVideoEncoder } from '../src/main/call_video_encoder';

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
const keyframe = Uint8Array.from([
  0,
  0,
  0,
  1,
  0x67,
  0x64,
  0,
  0x1f,
  0,
  0,
  0,
  1,
  0x68,
  0x80,
  0,
  0,
  0,
  1,
  0x65,
  ...new Array(2200).fill(0x81),
]);
const followingFrame = Uint8Array.from([0, 0, 0, 1, 0x41, ...new Array(2200).fill(0x81)]);
let activeManager: CallManager | undefined;

function setup() {
  vi.useFakeTimers();
  const open = vi.spyOn(WebVideoEncoder.prototype, 'open');
  const close = vi.spyOn(WebVideoEncoder.prototype, 'close');
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

  function pushFrame(
    data: Uint8Array,
    key: boolean,
    captureId = manager.current()?.videoCaptureId ?? '',
  ) {
    return manager.pushEncodedVideoFrame(data, key, captureId);
  }

  return { manager, open, close, control, connect, pushFrame };
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
    const { manager, open, close, control, connect, pushFrame } = setup();
    await connect();
    expect(open).not.toHaveBeenCalled();

    const ready = Promise.withResolvers<void>();
    open.mockReturnValueOnce(ready.promise);
    const opening = manager.setCamera(true);
    expect(manager.current()?.videoSending).toBe(false);
    expect(control.media(VIDEO_CTRL_SUB_TYPE)).toHaveLength(0);
    expect(pushFrame(keyframe, true)).toBe(false);

    ready.resolve();
    await expect(opening).resolves.toBe(true);
    const { width, height, fps } = { width: 320, height: 240, fps: 10 };
    expect(manager.current()).toMatchObject({
      videoSending: true,
      videoProfile: { width, height, fps },
    });
    expect(control.media(VIDEO_CTRL_SUB_TYPE)).toHaveLength(2);

    expect(pushFrame(followingFrame, false)).toBe(false);
    expect(pushFrame(keyframe, true)).toBe(true);
    expect(pushFrame(followingFrame, false)).toBe(true);
    expect(pushFrame(followingFrame, false)).toBe(true);
    expect(pushFrame(followingFrame, false)).toBe(true);
    expect(pushFrame(followingFrame, false)).toBe(true);
    const assembler = new VideoFrameAssembler();
    const frames = control.media(VideoSubType.max).flatMap((packet) => {
      const parsed = parseVideoPacket(packet);
      const frame = parsed && assembler.push(parsed, 0);
      return frame ? [frame] : [];
    });
    expect(frames).toHaveLength(5);
    expect(frames.map((frame) => frame.isKeyframe)).toEqual([true, false, false, false, false]);
    expect(frames.map(({ gidx, fidx }) => [gidx, fidx])).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
    ]);
    expect(frames.map((frame) => frame.frameData[1])).toEqual([0, 0, 0, 0, 3]);
    expect(frames.every((frame) => frame.frameData[3] === 5)).toBe(true);
    expect(frames[0]!.frameData.subarray(20, 20 + keyframe.length)).toEqual(keyframe);
    expect(frames[1]!.frameData.subarray(20, 20 + followingFrame.length)).toEqual(followingFrame);
    const packets = control.media(VideoSubType.max);
    expect(packets.some((packet) => packet[4] === 2 && packet[19] === 0)).toBe(true);
    expect(packets.some((packet) => packet[4] === 3 && packet[19] === 1)).toBe(true);

    const oldCaptureId = manager.current()!.videoCaptureId;
    await manager.setCamera(false);
    await manager.setCamera(true);
    expect(pushFrame(keyframe, true, oldCaptureId)).toBe(false);
    expect(pushFrame(followingFrame, false)).toBe(false);
    expect(pushFrame(keyframe, true)).toBe(true);
    expect(parseVideoPacket(control.media(VideoSubType.max).at(-1)!)?.rtp.fidx).toBe(2);
    expect(open).toHaveBeenCalledTimes(1);
    await manager.hangup();
    expect(close).toHaveBeenCalled();
  });

  it('编码器打开失败时保持通话和摄像头关闭，随后可以重试', async () => {
    const { manager, open, control, connect } = setup();
    await connect();
    open.mockRejectedValueOnce(new Error('测试初始化失败'));
    await expect(manager.setCamera(true)).rejects.toThrow('测试初始化失败');
    expect(manager.current()).toMatchObject({ state: 'connected', videoSending: false });
    expect(control.media(VIDEO_CTRL_SUB_TYPE)).toHaveLength(0);
    await expect(manager.setCamera(true)).resolves.toBe(true);
    expect(manager.current()?.videoSending).toBe(true);
  });

  it('并发请求复用一次初始化，关闭可以取消尚未完成的开启', async () => {
    const { manager, open, close, control, connect } = setup();
    await connect();
    const ready = Promise.withResolvers<void>();
    open.mockReturnValueOnce(ready.promise);
    const first = manager.setCamera(true);
    const second = manager.setCamera(true);
    expect(open).toHaveBeenCalledTimes(1);
    await manager.setCamera(false);
    ready.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(manager.current()?.videoSending).toBe(false);
    expect(control.media(VIDEO_CTRL_SUB_TYPE)).toHaveLength(0);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(manager.setCamera(true)).resolves.toBe(true);
  });

  it('挂断后清理迟到的编码器，清理完成后可以发起新通话', async () => {
    const { manager, open, close, control, connect } = setup();
    await connect();
    const ready = Promise.withResolvers<void>();
    open.mockReturnValueOnce(ready.promise);
    const opening = manager.setCamera(true);
    await manager.hangup();
    expect(manager.current()).toBeNull();
    expect(manager.busy).toBe(true);
    await expect(manager.start(callParams)).rejects.toThrow('当前已有通话');
    ready.resolve();
    await expect(opening).resolves.toBe(false);
    expect(manager.busy).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(control.media(VIDEO_CTRL_SUB_TYPE)).toHaveLength(0);
    await connect();
    expect(manager.current()?.videoSending).toBe(false);
  });

  it('直接视频仍在拨号时打开编码器，接通后自动发送', async () => {
    const { manager, open, control, connect, pushFrame } = setup();
    await connect('video');
    expect(open).toHaveBeenCalledTimes(1);
    expect(manager.current()?.videoSending).toBe(true);
    expect(pushFrame(keyframe, true)).toBe(true);
    expect(control.media(VideoSubType.max).length).toBeGreaterThan(0);
  });
});
