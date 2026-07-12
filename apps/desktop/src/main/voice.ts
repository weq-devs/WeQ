/**
 * SILK voice decode for the media protocol.
 *
 * QQ stores PTT as Tencent SILK v3 (`.amr` extension, header `#!SILK_V3`,
 * preceded by a 1-byte flag). No browser plays SILK, so we decode to 24 kHz
 * mono PCM via `silk-wasm` and wrap it in a WAV container. Results cache under
 * `appData/cache/voice/<name>.wav`, so a clip decodes once and replays off disk.
 *
 * silk-wasm's wasm decoder only accepts `0x02` as that flag byte, but QQ also
 * emits clips with a `0x03` flag (both are valid Tencent SILK, they just decode
 * fine once normalized). `normalizeSilk` rewrites whatever precedes the magic
 * to a single `0x02`, so every variant reaches the decoder in the shape it wants.
 *
 * silk-wasm lives in this app's dependencies (not @weq/service) because the
 * wasm runtime belongs in the Electron main process.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { decode } from 'silk-wasm';
import { requirePlatform } from './context/app_context';

const SAMPLE_RATE = 24000;
const TRANSCRIBE_SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

const SILK_MAGIC = Buffer.from('#!SILK_V3');
const SILK_FLAG = 0x02;

/**
 * Normalize a Tencent SILK buffer so silk-wasm accepts it: the wasm decoder
 * only recognizes a `0x02` flag byte before the `#!SILK_V3` magic, but QQ also
 * ships clips flagged `0x03` (and potentially other bytes). Rewrite whatever
 * precedes the magic to exactly one `0x02`. If the magic isn't present, hand the
 * buffer back untouched and let the decoder fail as it would have.
 */
function normalizeSilk(silk: Buffer): Buffer {
  const idx = silk.indexOf(SILK_MAGIC);
  if (idx < 0) return silk;
  return Buffer.concat([Buffer.from([SILK_FLAG]), silk.subarray(idx)]);
}

/**
 * Decode the SILK file at `silkPath` to a cached WAV; returns the WAV path, or
 * null if the source is missing or decoding fails.
 */
export async function decodeSilkToWav(silkPath: string): Promise<string | null> {
  if (!silkPath || !existsSync(silkPath)) return null;

  const cacheDir = join(requirePlatform().appDataRoot(), 'cache', 'voice');
  const cachePath = join(cacheDir, `${basename(silkPath)}.wav`);
  if (existsSync(cachePath)) return cachePath;

  try {
    const silk = normalizeSilk(readFileSync(silkPath));
    const { data: pcm } = await decode(silk, SAMPLE_RATE);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, wrapWav(pcm));
    return cachePath;
  } catch (e) {
    console.error(`[voice] failed to decode SILK ${silkPath}:`, e);
    return null;
  }
}

/**
 * Decode the SILK file at `silkPath` directly to `destPath` (a `.wav`). Used by
 * the media export pipeline, which needs the WAV at a predictable bundle path
 * rather than the shared voice cache. Returns true on success.
 */
export async function decodeSilkToFile(silkPath: string, destPath: string): Promise<boolean> {
  if (!silkPath || !existsSync(silkPath)) return false;
  try {
    const silk = normalizeSilk(readFileSync(silkPath));
    const { data: pcm } = await decode(silk, SAMPLE_RATE);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, wrapWav(pcm));
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
  if (!silkPath || !existsSync(silkPath)) return null;
  try {
    const silk = normalizeSilk(readFileSync(silkPath));
    const { data: pcm } = await decode(silk, TRANSCRIBE_SAMPLE_RATE);
    return wrapWav(pcm, TRANSCRIBE_SAMPLE_RATE);
  } catch (e) {
    console.error(`[voice] failed to decode SILK ${silkPath} to 16k wav:`, e);
    return null;
  }
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
  return Buffer.concat([header, Buffer.from(pcm)]);
}
