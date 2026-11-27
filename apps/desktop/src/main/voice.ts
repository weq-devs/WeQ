/**
 * SILK voice codec for the media protocol (decode for playback/transcription,
 * encode for sending).
 *
 * QQ stores PTT as Tencent SILK v3 (`.amr` extension, header `#!SILK_V3`,
 * preceded by a 1-byte flag). No browser plays SILK, so we decode to 24 kHz
 * mono PCM via `silk-wasm` and wrap it in a WAV container. Results cache under
 * `appData/cache/voice`, keyed by source file revision, so concurrent players
 * share a decode and replays stream the previously generated WAV.
 *
 * silk-wasm's wasm decoder only accepts `0x02` as that flag byte, but QQ also
 * emits clips with a `0x03` flag (both are valid Tencent SILK, they just decode
 * fine once normalized). `normalizeSilk` rewrites whatever precedes the magic
 * to a single `0x02`, so every variant reaches the decoder in the shape it wants.
 *
 * silk-wasm lives in this app's dependencies (not @weq/service) because the
 * wasm runtime belongs in the Electron main process.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, type BigIntStats } from 'node:fs';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from '@weq/service/atomic-write';
import { encode as silkEncode, getDuration, isSilk } from 'silk-wasm';
import { requirePlatform } from './context/app_context';
import { decodeBackgroundVoice, decodePlayback } from './voice_playback_worker';

const SAMPLE_RATE = 24000;
const TRANSCRIBE_SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

const SILK_MAGIC = Buffer.from('#!SILK_V3');
const SILK_FLAG = 0x02;
const pendingPlayback = new Map<string, Promise<string | null>>();
const pendingBackground = new Map<string, Promise<Buffer | null>>();
let backgroundTail = Promise.resolve();

/**
 * Normalize a Tencent SILK buffer so silk-wasm accepts it: the wasm decoder
 * only recognizes a `0x02` flag byte before the `#!SILK_V3` magic, but QQ also
 * ships clips flagged `0x03` (and potentially other bytes). Rewrite whatever
 * precedes the magic to exactly one `0x02`. If the magic isn't present, hand the
 * buffer back untouched and let the decoder fail as it would have.
 */
function normalizeSilk(silk: Buffer): Buffer {
  const idx = silk.indexOf(SILK_MAGIC);
  if (idx < 0 || (idx === 1 && silk[0] === SILK_FLAG)) return silk;
  return Buffer.concat([Buffer.from([SILK_FLAG]), silk.subarray(idx)]);
}

/**
 * Does this file carry SILK (so it needs decoding before a browser can play it)?
 *
 * 只认魔数，不看扩展名 —— QQ 的语音落盘是 `.amr`，用户手选的文件可能是 `.silk`，
 * 也可能压根没扩展名。用魔数判断，非 SILK（wav/mp3/m4a…）直接流原文件。
 */
export async function isSilkFile(filePath: string, signal?: AbortSignal): Promise<boolean> {
  try {
    signal?.throwIfAborted();
    if (!filePath) return false;
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(32 * 1024 + 11);
      let carried = 0;
      let checkedHeader = false;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, carried, 32 * 1024, null);
        if (!bytesRead) return false;
        const size = carried + bytesRead;
        const bytes = buffer.subarray(0, size);
        if (!checkedHeader && size >= 7) {
          if (isWavMagic(bytes)) return false;
          if (isSilk(bytes.subarray(0, 7))) return true;
          checkedHeader = size >= 12;
        }
        if (bytes.includes(SILK_MAGIC)) return true;
        // QQ 的变体可能有前缀，保留跨块的魔数匹配。
        carried = checkedHeader ? Math.min(size, SILK_MAGIC.length - 1) : size;
        buffer.copyWithin(0, size - carried, size);
      }
    } finally {
      await handle.close();
    }
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

/**
 * Decode the SILK file at `silkPath` to a cached WAV; returns the WAV path, or
 * null if the source is missing or decoding fails.
 */
export async function decodeSilkToWav(silkPath: string): Promise<string | null> {
  if (!silkPath) return null;
  const source = resolve(silkPath);
  const info = await stat(source, { bigint: true }).catch(() => undefined);
  if (!info?.isFile()) return null;
  const original = voiceSourceRevision(info);
  const hash = createHash('sha256').update(source).update('\0').update(original).digest('hex');
  const cachePath = join(requirePlatform().appDataRoot(), 'cache', 'voice', `v2-${hash}.wav`);
  const pending = pendingPlayback.get(cachePath);
  if (pending) return pending;
  const task = cachedPlayback(source, original, cachePath).finally(() => {
    pendingPlayback.delete(cachePath);
  });
  pendingPlayback.set(cachePath, task);
  return task;
}

