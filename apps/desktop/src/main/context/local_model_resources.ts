import type { Platform } from '@weq/platform';
import {
  OcrModelService,
  VoiceTranscribeService,
  type ModelDownloadProgress,
  type UserConfigService,
} from '@weq/service';

/** 应用级模型仓库不依赖设置页或当前账号的生命周期。 */
export function createLocalModelResources(platform: Platform, config: UserConfigService) {
  const voiceTranscribe = new VoiceTranscribeService(platform);
  const ocrModels = new OcrModelService(platform);
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
