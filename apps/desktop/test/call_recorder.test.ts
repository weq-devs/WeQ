import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CallRecorder,
  RECORD_FRAME_BYTES,
  RECORD_FRAME_MS,
  RECORD_FRAME_SAMPLES,
  RECORD_SAMPLE_RATE,
  bytesToSamples,
  mixFrame,
  samplesToBytes,
  type CallRecorderTimers,
} from '../src/main/call_recorder';

/** 手动推进的定时器：泵是 setInterval，测试里自己决定跑几拍。 */
function fakeTimers() {
  let interval: (() => void) | null = null;
  let now = 1_700_000_000_000;
  const timers: CallRecorderTimers = {
    setInterval: (fn) => {
      interval = fn;
      return 1;
    },
    clearInterval: () => {
      interval = null;
    },
    now: () => now,
  };
  return {
    timers,
    tick(times = 1) {
      for (let i = 0; i < times; i++) {
        interval?.();
        now += RECORD_FRAME_MS;
      }
    },
    stop: () => {
      interval = null;
    },
  };
}

/** 一个恒定为 `value` 的帧。 */
function constantFrame(value: number): Uint8Array {
  return samplesToBytes(new Int16Array(RECORD_FRAME_SAMPLES).fill(value));
}

const dirs: string[] = [];
async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'weq-call-rec-'));
  dirs.push(dir);
  return join(dir, 'rec.wav');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('混音', () => {
  const self = new Int16Array(RECORD_FRAME_SAMPLES).fill(1000);
  const peer = new Int16Array(RECORD_FRAME_SAMPLES).fill(2000);
  const system = new Int16Array(RECORD_FRAME_SAMPLES).fill(1000);

  it('仅本端 / 仅对方各取一路', () => {
    expect([...mixFrame(self, peer, system, 'self', false)]).toEqual([...self]);
    expect([...mixFrame(self, peer, system, 'peer', false)]).toEqual([...peer]);
  });

  it('双方叠加是饱和加法，不是平均', () => {
    // 平均会得到 1500，听起来比实际对话小声得多。
    expect(mixFrame(self, peer, system, 'mixed', false)[0]).toBe(3000);
  });

  it('叠加电脑声音时按 0.7 加权', () => {
    // 1000 + 2000 + round(1000 * 0.7) = 3700
    expect(mixFrame(self, peer, system, 'mixed', true)[0]).toBe(3700);
  });

  it('溢出被钳到 int16 范围', () => {
    const loud = new Int16Array(RECORD_FRAME_SAMPLES).fill(32000);
    expect(mixFrame(loud, loud, system, 'mixed', false)[0]).toBe(32767);
    const quiet = new Int16Array(RECORD_FRAME_SAMPLES).fill(-32000);
    expect(mixFrame(quiet, quiet, system, 'mixed', false)[0]).toBe(-32768);
  });
});

