// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDialogApi } from '../src/renderer/src/lib/dialogUtils';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  settings: vi.fn(),
  models: vi.fn(),
  resources: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: { getGroupAlbumAccessState: { query: mocks.access } },
    bootstrap: {
      getSettings: { query: mocks.settings },
      ocrModels: { query: mocks.models },
      localModelResources: { query: mocks.resources },
    },
  },
}));
import { ocrReadiness, preflightOcrImages } from '../src/renderer/src/views/export/preflight';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({
    qqOnline: true,
    attachEnabled: true,
    hasA2: true,
    hasD2: true,
    hasD2Key: true,
    hasGuid: true,
    ocrLocalModelId: null,
    ocrFilterModelId: 'downloaded-filter',
    ocrLocalBlocker: null,
  });
  mocks.settings.mockResolvedValue({ ocr: { modelId: '', filterModelId: '' } });
  mocks.models.mockResolvedValue({
    models: [{ id: 'downloaded-filter', kind: 'filter', downloaded: true }],
    engineBlocker: null,
  });
});

describe('导出 OCR 预检使用后台实际状态', () => {
  it('后台已就绪时不被旧设置快照误报为未下载', async () => {
    expect((await ocrReadiness()).filterReady).toBe(true);
    const confirm = vi.fn();
    expect(await preflightOcrImages({ confirm } as unknown as AppDialogApi)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
  });

  it('后台未找到可用模型时仍提示，不只看文件清单', async () => {
    mocks.access.mockResolvedValue({
      qqOnline: true,
      attachEnabled: true,
      hasA2: true,
      hasD2: true,
      hasD2Key: true,
      hasGuid: true,
      ocrFilterModelId: null,
      ocrLocalModelId: null,
      ocrLocalBlocker: null,
    });
    const confirm = vi.fn().mockResolvedValue(false);
    expect(await preflightOcrImages({ confirm } as unknown as AppDialogApi)).toBe(false);
    expect(confirm).toHaveBeenCalledWith('未下载筛图模型', expect.any(String), expect.any(Object));
  });

  it('引擎不可用时说明实际原因，不再要求重复下载', async () => {
    mocks.access.mockResolvedValue({
      qqOnline: true,
      attachEnabled: true,
      hasA2: true,
      hasD2: true,
      hasD2Key: true,
      hasGuid: true,
      ocrFilterModelId: null,
      ocrLocalModelId: null,
      ocrLocalBlocker: '本机没有推理引擎',
    });
    const confirm = vi.fn().mockResolvedValue(true);
    await preflightOcrImages({ confirm } as unknown as AppDialogApi);
    expect(confirm).toHaveBeenCalledWith(
      '无法使用本地筛图',
      expect.stringContaining('本机没有推理引擎'),
      expect.any(Object),
    );
  });

  it('账号状态读取失败时仍可用同一份共享资源快照判断本地模型', async () => {
    mocks.access.mockRejectedValue(new Error('账号尚未打开'));
    mocks.resources.mockResolvedValue({
      selected: { ocr: 'ocr', filter: 'filter' },
      engineBlocker: null,
      ocr: [
        { id: 'ocr', kind: 'ocr', downloaded: true, downloading: false },
        { id: 'filter', kind: 'filter', downloaded: true, downloading: false },
      ],
    });
    expect(await ocrReadiness()).toEqual({
      localReady: true,
      filterReady: true,
      onlineCapable: false,
      localEngineBlocker: null,
    });
    expect(mocks.settings).not.toHaveBeenCalled();
  });
});
