// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encode } from 'silk-wasm';
import {
  decodeSilkToFile,
  decodeSilkToWav,
  decodeSilkToWav16kBuffer,
  isSilkFile,
} from '../src/main/voice';
import { decodeBackgroundVoice, decodePlayback } from '../src/main/voice_playback_worker';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/main/context/app_context', () => ({
  requirePlatform: () => ({ appDataRoot: () => state.root }),
}));
vi.mock('../src/main/voice_playback_worker', async (importOriginal) => {
  const codec = await importOriginal<typeof import('../src/main/voice_playback_worker')>();
  return {
    decodePlayback: vi.fn(codec.decodePlayback),
    decodeBackgroundVoice: vi.fn(codec.decodeBackgroundVoice),
  };
});

it('后台转换复用在途同源转写，导出与点播保留正确的采样率与 PCM', async () => {
  const source = join(state.root, 'clip.silk');
  const target = join(state.root, 'export', 'clip.wav');
  const noise = Int16Array.from({ length: 4800 }, (_, i) => (i % 31) * 1024 - 15_360);
  await writeFile(source, (await encode(noise, 24000)).data);
  const [first, second, exported, cached] = await Promise.all([
    decodeSilkToWav16kBuffer(source),
    decodeSilkToWav16kBuffer(source),
    decodeSilkToFile(source, target),
    decodeSilkToWav(source),
  ]);
  expect(first).toEqual(second);
  expect(first?.readUInt32LE(24)).toBe(16_000);
  expect(exported).toBe(true);
  const wav = await readFile(target);
  expect(wav.readUInt32LE(24)).toBe(24_000);
  expect(wav).toEqual(await readFile(cached!));
  expect(decodeBackgroundVoice).toHaveBeenCalledTimes(2);
  expect(decodePlayback).toHaveBeenCalledOnce();
});

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'weq-voice-playback-'));
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(state.root, { recursive: true, force: true });
});

it('并发只解码一次，跨来源同名文件和原路径替换各取自己的 WAV', async () => {
  const source = join(state.root, 'account-A', 'clip.amr');
  const other = join(state.root, 'account-B', 'clip.amr');
  const cache = join(state.root, 'cache', 'voice');
  const first = (await encode(new Int16Array(4800), 24000)).data;
  const noise = Int16Array.from({ length: 4800 }, (_, i) => (i % 31) * 1024 - 15_360);
  const second = (await encode(noise, 24000)).data;
  await Promise.all(
    [source, other, join(cache, 'clip.amr.wav')].map((p) => mkdir(dirname(p), { recursive: true })),
  );
  await Promise.all([
    writeFile(source, first),
    writeFile(other, second),
    writeFile(join(cache, 'clip.amr.wav'), 'legacy ambiguous output'),
  ]);

  const same = await Promise.all(Array.from({ length: 8 }, () => decodeSilkToWav(source)));
  expect(same[0]).toBeTruthy();
  expect(new Set(same).size).toBe(1);
  expect(decodePlayback).toHaveBeenCalledTimes(1);
  const original = await readFile(same[0]!);
  expect(original.toString('ascii', 0, 4)).toBe('RIFF');
  expect(original.readUInt32LE(24)).toBe(24_000);

  const otherWav = (await decodeSilkToWav(other))!;
  expect(otherWav).not.toBe(same[0]);
  expect(await readFile(otherWav)).not.toEqual(original);
  expect(await decodeSilkToWav(source)).toBe(same[0]);
  const replacement = source + '.replacement';
  await writeFile(replacement, second);
  await rename(replacement, source);
  const revised = (await decodeSilkToWav(source))!;
  expect(revised).not.toBe(same[0]);
  expect(await readFile(revised)).toEqual(await readFile(otherWav));
  expect(decodePlayback).toHaveBeenCalledTimes(3);
  expect((await readdir(cache)).some((name) => name.endsWith('.tmp'))).toBe(false);
});

it('异步识别保留带前缀的魔数，失败批次之后可以重试', async () => {
  const source = join(state.root, 'prefixed.silk');
  const ordinary = join(state.root, 'ordinary');
  const wave = join(state.root, 'container');
  const bytes = (await encode(new Int16Array(4800), 24000)).data;
  const magic = Buffer.from('#!SILK_V3');
  const offset = Buffer.from(bytes).indexOf(magic);
  expect(offset).toBeGreaterThanOrEqual(0);
  await writeFile(ordinary, Buffer.alloc(64 * 1024));
  await writeFile(
    wave,
    Buffer.concat([Buffer.from('RIFF0000WAVE'), Buffer.alloc(32 * 1024), magic]),
  );
  // 魔数横跨读取块，也必须被识别并规范化。
  await writeFile(source, Buffer.concat([Buffer.alloc(32 * 1024 - 4, 3), bytes.subarray(offset)]));
  expect(await isSilkFile(ordinary)).toBe(false);
  expect(await isSilkFile(wave)).toBe(false);
  expect(await isSilkFile(source)).toBe(true);
  vi.mocked(decodePlayback).mockRejectedValueOnce(new Error('synthetic decoder failure'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await Promise.all([decodeSilkToWav(source), decodeSilkToWav(source)])).toEqual([
    null,
    null,
  ]);
  expect(await decodeSilkToWav(source)).toBeTruthy();
  expect(decodePlayback).toHaveBeenCalledTimes(2);
});
