export interface RemoteMediaOptions {
  audio?: true;
  video?: { width: number; height: number; fps: number; facingMode?: 'user' | 'environment' };
}
interface MediaEvent {
  id: string;
  type: 'ready' | 'audio' | 'video' | 'error' | 'ended';
  pcmBase64?: string;
  rgbaBase64?: string;
  width?: number;
  height?: number;
  message?: string;
}
declare global {
  interface Window {
    weqRemoteMedia?: {
      start: (options: RemoteMediaOptions & { id: string }) => void;
      stop: (id: string) => void;
    };
  }
}
let sequence = 0;

export function needsNativeRemoteMedia(): boolean {
  return (
    Boolean(window.weqRemoteMedia) &&
    (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
  );
}

export function decodeMediaBytes(encoded: string): Uint8Array {
  const raw = atob(encoded);
  return Uint8Array.from(raw, (byte) => byte.charCodeAt(0));
}

export function pcm16Samples(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from(
    { length: Math.floor(bytes.length / 2) },
    (_, index) => view.getInt16(index * 2, true) / 32768,
  );
}

/** 原生桥只交付设备采集帧，业务发送仍由现有前端 API 完成。 */
export function startRemoteMedia(
  options: RemoteMediaOptions,
  callbacks: {
    audio?: (pcm: Uint8Array) => void;
    video?: (rgba: Uint8Array, width: number, height: number) => void;
    error?: (message: string) => void;
  },
  signal?: AbortSignal,
): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const bridge = window.weqRemoteMedia;
    if (!bridge) {
      reject(new Error('当前设备没有原生采集能力'));
      return;
    }
    const id = `weq-media-${Date.now()}-${++sequence}`;
    let ready = false,
      stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('weq-remote-media', receive);
      signal?.removeEventListener('abort', abort);
      bridge.stop(id);
    };
    const fail = (message: string) => {
      stop();
      if (!ready) reject(new Error(message));
      else callbacks.error?.(message);
    };
    const abort = () => {
      stop();
      if (!ready) reject(new Error('采集已取消'));
    };
    const receive = (event: Event) => {
      const value = (event as CustomEvent<MediaEvent>).detail;
      if (stopped || value?.id !== id) return;
      if (value.type === 'ready') {
        ready = true;
        clearTimeout(timer);
        resolve(stop);
      } else if (value.type === 'error' || value.type === 'ended')
        fail(value.message || '设备采集已停止');
      else
        try {
          if (value.type === 'audio' && value.pcmBase64 && value.pcmBase64.length <= 128000)
            callbacks.audio?.(decodeMediaBytes(value.pcmBase64));
          if (
            value.type === 'video' &&
            value.rgbaBase64 &&
            value.width &&
            value.height &&
            value.width <= 1920 &&
            value.height <= 1080 &&
            value.rgbaBase64.length <= 12 * 1024 * 1024
          ) {
            const bytes = decodeMediaBytes(value.rgbaBase64);
            if (bytes.length === value.width * value.height * 4)
              callbacks.video?.(bytes, value.width, value.height);
          }
        } catch {
          fail('设备采集数据不可用');
        }
    };
    const timer = setTimeout(() => fail('等待设备采集超时，请重试'), 30000);
    window.addEventListener('weq-remote-media', receive);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      bridge.start({ id, ...options });
    } catch {
      fail('无法请求设备采集');
    }
  });
}
