/**
 * SILK voice decode for the media protocol.
 *
 * QQ stores PTT as Tencent SILK v3 (`.amr` extension, header `#!SILK_V3`,
 * sometimes with a 1-byte prefix — `silk-wasm` handles both). No browser plays
 * SILK, so we decode to 24 kHz mono PCM via `silk-wasm` and wrap it in a WAV
 * container. Results cache under `appData/cache/voice/<name>.wav`, so a clip
 * decodes once and replays off disk.
 *
 * silk-wasm lives in this app's dependencies (not @weq/service) because the
 * wasm runtime belongs in the Electron main process.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { decode } from 'silk-wasm';
import { requirePlatform } from './context/app_context';

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

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
    const silk = readFileSync(silkPath);
    const { data: pcm } = await decode(silk, SAMPLE_RATE);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, wrapWav(pcm));
    return cachePath;
  } catch (e) {
    console.error(`[voice] failed to decode SILK ${silkPath}:`, e);
    return null;
  }
}

/** Prepend a 44-byte PCM WAV header to raw little-endian 16-bit PCM. */
function wrapWav(pcm: Uint8Array): Buffer {
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}
