import { useCallback, useEffect, useRef, useState } from 'react';
import { client, trpc } from '../trpc/client';

const PRIMARY = { width: 640, height: 360, bitrate: 500_000 };
const SECONDARY = { width: 192, height: 144, bitrate: 120_000 };
const FPS = 12;

export function useGroupCamera(id: string, enabled: boolean, onError: (message: string) => void) {
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    if (!enabled) {
      setPreview(null);
      return;
    }
    let stopped = false;
    let stream: MediaStream | undefined;
    let source: HTMLVideoElement | undefined;
    let timer: number | undefined;
    let primary: VideoEncoder | undefined;
    let secondary: VideoEncoder | undefined;
    let busy = false;
    const pairs = new Map<
      number,
      { data?: Uint8Array<ArrayBuffer>; secondary?: Uint8Array<ArrayBuffer>; keyframe: boolean }
    >();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) window.clearInterval(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (source) source.srcObject = null;
      if (primary && primary.state !== 'closed') primary.close();
      if (secondary && secondary.state !== 'closed') secondary.close();
      pairs.clear();
    };
    const failed = (error: unknown) => {
      if (stopped) return;
      stop();
      setPreview(null);
      errorRef.current(error instanceof Error ? error.message : String(error));
    };
    const encode = async (profile: typeof PRIMARY, track: 'data' | 'secondary') => {
      if (typeof VideoEncoder === 'undefined') throw new Error('当前设备不支持 H.264 编码');
      const options: VideoEncoderConfig = {
        ...profile,
        codec: 'avc1.64001f',
        avc: { format: 'annexb' },
        framerate: FPS,
        latencyMode: 'realtime',
      };
      if (!(await VideoEncoder.isConfigSupported(options)).supported)
        throw new Error('当前设备不支持 H.264 编码');
      if (stopped) return undefined;
      const encoder = new VideoEncoder({
        output: (chunk) => {
          if (stopped) return;
          const pair = pairs.get(chunk.timestamp) ?? { keyframe: false };
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          pair[track] = bytes;
          if (track === 'data') pair.keyframe = chunk.type === 'key';
          if (pair.data && pair.secondary) {
            pairs.delete(chunk.timestamp);
            busy = true;
            void client.groupCall.pushVideo
              .mutate({ id, data: pair.data, secondary: pair.secondary, keyframe: pair.keyframe })
              .catch(failed)
              .finally(() => {
                busy = false;
              });
          } else {
            pairs.set(chunk.timestamp, pair);
            if (pairs.size > 12) pairs.delete(pairs.keys().next().value!);
          }
        },
        error: failed,
      });
      try {
        encoder.configure(options);
      } catch (error) {
        encoder.close();
        throw error;
      }
      return encoder;
    };
    const start = async () => {
      primary = await encode(PRIMARY, 'data');
      secondary = await encode(SECONDARY, 'secondary');
      if (!primary || !secondary || stopped) return;
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境无法访问摄像头');
      const camera = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: PRIMARY.width },
          height: { ideal: PRIMARY.height },
          frameRate: { ideal: FPS },
        },
        audio: false,
      });
      if (stopped) {
        for (const track of camera.getTracks()) track.stop();
        return;
      }
      stream = camera;
      for (const track of camera.getVideoTracks())
        track.addEventListener('ended', () => failed(new Error('摄像头已断开')));
      source = document.createElement('video');
      source.srcObject = camera;
      source.muted = true;
      source.playsInline = true;
      await source.play();
      if (stopped) return;
      setPreview(camera);
      const tracks = [
        { canvas: new OffscreenCanvas(PRIMARY.width, PRIMARY.height), encoder: primary },
        { canvas: new OffscreenCanvas(SECONDARY.width, SECONDARY.height), encoder: secondary },
      ];
      let index = 0;
      timer = window.setInterval(() => {
        if (!source || !primary || !secondary || source.readyState < 2) return;
        // 跳过尚未编码的输入帧，保留码流的预测链。
        if (busy || pairs.size > 0 || primary.encodeQueueSize > 0 || secondary.encodeQueueSize > 0)
          return;
        const timestamp = Math.round(performance.now() * 1000);
        const keyFrame = index++ % FPS === 0;
        pairs.set(timestamp, { keyframe: false });
        for (const { canvas, encoder } of tracks) {
          const context = canvas.getContext('2d');
          if (!context) continue;
          context.fillStyle = '#000';
          context.fillRect(0, 0, canvas.width, canvas.height);
          const scale = Math.min(
            canvas.width / source.videoWidth,
            canvas.height / source.videoHeight,
          );
          const width = source.videoWidth * scale;
          const height = source.videoHeight * scale;
          context.drawImage(
            source,
            (canvas.width - width) / 2,
            (canvas.height - height) / 2,
            width,
            height,
          );
          const frame = new VideoFrame(canvas, { timestamp });
          try {
            encoder.encode(frame, { keyFrame });
          } catch (error) {
            failed(error);
            return;
          } finally {
            frame.close();
          }
        }
      }, 1000 / FPS);
    };
    void start().catch(failed);
    return stop;
  }, [id, enabled]);
  return enabled ? preview : null;
}