function voiceSourceRevision(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

async function cachedPlayback(
  source: string,
  revision: string,
  cachePath: string,
): Promise<string | null> {
  try {
    const cached = await stat(cachePath).catch(() => undefined);
    if (cached?.isFile() && cached.size > 44) return cachePath;
    const silk = normalizeSilk(await readFile(source));
    if (voiceSourceRevision(await stat(source, { bigint: true })) !== revision) return null;
    const pcm = await decodePlayback(silk, SAMPLE_RATE);
    await writeFileAtomic(cachePath, wrapWav(pcm));
    return cachePath;
  } catch (e) {
    console.error(`[voice] failed to decode SILK ${source}:`, e);
    return null;
  }
}

async function prepareBackgroundWav(silkPath: string, sampleRate: number): Promise<Buffer | null> {
  if (!silkPath) return null;
  const source = resolve(silkPath);
  const info = await stat(source, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info?.isFile()) return null;
  const revision = voiceSourceRevision(info);
  const key = JSON.stringify([source, revision, sampleRate]);
  const pending = pendingBackground.get(key);
  if (pending) return pending;

  // 等到轮到本条才读取文件，批量任务不会提前把待转换语音都留在内存中。
  const task = backgroundTail
    .then(async () => {
      const silk = normalizeSilk(await readFile(source));
      if (voiceSourceRevision(await stat(source, { bigint: true })) !== revision) return null;
      return wrapWav(await decodeBackgroundVoice(silk, sampleRate), sampleRate);
    })
    .finally(() => pendingBackground.delete(key));
  pendingBackground.set(key, task);
  backgroundTail = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/**
 * Decode the SILK file at `silkPath` directly to `destPath` (a `.wav`). Used by
 * the media export pipeline, which needs the WAV at a predictable bundle path
 * rather than the shared voice cache. Returns true on success.
 */
export async function decodeSilkToFile(silkPath: string, destPath: string): Promise<boolean> {
  try {
    const wav = await prepareBackgroundWav(silkPath, SAMPLE_RATE);
    if (!wav) return false;
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, wav);
    return true;
  } catch (e) {
    console.error(`[voice] failed to decode SILK ${silkPath} → ${destPath}:`, e);
    return false;
  }
}

/**
 * Decode the SILK file at `silkPath` to an in-memory 16 kHz mono WAV buffer for
 * voice transcription. SenseVoice expects 16 kHz, whereas the playback decoders
 * above use 24 kHz. Returns null if the source is missing or decoding fails.
 * Not cached — the WAV is consumed once by the recognizer worker.
 */
export async function decodeSilkToWav16kBuffer(silkPath: string): Promise<Buffer | null> {
  try {
    return await prepareBackgroundWav(silkPath, TRANSCRIBE_SAMPLE_RATE);
  } catch (e) {
    console.error(`[voice] failed to decode SILK ${silkPath} to 16k wav:`, e);
    return null;
  }
}

/**
 * 把一个本地音频文件编码成**可直接发送**的 SILK。
 *
 * 只认两种输入（其余一律明确报错，不猜、也不假装成功）：
 *   - WAV：交给 silk-wasm 自己解析（`sampleRate` 传 0 表示「按 WAV 头读」），
 *     顺便拿到真实时长 —— 时长是收端气泡宽度与文案的唯一依据；
 *   - 已经是 SILK 的文件：原样用，时长用 `getDuration` 现算。
 *
 * mp3/m4a 等压缩格式需要外部转换（仓库里没有 ffmpeg），这里如实告知。
 */
export async function encodeFileToSilk(
  filePath: string,
): Promise<{ silk: Uint8Array; durationSec: number; wav: Uint8Array | null }> {
  if (!filePath || !existsSync(filePath)) throw new Error(`音频文件不存在：${filePath}`);
  const bytes = readFileSync(filePath);
  if (bytes.length === 0) throw new Error(`音频文件是空的：${filePath}`);

  if (isSilk(bytes)) {
    const ms = getDuration(bytes);
    return {
      silk: new Uint8Array(bytes),
      durationSec: Math.max(1, Math.round(ms / 1000)),
      wav: null,
    };
  }

  if (!isWavMagic(bytes)) {
    throw new Error(
      `不认识的音频格式：${basename(filePath)}。语音只接受 WAV（会自动转 SILK）或已经是 SILK 的文件；` +
        'mp3/m4a 需要先用外部工具转成 WAV。',
    );
  }

  const { data, duration } = await silkEncode(bytes, 0);
  if (data.length === 0) throw new Error(`转 SILK 失败：${basename(filePath)}`);
  return {
    silk: new Uint8Array(data),
    durationSec: Math.max(1, Math.ceil(duration / 1000)),
    // WAV 原样带回去做波形（协议层按峰值抽样画条，不用解码依赖）。
    wav: new Uint8Array(bytes),
  };
}

/** 只看 RIFF/WAVE 魔数（不解析内容，交给 silk-wasm）。 */
function isWavMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

/** Prepend a 44-byte PCM WAV header to raw little-endian 16-bit PCM. */
function wrapWav(pcm: Uint8Array, sampleRate: number = SAMPLE_RATE): Buffer {
  const byteRate = (sampleRate * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