describe('CallRecorder', () => {
  it('写出的 WAV 头字段正确，且收尾回填长度', async () => {
    const path = await tempFile();
    const clock = fakeTimers();
    const recorder = new CallRecorder({
      path,
      mode: 'self',
      systemAudio: false,
      timers: clock.timers,
    });
    recorder.start();
    for (let i = 0; i < 5; i++) recorder.pushSelf(constantFrame(500));
    clock.tick(5);
    await recorder.stop();

    const wav = await readFile(path);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // 单声道
    expect(wav.readUInt32LE(24)).toBe(RECORD_SAMPLE_RATE);
    expect(wav.readUInt16LE(34)).toBe(16); // 16-bit
    const dataBytes = wav.readUInt32LE(40);
    expect(dataBytes).toBe(RECORD_FRAME_BYTES * 5);
    expect(wav.readUInt32LE(4)).toBe(36 + dataBytes);
    // 整个文件正好是头 + 数据，没有多余的字节。
    expect(wav.length).toBe(44 + dataBytes);
  });

  it('缺帧补静音，时间轴不会因为某一路断流被挤歪', async () => {
    const path = await tempFile();
    const clock = fakeTimers();
    const recorder = new CallRecorder({
      path,
      mode: 'mixed',
      systemAudio: false,
      timers: clock.timers,
    });
    recorder.start();
    // 只喂本端 3 帧，对端一帧都没有。
    for (let i = 0; i < 3; i++) recorder.pushSelf(constantFrame(1000));
    clock.tick(4);
    await recorder.stop();

    const wav = await readFile(path);
    // 4 拍就是 4 帧，不管有没有数据进来。
    expect(wav.readUInt32LE(40)).toBe(RECORD_FRAME_BYTES * 4);
    const pcm = bytesToSamples(new Uint8Array(wav.subarray(44)));
    expect(pcm[0]).toBe(1000); // 第 1 拍：本端有数据
    expect(pcm[RECORD_FRAME_SAMPLES]).toBe(1000); // 第 2 拍
    expect(pcm[RECORD_FRAME_SAMPLES * 2]).toBe(1000); // 第 3 拍
    expect(pcm[RECORD_FRAME_SAMPLES * 3]).toBe(0); // 第 4 拍：队列空了 → 静音
  });

  it('每路队列上限 5 帧，溢出丢最旧的', async () => {
    const path = await tempFile();
    const clock = fakeTimers();
    const recorder = new CallRecorder({
      path,
      mode: 'self',
      systemAudio: false,
      timers: clock.timers,
    });
    recorder.start();
    // 先灌 10 帧不同的值，再跑 1 拍：留下的是最后 5 帧里最旧的那一帧。
    for (let i = 1; i <= 10; i++) recorder.pushSelf(constantFrame(i * 100));
    clock.tick(1);
    await recorder.stop();

    const wav = await readFile(path);
    const pcm = bytesToSamples(new Uint8Array(wav.subarray(44)));
    expect(pcm[0]).toBe(600); // 第 6 帧（前 5 帧被丢掉）
  });

  it('systemAudio 关掉时 pushSystem 被忽略', async () => {
    const path = await tempFile();
    const clock = fakeTimers();
    const recorder = new CallRecorder({
      path,
      mode: 'self',
      systemAudio: false,
      timers: clock.timers,
    });
    recorder.start();
    recorder.pushSystem(constantFrame(9000));
    clock.tick(1);
    await recorder.stop();

    const wav = await readFile(path);
    const pcm = bytesToSamples(new Uint8Array(wav.subarray(44)));
    expect(pcm[0]).toBe(0);
  });

  it('长度不对的帧直接丢弃，不会把 PCM 写歪', async () => {
    const path = await tempFile();
    const clock = fakeTimers();
    const recorder = new CallRecorder({
      path,
      mode: 'self',
      systemAudio: false,
      timers: clock.timers,
    });
    recorder.start();
    recorder.pushSelf(new Uint8Array(10));
    clock.tick(1);
    await recorder.stop();

    const wav = await readFile(path);
    expect(wav.readUInt32LE(40)).toBe(RECORD_FRAME_BYTES);
  });

  it('stop 是幂等的，重复调用不会重复回填', async () => {
    const path = await tempFile();
    const clock = fakeTimers();
    const recorder = new CallRecorder({
      path,
      mode: 'self',
      systemAudio: false,
      timers: clock.timers,
    });
    recorder.start();
    recorder.pushSelf(constantFrame(1));
    clock.tick(2);
    await recorder.stop();
    await recorder.stop();
    const wav = await readFile(path);
    expect(wav.readUInt32LE(40)).toBe(RECORD_FRAME_BYTES * 2);
    expect(recorder.isActive).toBe(false);
  });

  it('snapshot 的时长按已写帧数算', async () => {
    const path = await tempFile();
    const clock = fakeTimers();
    const recorder = new CallRecorder({
      path,
      mode: 'self',
      systemAudio: false,
      timers: clock.timers,
      startedAt: 1000,
    });
    recorder.start();
    // 50 拍 = 1 秒
    clock.tick(50);
    expect(recorder.snapshot()).toMatchObject({ active: true, startedAt: 1000, durationSec: 1 });
    await recorder.stop();
  });
});
