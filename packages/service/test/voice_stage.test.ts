/**
 * 语音转写阶段（`media_export.ts` 的 `transcribeFoundVoices`）的单测。
 *
 * 这一轮补的是「覆盖面」：以前只有**本机盘上找得到 SILK** 的语音才进转写阶段，于是
 * 库里已经存过的转写（QQ 自己转的 / 聊天里转过一次）会白丢，刚补下来的语音也不会被转写。
 * 这里钉住的四条：
 *
 *   1. 本机没有本体、但元素上已经有转写（45923）→ **白拿**，写进 `transcripts.json`；
 *   2. 本机没有本体、但在线的元数据齐全 → 在线那条腿照试（它只吃元数据，不要字节）；
 *   3. 本机没有本体、也能现取（`fetchSilk`）→ 取回来喂本地模型；
 *   4. 三样都不占 → 如实跳过（不是失败），并把条数说清楚。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef, MediaScanResult } from '../src/account/export/media_scan';
import { transcribeFoundVoices, TRANSCRIPTS_FILE } from '../src/account/export/media_export';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weq-voice-stage-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 一条语音引用；`path` 为空 = 本机没有本体。 */
function ptt(fileName: string, extra: Partial<MediaRef> = {}): MediaRef {
  return {
    msgId: '1',
    msgSeq: '1',
    sendTime: 1_700_000_000,
    kind: 'ptt',
    fileName,
    stem: fileName.toLowerCase().replace(/\.[^.]+$/, ''),
    fileToken: `token-${fileName}`,
    originalUrl: '',
    uploadTime: 0,
    uploadTimestamp: 0,
    fileTTL: 0,
    expiresAt: 0,
    expired: false,
    path: join(dir, fileName),
    online: {
      senderUin: '10001',
      peerUin: '10002',
      isGroup: true,
      md5: 'c'.repeat(32),
      duration: 3,
      size: 4096,
      format: 0,
      eventType: 0,
      fileId: 0,
    },
    ...extra,
  };
}

function scan(found: MediaRef[], missing: MediaRef[]): MediaScanResult {
  return {
    totalRefs: found.length + missing.length,
    uniqueFiles: found.length + missing.length,
    foundFiles: found.length,
    missingFiles: missing.length,
    expiredFiles: 0,
    downloadableFiles: missing.length,
    byKind: {
      pic: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
      video: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
      ptt: {
        refs: 0,
        unique: 0,
        found: found.length,
        missing: missing.length,
        expired: 0,
        downloadable: 0,
      },
      emoji: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
      file: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
    },
    found,
    missing,
    downloadList: missing,
    collectMs: 0,
    indexBuildMs: 0,
    matchMs: 0,
    durationMs: 0,
    indexedDirs: 0,
    indexedFiles: 0,
  };
}

function transcripts(): Record<string, string> {
  return JSON.parse(readFileSync(join(dir, TRANSCRIPTS_FILE), 'utf-8'));
}

