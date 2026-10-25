/**
 * 「电脑正在播放的声音」采集，只服务于通话录音。
 *
 * 各平台的实现路径完全不同：
 *
 *   Linux    PulseAudio / PipeWire 的**监视源**（`@DEFAULT_MONITOR@`）就是「喇叭
 *            上正在放什么」。用 `parec` 起一个子进程直接吐裸 PCM，主进程按 640 字节
 *            切帧即可，不需要碰渲染层。PipeWire 的 `pipewire-pulse` 兼容这一套，
 *            所以 PipeWire 发行版同样可用。
 *
 *   Windows  Electron 的 `setDisplayMediaRequestHandler` 支持
 *            `audio: 'loopback'`（Electron 44 起仅 Windows），这条路只能在渲染层
 *            发起 `getDisplayMedia`。主进程负责放行，渲染层拿到音轨后切帧推回来。
 *
 *   macOS    没有系统音频采集能力（需要 BlackHole 之类的虚拟声卡），返回
 *            `unsupported`，界面把开关置灰。
 *
 * 采集到的数据**只进录音，不进通话上行** —— 电脑在放什么不该被发给对方。
 */

import { spawn, type ChildProcess } from 'node:child_process';

/** 界面要据此决定「电脑声音」开关能不能开。 */
export type SystemAudioCapability = 'native' | 'renderer' | 'unsupported';

/** 一帧 640 字节（20 ms @ 16 kHz 单声道 16-bit）。 */
const FRAME_BYTES = 640;

/** 当前平台的系统音频采集能力。 */
export function systemAudioCapability(
  platform: NodeJS.Platform = process.platform,
): SystemAudioCapability {
  if (platform === 'linux') return 'native';
  if (platform === 'win32') return 'renderer';
  return 'unsupported';
}

export interface SystemAudioCaptureOptions {
  /** 每切出一帧（640 字节）回调一次。 */
  onFrame(pcm: Uint8Array): void;
  /** 采集中断（进程退出 / 起不来）。调用方应据此关掉这一路并提示用户。 */
  onError(error: Error): void;
}

/**
 * Linux 的监视源采集。
 *
 * 用 `parec` 而不是自己走 libpulse：它是 `pulseaudio-utils` 自带的命令行工具，
 * 桌面发行版基本都装了，且能直接输出 16 kHz 单声道 s16le —— 与通话录音的格式
 * 完全一致，省掉一次重采样。
 */
export class LinuxSystemAudioCapture {
  private child: ChildProcess | null = null;
  /** 上一次 stdout 剩下的半帧。`parec` 的块大小不保证是 640 的整数倍。 */
  private pending: Buffer = Buffer.alloc(0);
  private failed = false;

  constructor(private readonly options: SystemAudioCaptureOptions) {}

  /** 启动采集。起不来（没有 parec / 没有监视源）时回调 onError 并返回 false。 */
  start(): boolean {
    if (this.child) return true;
    let child: ChildProcess;
    try {
      child = spawn(
        'parec',
        [
          '--device=@DEFAULT_MONITOR@',
          '--rate=16000',
          '--channels=1',
          '--format=s16le',
          '--no-remix',
          '--client-name=WeQ',
          '--stream-name=WeQ 通话录音',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk));
    child.on('error', (error) => this.fail(error));
    // 退出码非 0 才提示：用户主动 stop() 时我们先把 child 置空，走不到这里。
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (code && code !== 0) this.fail(new Error(`parec 退出（code=${code}）`));
    });
    // stderr 只接走，别让它把父进程的 stdio 撑满导致子进程阻塞。
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.warn('[call-system-audio] parec:', text);
    });
    return true;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.pending = Buffer.alloc(0);
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // 已经退了，忽略。
    }
  }

  private consume(chunk: Buffer): void {
    if (this.failed) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let offset = 0;
    while (this.pending.length - offset >= FRAME_BYTES) {
      const frame = this.pending.subarray(offset, offset + FRAME_BYTES);
      offset += FRAME_BYTES;
      this.options.onFrame(new Uint8Array(frame));
    }
    this.pending = offset > 0 ? Buffer.from(this.pending.subarray(offset)) : this.pending;
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.stop();
    this.options.onError(error);
  }
}
