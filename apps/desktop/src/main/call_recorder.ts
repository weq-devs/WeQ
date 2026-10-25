/**
 * 通话录音的混音内核。
 *
 * 通话的两路 PCM 本来就已经在**主进程**里了 —— 上行是渲染层每 20 ms 推来的
 * `pushAudio`，下行是 `CallSession.onAudio` 解码出来的对端音频。所以录音放在
 * 这里最省事：窗口关掉、渲染层崩掉，录音也能正确收尾；将来多人通话只是多几路
 * 输入，不用重做。
 *
 * 三路输入：
 *
 *   self   本端麦克风（上行）
 *   peer   对端（下行）
 *   system 电脑正在播放的声音（可选，Linux / Windows；见 `call_system_audio.ts`）
 *
 * 每路各有一个 100 ms 的队列。20 ms 一拍泵出，**每路取一帧**（缺帧补静音）再按
 * `mode` 合成 —— 三路不共用一条队列，否则某一路断流（对方静音、系统没在放歌）
 * 会让整段录音的时间轴被挤歪。
 *
 * 系统音频**只进录音，不进通话上行**：电脑在放什么不该被发给对方。
 *
 * 写文件是流式的：先写 44 字节占位头，之后每帧追加，收尾回填长度。长通话不能把
 * 整段 PCM 攒在内存里（16 kHz 单声道一小时就是 ~115 MB）。
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { open } from 'node:fs/promises';

/** 一帧采样数（20 ms @ 16 kHz）。 */
export const RECORD_FRAME_SAMPLES = 320;
/** 一帧字节数（16-bit 单声道）。 */
export const RECORD_FRAME_BYTES = RECORD_FRAME_SAMPLES * 2;
/** 帧时长。 */
export const RECORD_FRAME_MS = 20;
/** 录音采样率。 */
export const RECORD_SAMPLE_RATE = 16_000;
/** 每路队列上限：100 ms。落后更多说明本机卡了，丢旧帧保时间轴。 */
const MAX_QUEUED_FRAMES = 5;
/** 系统音频的混音权重：它通常比人声大，压一档免得盖住对话。 */
const SYSTEM_GAIN = 0.7;

export type CallRecordingMode = 'self' | 'peer' | 'mixed';

export interface CallRecorderOptions {
  /** 写到哪里（调用方负责建目录）。 */
  path: string;
  mode: CallRecordingMode;
  /** 是否混入电脑声音。为 false 时 `pushSystem` 的数据被直接丢弃。 */
  systemAudio: boolean;
  /** 定时器，单测里换成手动推进的实现。 */
  timers?: CallRecorderTimers;
  /** 启动时刻（毫秒），默认 `Date.now()`。 */
  startedAt?: number;
}

export interface CallRecorderTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

export const realRecorderTimers: CallRecorderTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

/** 录音进行中的快照，界面用来画录音条。 */
export interface RecordingSnapshot {
  active: boolean;
  /** 开始时刻（毫秒）。 */
  startedAt: number;
  /** 已录时长（秒，向下取整）。 */
  durationSec: number;
  mode: CallRecordingMode;
  systemAudio: boolean;
}

export class CallRecorder {
  private readonly path: string;
  private readonly mode: CallRecordingMode;
  private readonly systemAudio: boolean;
  private readonly timers: CallRecorderTimers;
  private readonly startedAt: number;

  private stream: WriteStream | null = null;
  private timer: unknown = null;
  private active = false;
  /** 已写入文件的音频字节数（不含头），收尾时回填到 RIFF / data 长度。 */
  private dataBytes = 0;
  private writtenFrames = 0;

  /** 三路待混音的帧队列。 */
  private readonly selfQueue: Int16Array[] = [];
  private readonly peerQueue: Int16Array[] = [];
  private readonly systemQueue: Int16Array[] = [];

  constructor(options: CallRecorderOptions) {
    this.path = options.path;
    this.mode = options.mode;
    this.systemAudio = options.systemAudio;
    this.timers = options.timers ?? realRecorderTimers;
    this.startedAt = options.startedAt ?? this.timers.now();
  }