describe('transcribeFoundVoices', () => {
  it('本机没有本体、但元素上已有转写 → 白拿进产物，不跑模型', async () => {
    const transcribe = vi.fn(async () => ({ ok: true as const, text: '不该被调用' }));
    const r = await transcribeFoundVoices(
      scan([], [ptt('gone.silk', { path: null, transcript: '以前转过的话' })]),
      dir,
      transcribe,
    );
    expect(transcribe).not.toHaveBeenCalled();
    expect(transcripts()).toEqual({ 'gone.silk': '以前转过的话' });
    expect(r).toMatchObject({ total: 1, ok: 1, failed: 0 });
  });

  it('本机没有本体、但在线元数据齐全 → 在线那条腿照试，结果也写回元素', async () => {
    const transcribe = vi.fn(async () => ({ ok: true as const, text: '本地' }));
    const onTranscribed = vi.fn(async () => undefined);
    const online = vi.fn(async (reqs: Array<{ fileName: string }>) => ({
      texts: Object.fromEntries(reqs.map((r) => [r.fileName, `在线-${r.fileName}`])),
      missing: [],
    }));

    const r = await transcribeFoundVoices(
      scan([], [ptt('net.silk', { path: null })]),
      dir,
      transcribe,
      undefined,
      2,
      onTranscribed,
      undefined,
      online,
    );

    expect(transcribe).not.toHaveBeenCalled();
    expect(online).toHaveBeenCalledTimes(1);
    expect(transcripts()).toEqual({ 'net.silk': '在线-net.silk' });
    expect(onTranscribed).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'net.silk' }),
      '在线-net.silk',
    );
    expect(r).toMatchObject({ total: 1, ok: 1, failed: 0 });
  });

  it('本机没有本体、能现取字节 → 取回来喂本地模型（在线没开也能补救）', async () => {
    const transcribe = vi.fn(async (silk: string) => ({ ok: true as const, text: `本地:${silk}` }));
    const fetchSilk = vi.fn(async () => '/tmp/fetched.silk');

    const r = await transcribeFoundVoices(
      scan([], [ptt('fetch.silk', { path: null })]),
      dir,
      transcribe,
      undefined,
      2,
      undefined,
      undefined,
      undefined,
      5,
      fetchSilk,
    );

    expect(fetchSilk).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith('/tmp/fetched.silk');
    expect(transcripts()).toEqual({ 'fetch.silk': '本地:/tmp/fetched.silk' });
    expect(r).toMatchObject({ total: 1, ok: 1, failed: 0 });
  });

  it('没有本体、也没有任何取回手段 → 跳过（不算失败），日志说清楚', async () => {
    const logs: string[] = [];
    const transcribe = vi.fn(async () => ({ ok: true as const, text: 'x' }));
    const r = await transcribeFoundVoices(
      scan([], [ptt('lost.silk', { path: null })]),
      dir,
      transcribe,
      undefined,
      2,
      undefined,
      (text) => logs.push(text),
    );
    expect(transcribe).not.toHaveBeenCalled();
    expect(transcripts()).toEqual({});
    expect(r).toMatchObject({ total: 1, ok: 0, failed: 0 });
    expect(logs.join('\n')).toContain('本机没有文件');
  });

  it('本机有本体的照旧：直接喂本地模型（在线的元数据也齐全时先试在线）', async () => {
    const transcribe = vi.fn(async (silk: string) => ({ ok: true as const, text: `本地:${silk}` }));
    const r = await transcribeFoundVoices(scan([ptt('local.silk')], []), dir, transcribe);
    expect(transcribe).toHaveBeenCalledWith(join(dir, 'local.silk'));
    expect(transcripts()).toEqual({ 'local.silk': `本地:${join(dir, 'local.silk')}` });
    expect(r).toMatchObject({ total: 1, ok: 1, failed: 0 });
  });

  it('现取失败 → 记失败并说清原因', async () => {
    const transcribe = vi.fn(async () => ({ ok: true as const, text: 'x' }));
    const r = await transcribeFoundVoices(
      scan([], [ptt('nope.silk', { path: null })]),
      dir,
      transcribe,
      undefined,
      2,
      undefined,
      undefined,
      undefined,
      5,
      async () => null,
    );
    expect(transcribe).not.toHaveBeenCalled();
    expect(r).toMatchObject({ total: 1, ok: 0, failed: 1 });
    expect(r.failures?.[0]?.error).toContain('取不回来');
    expect(transcripts()).toEqual({});
  });

  it('已过期的语音不去白下（CDN 直链都过期了），如实算「无源」', async () => {
    const fetchSilk = vi.fn(async () => '/tmp/x.silk');
    const transcribe = vi.fn(async () => ({ ok: true as const, text: 'x' }));
    const r = await transcribeFoundVoices(
      scan([], [ptt('old.silk', { path: null, expired: true })]),
      dir,
      transcribe,
      undefined,
      2,
      undefined,
      undefined,
      undefined,
      5,
      fetchSilk,
    );
    expect(fetchSilk).not.toHaveBeenCalled();
    expect(r).toMatchObject({ total: 1, ok: 0, failed: 0 });
  });
});
