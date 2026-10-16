/**
 * VoiceTranscribeService — 离线语音转录的**模型管理**（注册表 + 下载 / 状态 /
 * 路径 / 删除）。
 *
 * 下载与落盘的通用机制在 `common/model_store.ts`（和图片文字识别的模型共用同一套，
 * 见那里的说明）；这里只提供语音这一族的注册表与条目语义（引擎 / 语种）。
 *
 * 范围刻意保持窄、且**零原生**：真正的 sherpa-onnx 识别引擎是原生的，住在 app 侧
 * （`apps/desktop/src/main/transcribe/`）—— 和 silk-wasm 的分工一样（解码住 app，
 * 不在 `@weq/service`）。
 *
 * 模型落在 `<appDataRoot>/models/<id>/`，**故意不放在 cache 目录下** ——
 * 「清空缓存」不会把 245 MB 的模型一起清掉。
 *
 * 下载过程通过 `'progress'` 事件上报（{@link DownloadProgress}），IPC 层把它转成
 * tRPC 订阅。
 */

import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import {
  ModelStore,
  type ModelDiskState,
  type ModelDownloadProgress,
  type ModelEntry,
  type ModelFile,
} from './model_store';

/** One downloadable file within a model (the on-disk name + its source URL). */
export type TranscribeModelFile = ModelFile;

/** A transcription model the user can download and select. */
export interface TranscribeModelInfo extends ModelEntry {
  /** Stable id, also the on-disk directory name and the config value. */
  id: string;
  /** sherpa-onnx engine kind — drives the worker's recognizer config. */
  engine: 'sense-voice';
  /** Display name. */
  name: string;
  /** One-line description (languages, traits). */
  desc: string;
  /** Total download size in bytes (approximate, for the UI). */
  sizeBytes: number;
  /** Human label for the size (e.g. "245 MB"). */
  sizeLabel: string;
  /** Default language whitelist for this model. */
  languages: string[];
  /** Whether this is the recommended default. */
  recommended: boolean;
  /** Files that make up the model. */
  files: ModelFile[];
}

/** A model entry enriched with its on-disk / in-flight state. */
export type TranscribeModelStatus = TranscribeModelInfo & ModelDiskState;

/** Progress payload emitted during a download. */
export type DownloadProgress = ModelDownloadProgress;

const SENSEVOICE_BASE =
  'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master';

/**
 * The model registry. Adding a model is a registry-only change — the worker
 * already branches on `engine`, and the UI renders this list verbatim.
 */
export const VOICE_MODELS: TranscribeModelInfo[] = [
  {
    id: 'sensevoice',
    engine: 'sense-voice',
    name: 'SenseVoice Small',
    desc: '中 / 英 / 日 / 韩 / 粤，离线识别，速度快、体积适中',
    sizeBytes: 245_000_000,
    sizeLabel: '245 MB',
    languages: ['zh', 'yue', 'en', 'ja', 'ko'],
    recommended: true,
    files: [
      {
        key: 'model',
        name: 'model.int8.onnx',
        url: `${SENSEVOICE_BASE}/model.int8.onnx`,
        weight: 0.8,
      },
      { key: 'tokens', name: 'tokens.txt', url: `${SENSEVOICE_BASE}/tokens.txt`, weight: 0.2 },
    ],
  },
];

/** Look up a model in the registry by id. */
export function getVoiceModel(id: string): TranscribeModelInfo | undefined {
  return VOICE_MODELS.find((m) => m.id === id);
}

export class VoiceTranscribeService extends ModelStore<TranscribeModelInfo> {
  constructor(platform: Platform) {
    super(join(platform.appDataRoot(), 'models'), VOICE_MODELS);
  }
}
