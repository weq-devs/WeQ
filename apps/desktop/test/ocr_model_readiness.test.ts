// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import { OcrModelService, UserConfigService } from '@weq/service';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ bootstrap: null as unknown, blocker: null as string | null }));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  localOcrBlocker: () => state.blocker,
}));
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => state }));
vi.mock('../src/main/media_protocol', () => ({ handleMediaRequest: vi.fn() }));
vi.mock('../src/main/ocr/engine', () => ({ runOcrEngine: vi.fn() }));

import { resolveLocalOcrFilterModel, resolveLocalOcrModel } from '../src/main/ocr/local';

const roots: string[] = [];
afterEach(() => {
  state.bootstrap = null;
  state.blocker = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-ocr-ready-'));
  roots.push(root);
  const platform = { appDataRoot: () => root } as unknown as Platform;
  const userConfig = new UserConfigService(platform);
  const ocrModels = new OcrModelService(platform);
  state.bootstrap = { userConfig, ocrModels };
  function install(kind: 'ocr' | 'filter') {
    const model = ocrModels.listByKind(kind)[0]!;
    const dir = ocrModels.resolveModelDir(model.id);
    mkdirSync(dir, { recursive: true });
    for (const file of model.files) writeFileSync(join(dir, file.name), 'offline fixture');
    return model;
  }
  return { userConfig, ocrModels, install };
}

describe('本地 OCR 实际可用模型', () => {
  it('已下载筛图模型但引用为空时，自动启用且可直接取得检测路径', () => {
    const f = fixture();
    const model = f.install('filter');
    expect(f.userConfig.getLocalModelId('filter')).toBe('');
    expect(resolveLocalOcrFilterModel()).toEqual({
      modelId: model.id,
      det: f.ocrModels.resolveModelPaths(model.id).det,
    });
    expect(f.userConfig.getLocalModelId('filter')).toBe(model.id);
    expect(f.userConfig.getLocalModelId('ocr')).toBe('');
  });

  it('失效或用途错误的引用不遮蔽已下载的同用途模型', () => {
    const f = fixture();
    const model = f.install('ocr');
    f.userConfig.setSettings({ modelResources: { ocr: 'removed', filter: model.id } });
    expect(resolveLocalOcrModel()?.modelId).toBe(model.id);
    expect(resolveLocalOcrFilterModel()).toBeNull();
  });

  it('文件缺失、下载中或引擎不可用时不启用', () => {
    const f = fixture();
    expect(resolveLocalOcrModel()).toBeNull();
    expect(resolveLocalOcrFilterModel()).toBeNull();
    const model = f.install('filter');
    const list = vi
      .spyOn(f.ocrModels, 'listByKind')
      .mockReturnValue([{ ...f.ocrModels.getModelStatus(model.id)!, downloading: true }]);
    expect(resolveLocalOcrFilterModel()).toBeNull();
    list.mockRestore();
    state.blocker = '没有本地推理引擎';
    expect(resolveLocalOcrFilterModel()).toBeNull();
    expect(f.userConfig.getLocalModelId('filter')).toBe('');
  });
});