  get filePath(): string {
    return this.path;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** 打开文件、写占位头、启动 20 ms 泵。 */
  start(): void {
    if (this.active) return;
    const stream = createWriteStream(this.path, { flags: 'w' });
    // 写流是异步的：路径不可写（目录被删、盘满、权限不足）时错误从 'error' 事件
    // 出来，没有监听器会直接把整个主进程抛掉。这里接住并停掉录音 —— 一次录音
    // 失败不该带走通话本身。
    stream.on('error', (error) => {
      console.error('[call-recorder] 写录音文件失败', error);
      this.active = false;
      if (this.timer !== null) {
        this.timers.clearInterval(this.timer);
        this.timer = null;
      }
    });
    this.stream = stream;
    // 先写 44 字节的合法空 WAV 头：进程若在收尾前被杀，文件仍是「0 时长」而不是
    // 一坨没有头部的裸 PCM（后者连播放器都打不开）。
    stream.write(wavHeader(0));
    this.active = true;
    this.timer = this.timers.setInterval(() => this.pump(), RECORD_FRAME_MS);
  }

  /** 本端麦克风（上行）。长度不对的帧直接丢 —— 静音帧由泵补，不靠调用方。 */
  pushSelf(pcm: Uint8Array): void {
    this.push(this.selfQueue, pcm);
  }

  /** 对端音频（下行）。 */
  pushPeer(pcm: Uint8Array): void {
    this.push(this.peerQueue, pcm);
  }

  /** 电脑正在播放的声音。`systemAudio` 关掉时直接忽略。 */
  pushSystem(pcm: Uint8Array): void {
    if (!this.systemAudio) return;
    this.push(this.systemQueue, pcm);
  }

  /** 当前快照（未开始时 `active: false`，时长按 0 算）。 */
  snapshot(): RecordingSnapshot {
    return {
      active: this.active,
      startedAt: this.startedAt,
      durationSec: Math.floor(this.writtenFrames * (RECORD_FRAME_MS / 1000)),
      mode: this.mode,
      systemAudio: this.systemAudio,
    };
  }

  /** 收尾：停泵、关文件、回填 WAV 长度。幂等。 */
  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    if (this.timer !== null) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
    }
    const stream = this.stream;
    this.stream = null;
    this.selfQueue.length = 0;
    this.peerQueue.length = 0;
    this.systemQueue.length = 0;
    if (!stream) return;
    // 先把写流关干净，再做定位回填 —— 两边同时写同一个 fd 会互相盖。
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
    await this.finishHeader();
  }

  // ── 内部 ──

  private push(queue: Int16Array[], pcm: Uint8Array): void {
    if (!this.active) return;
    if (pcm.byteLength !== RECORD_FRAME_BYTES) return;
    // 队列满说明这一路断流了（对方静音 / 采集暂停），丢最旧的保持时间轴。
    if (queue.length >= MAX_QUEUED_FRAMES) queue.shift();
    queue.push(bytesToSamples(pcm));
  }

  /**
   * 20 ms 一拍：三路各取一帧，按模式合成后写盘。
   *
   * 缺帧一律补静音（而不是跳过这一拍）—— 跳过会让录音的采样计数与实际时间脱节，
   * 播放时越听越快。
   */
  private pump(): void {
    if (!this.active) return;
    const self = this.selfQueue.shift() ?? SILENCE;
    const peer = this.peerQueue.shift() ?? SILENCE;
    const system = this.systemAudio ? (this.systemQueue.shift() ?? SILENCE) : SILENCE;
    const mixed = mixFrame(self, peer, system, this.mode, this.systemAudio);
    const bytes = samplesToBytes(mixed);
    this.dataBytes += bytes.byteLength;
    this.writtenFrames += 1;
    this.stream?.write(bytes);
  }

  /**
   * 收尾时回填两个长度字段。
   *
   * 它们都在文件**开头**，所以不能用追加写：这里重新打开文件做定位写。失败只记
   * 日志 —— 录音内容本身已经落盘，长度不对顶多让播放器认为文件更长。
   */
  private async finishHeader(): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(this.path, 'r+');
      const riff = Buffer.alloc(4);
      riff.writeUInt32LE(36 + this.dataBytes, 0);
      await handle.write(riff, 0, 4, 4);
      const data = Buffer.alloc(4);
      data.writeUInt32LE(this.dataBytes, 0);
      await handle.write(data, 0, 4, 40);
    } catch (error) {
      console.error('[call-recorder] 回填 WAV 头失败', error);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}

const SILENCE = new Int16Array(RECORD_FRAME_SAMPLES);

/**
 * 按模式合成一帧。
 *
 * `mixed` 用饱和加法（clamp 到 int16 范围）而不是平均：平均会把两边都压掉一半，
 * 听起来比实际对话小声得多。叠系统音频时给它 0.7 的权重，避免音乐盖住人声。
 */
export function mixFrame(
  self: Int16Array,
  peer: Int16Array,
  system: Int16Array,
  mode: CallRecordingMode,
  systemAudio: boolean,
): Int16Array {
  if (mode === 'self') return self.slice();
  if (mode === 'peer') return peer.slice();
  const out = new Int16Array(RECORD_FRAME_SAMPLES);
  for (let i = 0; i < RECORD_FRAME_SAMPLES; i++) {
    let value = (self[i] ?? 0) + (peer[i] ?? 0);
    if (systemAudio) value += Math.round((system[i] ?? 0) * SYSTEM_GAIN);
    out[i] = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
  }
  return out;
}

/** 44 字节 PCM WAV 头。 */
function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = RECORD_SAMPLE_RATE * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(RECORD_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** 小端 16-bit 字节 → Int16 采样。 */
export function bytesToSamples(pcm: Uint8Array): Int16Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Int16Array(Math.floor(pcm.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** Int16 采样 → 小端 16-bit 字节。 */
export function samplesToBytes(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i] ?? 0, true);
  return out;
}
