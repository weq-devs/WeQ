import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useCallVideo } from '../src/renderer/src/hooks/useCallVideo';

type TestFrame = {
  codec: 'hevc' | 'h264';
  frameIndex: number;
  hevc: Uint8Array;
  timestamp: number;
  info: null;
};
const mocks = vi.hoisted(() => ({ onData: null as null | ((frame: TestFrame) => void) }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    call: {
      onCallVideo: {
        useSubscription: (_input: unknown, options: { onData: (frame: TestFrame) => void }) => {
          mocks.onData = options.onData;
        },
      },
    },
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.onData = null;
});

it('连续处理缓存帧并在 H.265 切到 H.264 时重建解码器', async () => {
  const pending = Promise.withResolvers<void>();
  const decoders: FakeDecoder[] = [];
  class FakeDecoder {
    static async isConfigSupported(config: VideoDecoderConfig) {
      if (config.codec.startsWith('hev')) await pending.promise;
      return { supported: true, config };
    }
    state = 'unconfigured';
    config?: VideoDecoderConfig;
    chunks: string[] = [];
    constructor(_callbacks: unknown) {
      decoders.push(this);
    }
    configure(config: VideoDecoderConfig) {
      this.config = config;
      this.state = 'configured';
    }
    decode(chunk: { type: string }) {
      this.chunks.push(chunk.type);
    }
    close() {
      this.state = 'closed';
    }
  }
  class FakeChunk {
    type: string;
    constructor(init: { type: string }) {
      this.type = init.type;
    }
  }
  vi.stubGlobal('VideoDecoder', FakeDecoder);
  vi.stubGlobal('EncodedVideoChunk', FakeChunk);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Subject() {
    useCallVideo({ enabled: true, canvasRef: useRef(null) });
    return null;
  }
  await act(async () => root.render(createElement(Subject)));
  const frame = (codec: 'hevc' | 'h264', frameIndex: number, bytes: number[]) => ({
    codec,
    frameIndex,
    hevc: new Uint8Array(bytes),
    timestamp: frameIndex,
    info: null,
  });
  await act(async () => {
    mocks.onData!(frame('hevc', 0, [0, 0, 0, 1, 0x26, 1, 0x80]));
    mocks.onData!(frame('hevc', 1, [0, 0, 0, 1, 0x02, 1, 0x80]));
    mocks.onData!(
      frame(
        'h264',
        2,
        [0, 0, 0, 1, 0x67, 0x64, 0, 0x1f, 0, 0, 0, 1, 0x68, 0x80, 0, 0, 0, 1, 0x65, 0x80],
      ),
    );
    mocks.onData!(frame('h264', 3, [0, 0, 0, 1, 0x41, 0x80]));
    pending.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(decoders).toHaveLength(2);
  expect(decoders[0]!.chunks).toEqual(['key', 'delta']);
  expect(decoders[0]!.state).toBe('closed');
  expect(decoders[1]!.config?.codec).toBe('avc1.64001f');
  expect(decoders[1]!.config?.codedWidth).toBeUndefined();
  expect(decoders[1]!.chunks).toEqual(['key', 'delta']);
  await act(async () => root.unmount());
  host.remove();
});
