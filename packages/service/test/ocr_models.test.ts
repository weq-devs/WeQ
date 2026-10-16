import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { OCR_MODELS, OcrModelService, getOcrModel } from '../src/common/ocr_models';
import { VOICE_MODELS } from '../src/common/voice_transcribe';

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** 只用到 appDataRoot() 的最小 Platform 桩。 */
function platformAt(root: string): Platform {
  return { appDataRoot: () => root } as unknown as Platform;
}

function newService(): { service: OcrModelService; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'weq-ocr-models-'));
  roots.push(root);
  return { service: new OcrModelService(platformAt(root)), root };
}

/** 把某个模型的全部文件按注册表里的名字写到磁盘上（内容不关心，只看体积/状态）。 */
function materialize(service: OcrModelService, id: string, bytesPerFile = 16): void {
  const dir = service.resolveModelDir(id);
  mkdirSync(dir, { recursive: true });
  for (const f of getOcrModel(id)!.files)
    writeFileSync(join(dir, f.name), Buffer.alloc(bytesPerFile));
}

describe('OCR_MODELS registry', () => {
  it('has unique ids across the whole local-model namespace', () => {
    const ids = OCR_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 语音和图片模型共用 `<appDataRoot>/models/<id>` 这一个根，id 不能撞。
    for (const m of OCR_MODELS) expect(VOICE_MODELS.some((v) => v.id === m.id)).toBe(false);
  });

  it('describes every file with a unique key, name and https url', () => {
    const urls: string[] = [];
    for (const m of OCR_MODELS) {
      expect(m.files.length).toBeGreaterThan(0);
      expect(new Set(m.files.map((f) => f.key)).size).toBe(m.files.length);
      expect(new Set(m.files.map((f) => f.name)).size).toBe(m.files.length);
      for (const f of m.files) {
        expect(f.url.startsWith('https://')).toBe(true);
        urls.push(f.url);
      }
    }
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('weights sum to 1 and the size label matches sizeBytes', () => {
    for (const m of OCR_MODELS) {
      const sum = m.files.reduce((acc, f) => acc + f.weight, 0);
      expect(sum).toBeCloseTo(1, 9);
      const mb = m.sizeBytes / 1024 / 1024;
      expect(m.sizeLabel).toBe(`${mb.toFixed(1)} MB`);
    }
  });

  it('ships one filter model that only detects, and one full recognition model', () => {
    const filter = OCR_MODELS.filter((m) => m.kind === 'filter');
    expect(filter).toHaveLength(1);
    // 筛图只需要检测网络：不识别文字，也就不需要识别网络和字典。
    expect(filter[0]!.files.map((f) => f.key)).toEqual(['det']);
    expect(filter[0]!.languages).toEqual([]);

    const ocr = OCR_MODELS.filter((m) => m.kind === 'ocr');
    expect(ocr).toHaveLength(1);
    expect(ocr[0]!.files.map((f) => f.key).sort()).toEqual(['cls', 'det', 'dict', 'rec']);
  });
});

describe('OcrModelService', () => {
  it('reports nothing downloaded in an empty data root', () => {
    const { service } = newService();
    for (const m of service.listModels()) {
      expect(m.downloaded).toBe(false);
      expect(m.sizeOnDisk).toBe(0);
      expect(m.downloading).toBe(false);
    }
  });

  it('flips an entry to downloaded once every file is on disk', () => {
    const { service } = newService();
    const id = 'ppocr-v6-det-tiny';
    materialize(service, id, 8);
    const status = service.getModelStatus(id)!;
    expect(status.downloaded).toBe(true);
    expect(status.sizeOnDisk).toBe(status.files.length * 8);
    expect(service.isDownloading(id)).toBe(false);
  });

  it('stays undownloaded while a single file is missing', () => {
    const { service } = newService();
    const id = 'ppocr-v5-mobile';
    materialize(service, id);
    const dir = service.resolveModelDir(id);
    rmSync(join(dir, getOcrModel(id)!.files[0]!.name));
    expect(service.getModelStatus(id)!.downloaded).toBe(false);
  });

  it('resolves paths under <appDataRoot>/models/<id> keyed by file role', () => {
    const { service, root } = newService();
    const paths = service.resolveModelPaths('ppocr-v5-mobile');
    expect(paths.det).toBe(join(root, 'models', 'ppocr-v5-mobile', 'ch_PP-OCRv5_det_mobile.onnx'));
    expect(paths.dict).toBe(join(root, 'models', 'ppocr-v5-mobile', 'ppocrv5_dict.txt'));
  });

  it('deletes a downloaded model and filters the registry by kind', () => {
    const { service } = newService();
    materialize(service, 'ppocr-v6-det-tiny');
    expect(service.deleteModel('ppocr-v6-det-tiny')).toBe(true);
    expect(service.getModelStatus('ppocr-v6-det-tiny')!.downloaded).toBe(false);
    expect(service.deleteModel('does-not-exist')).toBe(true);

    expect(service.listByKind('filter').map((m) => m.id)).toEqual(['ppocr-v6-det-tiny']);
    expect(service.listByKind('ocr').map((m) => m.id)).toEqual(['ppocr-v5-mobile']);
    expect(service.getModel('nope')).toBeUndefined();
    expect(service.getModelStatus('nope')).toBeUndefined();
  });
});
