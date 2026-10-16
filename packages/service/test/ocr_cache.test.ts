/**
 * 识别结果缓存（`src/common/ocr_cache.ts`）的单测。
 *
 * 盯的是四件事：
 *   1. **内容寻址**：键归一（大写 md5 → 小写）、认不出就不缓存（宁可少缓存，别拿错文字）；
 *   2. **多生产者共存**：在线与本地两份都留着，读的时候按偏好挑（换了模型不命中旧结果）；
 *   3. **写盘安全**：原子替换、坏档当未命中并清掉、同一个键并发写不丢更新；
 *   4. **落盘形状**：坐标系（frame）跟着结果一起存 —— 本地那条腿可能读到缩略图。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OcrBlock } from '@weq/protocol';
import { OCR_CACHE_SCHEMA_VERSION, OcrResultCache, ocrCacheKey } from '../src/common/ocr_cache';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weq-ocr-cache-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function block(text: string): OcrBlock {
  return {
    text,
    rect: { x: 10, y: 20, width: 100, height: 30 },
    quad: [
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 50 },
      { x: 10, y: 50 },
    ],
    parag: '{"Parag":{"ParagNo":1}}',
    field2: 97,
  };
}

const KEY = 'a'.repeat(32);
const FRAME = { width: 800, height: 600, variant: 'original' as const };

describe('键归一', () => {
  it('md5 大小写归一，太短 / 空的都不认', () => {
    expect(ocrCacheKey('ABCDEF0123456789ABCDEF0123456789')).toBe(
      'abcdef0123456789abcdef0123456789',
    );
    expect(ocrCacheKey('  AbC  ')).toBe(null);
    expect(ocrCacheKey('')).toBe(null);
    expect(ocrCacheKey(undefined)).toBe(null);
  });

  it('文件名 stem 就是 md5 时能用（QQ 自己的图片文件名就是这个形状）', () => {
    expect(ocrCacheKey('A1B2C3D4E5F60718293A4B5C6D7E8F90.jpg')).toBe(
      'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    );
    // 认不出的（路径之类）一律不缓存：撞键的代价是「拿错一张图的文字」
    expect(ocrCacheKey('../etc/passwd')).toBe(null);
  });
});

describe('读写与多生产者', () => {
  it('写进去能读回来（文字 + 坐标框 + 坐标系都留住）', async () => {
    const cache = new OcrResultCache(dir);
    await cache.putText(KEY, 'oidb', {
      text: '你好\n世界',
      blocks: [block('你好'), block('世界')],
      frame: FRAME,
      lang: 'zh',
      elapsedMs: 120,
      ids: { elementMd5: KEY, fileName: `${KEY}.jpg` },
    });

    const hit = await cache.getText(KEY);
    expect(hit).toMatchObject({ text: '你好\n世界', source: 'oidb', lang: 'zh', frame: FRAME });
    expect(hit?.blocks).toHaveLength(2);
    expect(hit?.blocks?.[1].text).toBe('世界');

    // 落盘是明文 JSON（出问题能直接看），帧信息在记录里
    const raw = JSON.parse(readFileSync(join(dir, KEY.slice(0, 2), `${KEY}.json`), 'utf-8'));
    expect(raw.schemaVersion).toBe(OCR_CACHE_SCHEMA_VERSION);
    expect(raw.texts.oidb.frame).toEqual(FRAME);
    expect(raw.ids.fileName).toBe(`${KEY}.jpg`);
  });

  it('在线与本地两份并存：auto 取在线，local 只取本地，换模型不命中旧结果', async () => {
    const cache = new OcrResultCache(dir);
    await cache.putText(KEY, 'local:ppocr-v5-mobile', {
      text: '本地结果',
      frame: { width: 720, height: 540, variant: 'thumb' },
      modelId: 'ppocr-v5-mobile',
    });
    expect((await cache.getText(KEY))?.text).toBe('本地结果');

    await cache.putText(KEY, 'oidb', { text: '在线结果', frame: FRAME, lang: 'zh' });
    // auto：在线优先（精度高一档），但本地那份仍在记录里
    expect((await cache.getText(KEY))?.text).toBe('在线结果');
    const local = await cache.getText(KEY, 'local');
    expect(local?.text).toBe('本地结果');
    expect(local?.frame).toEqual({ width: 720, height: 540, variant: 'thumb' });
    expect(await cache.producers(KEY)).toEqual(['local:ppocr-v5-mobile', 'oidb']);

    // 换识别模型：新模型那份才是 local 偏好下最新的
    await cache.putText(KEY, 'local:ppocr-v6-server', {
      text: '新模型结果',
      frame: FRAME,
      modelId: 'ppocr-v6-server',
    });
    const newer = await cache.getText(KEY, 'local');
    expect(newer?.text).toBe('新模型结果');
    expect(newer?.modelId).toBe('ppocr-v6-server');
  });

  it('只给在线 / 只给本地偏好时不拿另一条腿顶替', async () => {
    const cache = new OcrResultCache(dir);
    await cache.putText(KEY, 'local:ppocr-v5-mobile', {
      text: '本地结果',
      frame: FRAME,
      modelId: 'ppocr-v5-mobile',
    });
    expect(await cache.getText(KEY, 'oidb')).toBe(null);
  });

  it('筛图结论按模型分格（换模型就要重新判）', async () => {
    const cache = new OcrResultCache(dir);
    await cache.putFilter(KEY, 'ppocr-v6-det-tiny', { hasText: false, boxes: 0 });
    expect(await cache.getFilter(KEY, 'ppocr-v6-det-tiny')).toMatchObject({ hasText: false });
    expect(await cache.getFilter(KEY, 'ppocr-v5-det-mobile')).toBe(null);
  });
});

describe('健壮性', () => {
  it('坏档当未命中，并顺手清掉（不炸调用方）', async () => {
    const cache = new OcrResultCache(dir);
    await cache.putText(KEY, 'oidb', { text: '好结果', frame: FRAME });
    writeFileSync(join(dir, KEY.slice(0, 2), `${KEY}.json`), '{ 这不是 JSON');

    const second = new OcrResultCache(dir); // 换个实例，别吃内存里的那份
    expect(await second.getText(KEY)).toBe(null);
    await second.putText(KEY, 'oidb', { text: '重写', frame: FRAME });
    expect((await new OcrResultCache(dir).getText(KEY))?.text).toBe('重写');
  });

  it('同一个键并发写不会丢更新（读-改-写串行）', async () => {
    const cache = new OcrResultCache(dir);
    await Promise.all([
      cache.putText(KEY, 'oidb', { text: '在线结果', frame: FRAME }),
      cache.putFilter(KEY, 'ppocr-v6-det-tiny', { hasText: true, boxes: 3 }),
      cache.putText(KEY, 'local:ppocr-v5-mobile', {
        text: '本地结果',
        frame: FRAME,
        modelId: 'ppocr-v5-mobile',
      }),
    ]);

    const fresh = new OcrResultCache(dir);
    expect((await fresh.getText(KEY))?.text).toBe('在线结果');
    expect((await fresh.getText(KEY, 'local'))?.text).toBe('本地结果');
    expect(await fresh.getFilter(KEY, 'ppocr-v6-det-tiny')).toMatchObject({ boxes: 3 });
  });

  it('坐标框过大时只留文字（超长截图别把缓存撑成几 MB）', async () => {
    const cache = new OcrResultCache(dir, { blocksLimitBytes: 1024 });
    const blocks = Array.from({ length: 40 }, (_v, i) => block(`第 ${i} 行`));
    await cache.putText(KEY, 'local:ppocr-v5-mobile', {
      text: '很多行',
      blocks,
      frame: FRAME,
      modelId: 'ppocr-v5-mobile',
    });

    const hit = await cache.getText(KEY, 'local');
    expect(hit?.text).toBe('很多行');
    expect(hit?.blocks).toBeUndefined();
    expect(hit?.blocksOmitted).toBe(true);
  });

  it('不存在的键读出来是 null，不抛错', async () => {
    const cache = new OcrResultCache(dir);
    expect(await cache.getText('b'.repeat(32))).toBe(null);
    expect(await cache.getText('')).toBe(null);
  });
});
