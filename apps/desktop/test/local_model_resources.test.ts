// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import { UserConfigService, type ModelDownloadProgress } from '@weq/service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalModelResources,
  reconcileLocalModelResources,
} from '../src/main/context/local_model_resources';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-model-activation-'));
  roots.push(root);
  const platform = { appDataRoot: () => root } as unknown as Platform;
  const config = new UserConfigService(platform);
  return { platform, config, ...createLocalModelResources(platform, config) };
}

function stubDownloads(store: unknown) {
  // 只替换网络传输，文件清单、落盘检查与下载终态均走真实代码。
  return vi
    .spyOn(
      store as { downloadToFile(url: string, target: string): Promise<void> },
      'downloadToFile',
    )
    .mockImplementation(async (_url, target) => {
      writeFileSync(target, 'offline model fixture');
    });
}

describe('本地模型下载后自动选用', () => {
  it.each(['voice', 'ocr', 'filter'] as const)(
    '%s 旧下载没有选用记录也会自动可用',
    async (kind) => {
      const f = fixture();
      const store = kind === 'voice' ? f.voiceTranscribe : f.ocrModels;
      const model = store
        .listModels()
        .find((m) => kind === 'voice' || ('kind' in m && m.kind === kind))!;
      stubDownloads(store);
      await store.downloadModel(model.id);
      f.config.setSettings({ modelResources: { [kind]: '' } });
      createLocalModelResources(f.platform, f.config);
      expect(f.config.getLocalModelId(kind)).toBe(model.id);
      expect(f.config.getSettings().voiceTranscribe.autoTranscribe).toBe(false);
    },
  );

  it.each(['voice', 'ocr', 'filter'] as const)('%s 完成后先保存选择，再通知界面', async (kind) => {
    const f = fixture();
    const store = kind === 'voice' ? f.voiceTranscribe : f.ocrModels;
    const model = store
      .listModels()
      .find((m) => kind === 'voice' || ('kind' in m && m.kind === kind))!;
    f.config.setSettings({
      modelResources: { voice: 'old-voice', ocr: 'old-ocr', filter: 'old-filter' },
    });
    stubDownloads(store);
    const observed: string[] = [];
    store.on('progress', (p: ModelDownloadProgress) => {
      if (p.done) observed.push(f.config.getLocalModelId(kind));
    });
    expect(await store.downloadModel(model.id)).toEqual({ success: true });
    expect(observed).toEqual([model.id]);
    expect(new UserConfigService(f.platform).getLocalModelId(kind)).toBe(model.id);
    for (const other of ['voice', 'ocr', 'filter'] as const) {
      if (other !== kind) expect(f.config.getLocalModelId(other)).toBe(`old-${other}`);
    }
  });

  it('进度、失败和未知模型不改当前选择', async () => {
    const f = fixture();
    const model = f.voiceTranscribe.listModels()[0]!;
    f.config.setSettings({ modelResources: { voice: 'old-voice' } });
    f.voiceTranscribe.emit('progress', { id: model.id, percent: 50 });
    expect((await f.voiceTranscribe.downloadModel('unknown-model')).success).toBe(false);
    const download = stubDownloads(f.voiceTranscribe);
    download.mockRejectedValueOnce(new Error('下载失败'));
    expect((await f.voiceTranscribe.downloadModel(model.id)).success).toBe(false);
    expect(f.config.getLocalModelId('voice')).toBe('old-voice');
    await f.voiceTranscribe.downloadModel(model.id);
    expect(f.config.getLocalModelId('voice')).toBe(model.id);
  });

  it('未完整下载不启用；已下载模型自动可用，删除后解除引用且不影响其他用途', async () => {
    const f = fixture();
    const voice = f.voiceTranscribe.listModels()[0]!;
    mkdirSync(f.voiceTranscribe.resolveModelDir(voice.id), { recursive: true });
    writeFileSync(
      join(f.voiceTranscribe.resolveModelDir(voice.id), voice.files[0]!.name),
      'partial',
    );
    const sync = () => reconcileLocalModelResources({ ...f, userConfig: f.config });
    sync();
    expect(f.config.getLocalModelId('voice')).toBe('');
    stubDownloads(f.voiceTranscribe);
    stubDownloads(f.ocrModels);
    await f.voiceTranscribe.downloadModel(voice.id);
    const ocr = f.ocrModels.listByKind('ocr')[0]!;
    await f.ocrModels.downloadModel(ocr.id);
    f.voiceTranscribe.deleteModel(voice.id);
    sync();
    expect(f.config.getLocalModelId('voice')).toBe('');
    expect(f.config.getLocalModelId('ocr')).toBe(ocr.id);
    const write = vi.spyOn(f.config, 'setSettings');
    sync();
    expect(write).not.toHaveBeenCalled();
  });

  it('保留可用模型；当前模型消失时优先用已下载的推荐模型，不使用在途模型', () => {
    const f = fixture();
    const model = f.voiceTranscribe.listModels()[0]!;
    const a = { ...model, id: 'a', downloaded: true, recommended: false };
    const b = { ...model, id: 'b', downloaded: true, recommended: true };
    const list = vi
      .spyOn(f.voiceTranscribe, 'listModels')
      .mockReturnValue([{ ...model, id: 'in-flight', downloaded: true, downloading: true }, a, b]);
    const sync = () => reconcileLocalModelResources({ ...f, userConfig: f.config });
    sync();
    expect(f.config.getLocalModelId('voice')).toBe(b.id);
    f.config.setSettings({ modelResources: { voice: a.id } });
    sync();
    expect(f.config.getLocalModelId('voice')).toBe(a.id);
    list.mockReturnValue([b]);
    sync();
    expect(f.config.getLocalModelId('voice')).toBe(b.id);
  });
});
