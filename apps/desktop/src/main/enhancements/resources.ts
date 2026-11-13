import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import {
  DRESS_INDEX_KINDS,
  getDressIndexStore,
  subscribeDressIndexResources,
  type ModelStore,
  type ModelEntry,
  type ModelDownloadProgress,
  type OcrModelService,
  type VoiceTranscribeService,
  type UserConfigService,
  getLogger,
} from '@weq/service';
import type { IntentSenseLocalEngineControl } from '../context/app_context';
import { resolveResourceRoot } from '../resource';
import { runOcrEngine } from '../ocr/engine';
import { transcribeWav } from '../transcribe/engine';
import {
  layaBundleStore,
  LAYA_BUNDLE_SOURCES,
  LAYA_BUNDLE_BYTES,
  downloadLayaBundle,
} from '../intent_sense/model_files';
import { EnhancementEngineStore, readEnhancementEngineManifest } from './engine_store';
import { enhancementEngineBusy, setEnhancementEngineStore } from './engine_environment';
import { EnhancementPacks, type EnhancementComponent } from './packs';

function fileIdentity(paths: string[]): string {
  return paths
    .map((path) => {
      try {
        const file = statSync(path);
        return `${path}:${file.size}:${file.mtimeMs}`;
      } catch {
        return `${path}:missing`;
      }
    })
    .join('|');
}

