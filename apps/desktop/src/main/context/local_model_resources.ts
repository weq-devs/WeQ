import type { Platform } from '@weq/platform';
import {
  OcrModelService,
  VoiceTranscribeService,
  type ModelDownloadProgress,
  type LocalModelResources,
  type UserConfigService,
} from '@weq/service';

/** 完整的本地模型即可使用；旧空引用、已删除引用不再形成额外启用步骤。 */
export function reconcileLocalModelResources(resources: {
  voiceTranscribe: VoiceTranscribeService;
  ocrModels: OcrModelService;
  userConfig: UserConfigService;
}): void {
  const { voiceTranscribe, ocrModels, userConfig } = resources;
  const selected = userConfig.getSettings().modelResources;
  const voice = voiceTranscribe.listModels();
  const images = ocrModels.listModels();
  const patch: Partial<LocalModelResources> = {};
  for (const kind of ['voice', 'ocr', 'filter'] as const) {
    const models = kind === 'voice' ? voice : images.filter((m) => m.kind === kind);
    const available = models.filter((m) => m.downloaded && !m.downloading);
    const current = available.find((m) => m.id === selected[kind]);
    const model = current ?? available.find((m) => m.recommended) ?? available[0];
    const id = model?.id ?? '';
    if (selected[kind] !== id) patch[kind] = id;
  }
  if (Object.keys(patch).length) userConfig.setSettings({ modelResources: patch });
}

/** 应用级模型仓库不依赖设置页或当前账号的生命周期。 */
export function createLocalModelResources(platform: Platform, config: UserConfigService) {
  const voiceTranscribe = new VoiceTranscribeService(platform);
  const ocrModels = new OcrModelService(platform);
  reconcileLocalModelResources({ voiceTranscribe, ocrModels, userConfig: config });
  // 先于 IPC 订阅注册：界面收到成功终态时，共享引用已经持久化。
  voiceTranscribe.on('progress', (p: ModelDownloadProgress) => {
    if (p.done && !p.error && voiceTranscribe.getModelStatus(p.id)?.downloaded) {
      config.setSettings({ modelResources: { voice: p.id } });
    }
  });
  ocrModels.on('progress', (p: ModelDownloadProgress) => {
    if (!p.done || p.error) return;
    const model = ocrModels.getModelStatus(p.id);
    if (model?.downloaded) {
      config.setSettings({ modelResources: { [model.kind]: model.id } });
    }
  });
  return { voiceTranscribe, ocrModels };
}