interface RemoteVideo {
  decoder: VideoDecoder;
  canvas: OffscreenCanvas;
  timestamp: number;
}

/**
 * 群通话的远端画面。
 *
 * 每个成员只解码一次（`OffscreenCanvas` 里保存最新一帧），再画到界面注册的
 * 任意多块 `<canvas>` 上 —— 主舞台和缩略条可以同时显示同一个人。
 */
export function useGroupRemoteVideo(id: string, live: boolean, activeUins: ReadonlySet<number>) {
  const streams = useRef(new Map<number, RemoteVideo>());
  const targets = useRef(new Map<number, Set<HTMLCanvasElement>>());
  const [ready, setReady] = useState<ReadonlySet<number>>(new Set());
  const paint = useCallback((uin: number) => {
    const frame = streams.current.get(uin)?.canvas;
    if (!frame?.width) return;
    for (const canvas of targets.current.get(uin) ?? []) {
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }
      canvas.getContext('2d')?.drawImage(frame, 0, 0);
    }
  }, []);
  /** 挂上一块画布并返回清理函数；画布挂载时立即补画当前帧。 */
  const register = useCallback(
    (uin: number, canvas: HTMLCanvasElement) => {
      const set = targets.current.get(uin) ?? new Set<HTMLCanvasElement>();
      set.add(canvas);
      targets.current.set(uin, set);
      paint(uin);
      return () => {
        const current = targets.current.get(uin);
        if (!current) return;
        current.delete(canvas);
        if (!current.size) targets.current.delete(uin);
      };
    },
    [paint],
  );
  useEffect(() => {
    const removed: number[] = [];
    for (const [uin, stream] of streams.current) {
      if (live && activeUins.has(uin)) continue;
      if (stream.decoder.state !== 'closed') stream.decoder.close();
      streams.current.delete(uin);
      removed.push(uin);
    }
    if (removed.length)
      setReady((current) => new Set([...current].filter((uin) => !removed.includes(uin))));
  }, [live, activeUins]);
  useEffect(
    () => () => {
      for (const { decoder } of streams.current.values())
        if (decoder.state !== 'closed') decoder.close();
      streams.current.clear();
    },
    [],
  );
  trpc.groupCall.video.useSubscription(
    { id },
    {
      enabled: live,
      onData: ({ uin, data, keyframe }) => {
        if (!activeUins.has(uin) || typeof VideoDecoder === 'undefined') return;
        let stream = streams.current.get(uin);
        if (!stream) {
          if (!keyframe) return;
          const annexB = new Uint8Array(data);
          const sps = avcCodec(annexB);
          if (!sps) return;
          const canvas = new OffscreenCanvas(0, 0);
          const decoder = new VideoDecoder({
            output: (frame) => {
              try {
                if (streams.current.get(uin)?.decoder !== decoder) return;
                const first = canvas.width === 0;
                if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                  canvas.width = frame.displayWidth;
                  canvas.height = frame.displayHeight;
                }
                canvas.getContext('2d')?.drawImage(frame, 0, 0);
                if (first) setReady((prior) => (prior.has(uin) ? prior : new Set([...prior, uin])));
                paint(uin);
              } finally {
                frame.close();
              }
            },
            error: () => {
              if (streams.current.get(uin)?.decoder !== decoder) return;
              streams.current.delete(uin);
              setReady((prior) => new Set([...prior].filter((value) => uin !== value)));
            },
          });
          try {
            decoder.configure({ codec: sps, optimizeForLatency: true });
          } catch {
            decoder.close();
            return;
          }
          stream = { decoder, canvas, timestamp: 0 };
          streams.current.set(uin, stream);
        }
        if (stream.decoder.decodeQueueSize > 16) {
          stream.decoder.close();
          streams.current.delete(uin);
          setReady((prior) => new Set([...prior].filter((value) => uin !== value)));
          return;
        }
        try {
          stream.decoder.decode(
            new EncodedVideoChunk({
              data: new Uint8Array(data),
              timestamp: stream.timestamp++,
              type: keyframe ? 'key' : 'delta',
            }),
          );
        } catch {
          if (stream.decoder.state !== 'closed') stream.decoder.close();
          streams.current.delete(uin);
          setReady((prior) => new Set([...prior].filter((value) => uin !== value)));
        }
      },
    },
  );
  return { ready, register };
}

function avcCodec(data: Uint8Array): string | undefined {
  for (let i = 0; i + 6 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1 || (data[i + 3]! & 31) !== 7)
      continue;
    const profile = Array.from(data.subarray(i + 4, i + 7), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    return `avc1.${profile}`;
  }
}