export function createEnhancementResources(
  platform: Platform,
  userConfig: UserConfigService,
  resources: { voiceTranscribe: VoiceTranscribeService; ocrModels: OcrModelService },
  getIntentEngine: () => IntentSenseLocalEngineControl | null,
) {
  const root = platform.appDataRoot();
  const target = `${process.platform}-${process.arch}`;
  const resourceRoot = resolveResourceRoot();
  const developmentDirectory =
    resourceRoot && existsSync(join(resourceRoot, '../apps/desktop/package.json'))
      ? join(resourceRoot, '../apps/desktop')
      : undefined;
  const manifestPath = developmentDirectory
    ? join(developmentDirectory, '.artifacts/enhancements', target, 'manifest.json')
    : resourceRoot
      ? join(resourceRoot, '../enhancements/manifest.json')
      : '';
  let manifest: ReturnType<typeof readEnhancementEngineManifest> = null;
  try {
    manifest = manifestPath ? readEnhancementEngineManifest(manifestPath) : null;
  } catch (error) {
    getLogger().warn('enhancement engine manifest unavailable', {
      event: 'enhancement-manifest-invalid',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const engines = new EnhancementEngineStore(root, manifest, { developmentDirectory });
  setEnhancementEngineStore(engines);
  const components = new Map<string, EnhancementComponent>();
  for (const kind of ['onnx', 'sherpa'] as const) {
    components.set(`engine:${kind}`, {
      id: `engine:${kind}`,
      state: () => {
        const state = engines.state(kind);
        return {
          ready: state.ready,
          identity: state.identity,
          sizeOnDisk: state.installedBytes,
          downloadBytes: state.downloadBytes,
          updateAvailable: state.updateAvailable,
          blocker: !state.supported
            ? '当前平台没有此能力的兼容预编译引擎'
            : !state.available
              ? '增强引擎分发清单未准备，请更新应用或重新构建'
              : undefined,
        };
      },
      ensure: async (report) => {
        await engines.ensure(kind, (state) =>
          report({
            received: state.received,
            total: state.total,
            paused: state.paused,
            note: state.paused ? '下载已暂停' : '下载推理引擎',
          }),
        );
      },
      check: () => engines.checkExisting(kind),
      remove: () => engines.remove(kind),
      busy: () =>
        enhancementEngineBusy(kind) || (kind === 'onnx' && !!getIntentEngine()?.isBusy?.()),
      retained: () =>
        (!engines.state(kind).managed && engines.state(kind).ready) ||
        (kind === 'onnx' &&
          !!getIntentEngine()
            ?.listModels?.()
            .some((model) => model.id === 'QWeQ-NineBird-v1' && model.downloaded)),
      pause: () => engines.pause(kind),
      resume: () => engines.resume(kind),
    });
  }

  const addModel = <T extends ModelEntry>(store: ModelStore<T>, id: string) => {
    const model = store.getModel(id)!;
    const component: EnhancementComponent = {
      id: `model:${id}`,
      state: () => {
        const state = store.getModelStatus(id)!;
        const paths = store.resolveModelPaths(id);
        const downloadBytes = model.files.reduce((sum, file) => {
          try {
            const info = statSync(paths[file.key]!);
            if (
              info.isFile() &&
              info.size > 0 &&
              (file.sizeBytes === undefined || info.size === file.sizeBytes)
            )
              return sum;
          } catch {
            /* 尚未准备。 */
          }
          return sum + (file.sizeBytes ?? Math.round(model.sizeBytes * file.weight));
        }, 0);
        return {
          ready: state.downloaded,
          identity: fileIdentity(Object.values(paths)),
          sizeOnDisk: state.sizeOnDisk,
          downloadBytes,
        };
      },
      ensure: async (report) => {
        const initial = model.sizeBytes - component.state().downloadBytes;
        const progress = (p: ModelDownloadProgress) => {
          if (p.id === id)
            report({
              received: Math.max(0, p.downloadedBytes - initial),
              total: p.totalBytes - initial,
              paused: p.paused,
              note: p.paused ? '下载已暂停' : '下载模型文件',
            });
        };
        store.on('progress', progress);
        try {
          const result = await store.downloadModel(id);
          if (!result.success) throw new Error(result.error ?? '模型下载失败');
        } finally {
          store.off('progress', progress);
        }
      },
      check: async () => {
        if (!(await store.verifyModel(id))) throw new Error('已有模型校验失败，请重试下载');
      },
      remove: async () => {
        if (!store.deleteModel(id)) throw new Error('模型正在下载或无法删除，请稍后重试');
        const kind = id === 'sensevoice' ? 'voice' : id === 'ppocr-v6-det-tiny' ? 'filter' : 'ocr';
        userConfig.setSettings({ modelResources: { [kind]: '' } });
      },
      busy: () => store.isDownloading(id),
      pause: () => store.pauseDownload(id),
      resume: () => store.continueDownload(id),
    };
    components.set(component.id, component);
  };
  for (const model of resources.ocrModels.listModels()) addModel(resources.ocrModels, model.id);
  for (const model of resources.voiceTranscribe.listModels())
    addModel(resources.voiceTranscribe, model.id);

  const layaDir = join(root, 'models/laya-multilingual');
  components.set('model:laya-multilingual', {
    id: 'model:laya-multilingual',
    state: () => {
      const state = layaBundleStore(layaDir).getModelStatus('laya-multilingual')!;
      const present = LAYA_BUNDLE_SOURCES.reduce((sum, file) => {
        try {
          const info = statSync(join(layaDir, file.local));
          return sum + (info.isFile() && info.size === file.size ? file.size : 0);
        } catch {
          return sum;
        }
      }, 0);
      return {
        ready: state.downloaded,
        identity: fileIdentity(LAYA_BUNDLE_SOURCES.map((file) => join(layaDir, file.local))),
        sizeOnDisk: state.sizeOnDisk,
        downloadBytes: LAYA_BUNDLE_BYTES - present,
        blocker: getIntentEngine() ? undefined : '当前宿主不支持本地意图与画像引擎',
      };
    },
    ensure: async (report) => {
      const initial =
        LAYA_BUNDLE_BYTES - components.get('model:laya-multilingual')!.state().downloadBytes;
      await downloadLayaBundle({
        destDir: layaDir,
        mirror: userConfig.getSharedPreference('intent').hfMirror ?? true,
        onProgress: (p) =>
          report({
            received: Math.max(0, p.received - initial),
            total: p.total - initial,
            paused: p.paused,
            note: '准备意图与画像模型',
          }),
      });
    },
    check: async () => {
      if (!(await layaBundleStore(layaDir).verifyModel('laya-multilingual')))
        throw new Error('已有意图模型校验失败，请重试下载');
    },
    remove: async () => {
      const engine = getIntentEngine();
      if (engine?.isBusy?.()) throw new Error('意图或画像正在分析，请稍后删除');
      await engine?.stop();
      if (!layaBundleStore(layaDir).deleteModel('laya-multilingual'))
        throw new Error('意图模型无法删除，请稍后重试');
    },
    busy: () =>
      layaBundleStore(layaDir).isDownloading('laya-multilingual') ||
      !!getIntentEngine()?.isBusy?.(),
    pause: () => layaBundleStore(layaDir).pauseDownload('laya-multilingual'),
    resume: () => layaBundleStore(layaDir).continueDownload('laya-multilingual'),
  });

  const dress = getDressIndexStore(userConfig.cacheDir('dress_shared'));
  const inspected = dress?.inspect().catch(() => []);
  components.set('dress:index', {
    id: 'dress:index',
    state: () => {
      const states = dress?.snapshot() ?? [];
      const ready =
        states.length === DRESS_INDEX_KINDS.length &&
        states.every((state) => state.status === 'ready');
      const sizeOnDisk = states.reduce(
        (sum, state) => sum + (state.status === 'ready' ? state.totalBytes : 0),
        0,
      );
      return {
        ready,
        sizeOnDisk,
        downloadBytes: states.reduce(
          (sum, state) => sum + (state.status === 'ready' ? 0 : state.totalBytes),
          0,
        ),
        identity: `${dress?.manifest.tag ?? ''}:${fileIdentity(DRESS_INDEX_KINDS.map((kind) => join(dress?.directory ?? '', `${kind}.dat`)))}`,
        blocker: dress ? undefined : '装扮离线索引清单未准备',
      };
    },
    ensure: async (report) => {
      if (!dress) throw new Error('装扮离线索引清单未准备');
      await inspected;
      const initial = dress
        .snapshot()
        .reduce((sum, state) => sum + (state.status === 'ready' ? state.totalBytes : 0), 0);
      const total = dress.snapshot().reduce((sum, state) => sum + state.totalBytes, 0) - initial;
      const unsubscribe = subscribeDressIndexResources(({ store, state }) => {
        if (store !== dress) return;
        const received =
          dress.snapshot().reduce((sum, state) => sum + state.downloadedBytes, 0) - initial;
        report({
          received: Math.max(0, received),
          total,
          note: `准备${state.kind === 'bubble' ? '气泡' : state.kind === 'font' ? '字体' : '挂件'}索引`,
        });
      });
      try {
        for (const kind of DRESS_INDEX_KINDS)
          if (!(await dress.ensure(kind, true)))
            throw new Error(
              dress.snapshot().find((state) => state.kind === kind)?.error ?? '装扮索引下载失败',
            );
      } finally {
        unsubscribe();
      }
    },
    check: async () => {
      const states = await dress?.inspect();
      if (!states || states.some((state) => state.status !== 'ready'))
        throw new Error('已有装扮索引校验失败，请重试下载');
    },
    remove: async () => {
      await inspected;
      await dress?.remove();
    },
    busy: () => dress?.snapshot().some((state) => state.status === 'downloading') ?? false,
  });

  const packs = new EnhancementPacks(
    [
      {
        id: 'text',
        name: '本地文字识别',
        description: '在本机识别图片文字，并跳过无文字图片。',
        components: [
          'engine:onnx',
          ...resources.ocrModels.listModels().map((model) => `model:${model.id}`),
        ],
        validate: async () => {
          for (const model of resources.ocrModels.listModels()) {
            const paths = resources.ocrModels.resolveModelPaths(model.id);
            const result = await runOcrEngine({
              image: { width: 64, height: 64, data: Buffer.alloc(64 * 64 * 3, 255) },
              paths: { det: paths.det!, rec: paths.rec, cls: paths.cls, dict: paths.dict },
              mode: model.kind === 'filter' ? 'detect' : 'ocr',
              threads: 1,
            });
            if (!result.ok) throw new Error(result.error ?? '文字识别模型加载失败');
          }
        },
      },
      {
        id: 'voice',
        name: '本地语音转写',
        description: '在本机将语音转为文字，支持中、英、日、韩、粤语。',
        components: ['engine:sherpa', 'model:sensevoice'],
        validate: async () => {
          const paths = resources.voiceTranscribe.resolveModelPaths('sensevoice');
          const result = await transcribeWav(
            Buffer.alloc(44 + 16000 * 2),
            { model: paths.model!, tokens: paths.tokens! },
            { timeoutMs: 120_000 },
          );
          if (!result.success) throw new Error(result.error ?? '语音转写模型加载失败');
        },
      },
      {
        id: 'intent',
        name: '本地意图与画像',
        description: '在本机分析消息意图、情绪与互动画像。',
        components: ['engine:onnx', 'model:laya-multilingual'],
        validate: async () => {
          const control = getIntentEngine();
          if (control?.validateModel) return control.validateModel('laya-multilingual');
          const engine = control?.forModel?.('laya-multilingual');
          if (!engine || !(await engine.analyze('你好')))
            throw new Error('意图与画像模型实际加载失败，请检查资源后重试');
        },
      },
      {
        id: 'dress',
        name: '装扮离线索引',
        description: 'QQ 不在线时也能查询装扮地址；下载具体素材仍需网络。',
        components: ['dress:index'],
        validate: async () => {
          const states = await dress?.inspect();
          if (!states || states.some((state) => state.status !== 'ready'))
            throw new Error('装扮索引未完整准备');
        },
      },
    ],
    components,
    join(root, 'enhancements'),
  );
  return { packs, engines, inspected };
}
