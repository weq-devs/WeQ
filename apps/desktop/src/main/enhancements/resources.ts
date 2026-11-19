import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import {
  DRESS_INDEX_KINDS,
  getDressIndexStore,
  subscribeDressIndexResources,
  type ModelStore,
  type ModelEntry,
  type OcrModelService,
  type VoiceTranscribeService,
  type UserConfigService,
  getLogger,
  getHost,
  type DressIndexManifest,
  parseDressIndexManifest,
} from '@weq/service';
import type { IntentSenseLocalEngineControl } from '../context/app_context';
import { resolveResourceRoot } from '../resource';
import { runOcrEngine } from '../ocr/engine';
import { transcribeWav } from '../transcribe/engine';
import { layaBundleStore, layaModelEntry } from '../intent_sense/model_files';
import { EnhancementEngineStore } from './engine_store';
import {
  enhancementEngineBusy,
  setEnhancementEngineStore,
  withEnhancementEngineDirectories,
  blockEnhancementEngineUse,
} from './engine_environment';
import { EnhancementPacks, type EnhancementComponent } from './packs';
import { createModelComponent } from './model_component';
import { releaseContentVersion } from './release_catalog';
import { EnhancementUpdateController } from './updates';
import { configureReleaseFeeds } from '../update/release_feed';
import { restoreEnhancementTasks, trackEnhancementPreparation } from './tasks';
import type { EnhancementEngineKind } from '../../shared/enhancement_manifest';

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

function fileBytes(paths: string[]): number {
  const seen = new Set<string>();
  return paths.reduce((total, path) => {
    try {
      const file = statSync(path);
      const key = `${file.dev}:${file.ino}`;
      if (!file.isFile() || seen.has(key)) return total;
      seen.add(key);
      return total + file.size;
    } catch {
      return total;
    }
  }, 0);
}
const dressFiles = (directory: string) =>
  DRESS_INDEX_KINDS.flatMap((kind) =>
    ['', '.incoming', '.incoming.part'].map((suffix) => join(directory, `${kind}.dat${suffix}`)),
  );

export function createEnhancementResources(
  platform: Platform,
  userConfig: UserConfigService,
  resources: { voiceTranscribe: VoiceTranscribeService; ocrModels: OcrModelService },
  getIntentEngine: () => IntentSenseLocalEngineControl | null,
) {
  const root = platform.appDataRoot();
  configureReleaseFeeds(root);
  const target = `${process.platform}-${process.arch}`;
  const resourceRoot = resolveResourceRoot();
  const developmentDirectory =
    resourceRoot && existsSync(join(resourceRoot, '../apps/desktop/package.json'))
      ? join(resourceRoot, '../apps/desktop')
      : undefined;
  const engines = new EnhancementEngineStore(root, null, { developmentDirectory });
  setEnhancementEngineStore(engines);
  const components = new Map<string, EnhancementComponent>();
  for (const kind of ['onnx', 'sherpa'] as const) {
    components.set(`engine:${kind}`, {
      id: `engine:${kind}`,
      name: kind === 'onnx' ? 'ONNX 推理引擎' : 'Sherpa 推理引擎',
      state: () => {
        const state = engines.state(kind);
        return {
          ready: state.ready,
          identity: state.identity,
          sizeOnDisk: state.installedBytes,
          downloadBytes: state.downloadBytes,
          updateAvailable: state.updateAvailable,
          blocker: !state.supported ? '当前平台没有此能力的兼容预编译引擎' : undefined,
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

  const layaDir = join(root, 'models/laya-multilingual');

  const dress = getDressIndexStore(userConfig.cacheDir('dress_shared'));
  const inspected = Promise.resolve()
    .then(() => dress?.inspect())
    .catch(() => []);
  components.set('dress:index', {
    id: 'dress:index',
    name: '装扮离线索引',
    inspect: async () => {
      await inspected;
    },
    state: () => {
      const states = dress?.snapshot() ?? [];
      const ready =
        states.length === DRESS_INDEX_KINDS.length &&
        states.every((state) => state.status === 'ready');
      const sizeOnDisk = dress ? fileBytes(dressFiles(dress.directory)) : 0;
      return {
        ready,
        installed: !!dress && existsSync(join(dress.directory, 'installed-manifest.json')),
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
          return withValidation(async () => {
            for (const model of resources.ocrModels.listModels()) {
              const paths = stagedModels.get(model.id)!.paths();
              const result = await runOcrEngine({
                image: { width: 64, height: 64, data: Buffer.alloc(64 * 64 * 3, 255) },
                paths: { det: paths.det!, rec: paths.rec, cls: paths.cls, dict: paths.dict },
                mode: model.kind === 'filter' ? 'detect' : 'ocr',
                threads: 1,
              });
              if (!result.ok) throw new Error(result.error ?? '文字识别模型加载失败');
            }
          });
        },
      },
      {
        id: 'voice',
        name: '本地语音转写',
        description: '在本机将语音转为文字，支持中、英、日、韩、粤语。',
        components: ['engine:sherpa', 'model:sensevoice'],
        validate: async () => {
          return withValidation(async () => {
            const paths = stagedModels.get('sensevoice')!.paths();
            const result = await transcribeWav(
              Buffer.alloc(44 + 16000 * 2),
              { model: paths.model!, tokens: paths.tokens! },
              { timeoutMs: 120_000 },
            );
            if (!result.success) throw new Error(result.error ?? '语音转写模型加载失败');
          });
        },
      },
      {
        id: 'intent',
        name: '本地意图与画像',
        description: '在本机分析消息意图、情绪与互动画像。',
        components: ['engine:onnx', 'model:laya-multilingual'],
        validate: async () => {
          return withValidation(async () => {
            const control = getIntentEngine();
            if (control?.validateModel)
              return control.validateModel(
                'laya-multilingual',
                stagedModels.get('laya-multilingual')!.directory(),
              );
            const engine = control?.forModel?.('laya-multilingual');
            if (!engine || !(await engine.analyze('你好')))
              throw new Error('意图与画像模型实际加载失败，请检查资源后重试');
          });
        },
      },
      {
        id: 'dress',
        name: '装扮离线索引',
        description: 'QQ 不在线时也能查询装扮地址；下载具体素材仍需网络。',
        components: ['dress:index'],
        validate: async () => {
          const states = await stagedDress?.inspect();
          if (!states || states.some((state) => state.status !== 'ready'))
            throw new Error('装扮索引未完整准备');
          if (
            !(await platform.native.ntHelper.validateDressResourceIndexes?.(stagedDress!.directory))
          )
            throw new Error('装扮索引无法被当前原生模块读取，请先更新 WeQ');
        },
      },
    ],
    components,
    join(root, 'enhancements'),
  );
  const stagedModels = new Map<string, ReturnType<typeof createModelComponent>>();
  for (const [store, ids] of [
    [resources.ocrModels, resources.ocrModels.listModels().map((model) => model.id)],
    [resources.voiceTranscribe, resources.voiceTranscribe.listModels().map((model) => model.id)],
    [layaBundleStore(layaDir), ['laya-multilingual']],
  ] as const) {
    for (const id of ids) {
      const item = createModelComponent(store as ModelStore<ModelEntry>, id, () =>
        id === 'laya-multilingual'
          ? !!getIntentEngine()?.isBusy?.()
          : enhancementEngineBusy(id === 'sensevoice' ? 'sherpa' : 'onnx'),
      );
      const state = item.component.state;
      if (id === 'laya-multilingual')
        item.component.state = () => ({
          ...state(),
          blocker: getIntentEngine() ? undefined : '当前宿主不支持本地意图与画像引擎',
        });
      const remove = item.component.remove;
      const activate = item.component.activate!;
      const cleanup = item.component.cleanup;
      let restartLaya = false;
      item.component.activate = async () => {
        if (id === 'laya-multilingual' && item.directory() !== store.resolveModelDir(id)) {
          restartLaya = getIntentEngine()?.runningModels?.().includes(id) ?? false;
          if (getIntentEngine()?.stopModel)
            await getIntentEngine()!.stopModel!(id, store.resolveModelDir(id));
          else await getIntentEngine()?.stop();
        }
        const undo = await activate();
        if (id === 'laya-multilingual') return undo;
        const kind = id === 'sensevoice' ? 'voice' : id === 'ppocr-v6-det-tiny' ? 'filter' : 'ocr';
        const previous = userConfig.getSettings().modelResources[kind];
        try {
          if (previous !== id) userConfig.setSettings({ modelResources: { [kind]: id } });
        } catch (error) {
          await undo();
          throw error;
        }
        return async () => {
          await undo();
          if (previous !== id) userConfig.setSettings({ modelResources: { [kind]: previous } });
        };
      };
      item.component.cleanup = async () => {
        await cleanup?.();
        if (restartLaya) {
          restartLaya = false;
          await getIntentEngine()?.startModel?.('laya-multilingual');
        }
      };
      if (id === 'laya-multilingual') {
        const select = item.component.select!;
        item.component.select = (entry) => {
          if (entry.type !== 'model') return select(entry);
          select({
            ...entry,
            files: entry.files.map((file) => {
              const url = new URL(file.url);
              if (url.hostname === 'huggingface.co' || url.hostname === 'hf-mirror.com')
                url.hostname =
                  userConfig.getSharedPreference('intent').hfMirror !== false
                    ? 'hf-mirror.com'
                    : 'huggingface.co';
              const mirror = userConfig.getSharedPreference('intent').hfMirror !== false;
              return {
                ...file,
                url: url.toString(),
                sources:
                  url.hostname === 'hf-mirror.com' || url.hostname === 'huggingface.co'
                    ? mirror
                      ? [
                          url.toString(),
                          url.toString().replace('://hf-mirror.com', '://huggingface.co'),
                        ]
                      : [url.toString()]
                    : file.sources,
              };
            }),
          });
        };
      }
      item.component.remove = async () => {
        if (id === 'laya-multilingual') await getIntentEngine()?.stop();
        await remove();
        if (id !== 'laya-multilingual') {
          const kind =
            id === 'sensevoice' ? 'voice' : id === 'ppocr-v6-det-tiny' ? 'filter' : 'ocr';
          userConfig.setSettings({ modelResources: { [kind]: '' } });
        }
      };
      stagedModels.set(id, item);
      components.set(item.component.id, item.component);
    }
  }
  const stagedEngines = new Map<EnhancementEngineKind, EnhancementEngineStore>();
  for (const kind of ['onnx', 'sherpa'] as const) {
    stagedEngines.set(kind, engines);
    const original = components.get(`engine:${kind}`)!;
    let oldDirectory: string | null = null;
    let runningModels: string[] = [];
    components.set(original.id, {
      ...original,
      installation: () => ({ type: 'engine', kind, id: engines.installedId(kind) }),
      select: (entry) => {
        if (entry.type !== 'engine' || entry.artifact.kind !== kind)
          throw new Error('引擎组件不匹配');
        const active = engines.directory(kind);
        const installed = engines.installedArtifact(kind);
        const unchanged =
          installed &&
          releaseContentVersion([{ type: 'engine', artifact: installed }]) ===
            releaseContentVersion([entry]);
        stagedEngines.set(
          kind,
          unchanged ||
            active?.endsWith(entry.artifact.id) ||
            (engines.state(kind).ready &&
              !engines.state(kind).managed &&
              entry.artifact.id === engines.artifact(kind)?.id)
            ? engines
            : new EnhancementEngineStore(
                root,
                { schemaVersion: 1, target, engines: [entry.artifact] },
                { stagingOnly: true },
              ),
        );
      },
      state: () => {
        const active = original.state();
        const candidate = stagedEngines.get(kind)!;
        return {
          ...active,
          sizeOnDisk: Math.max(active.sizeOnDisk, candidate.state(kind).installedBytes),
          downloadBytes: candidate.state(kind).downloadBytes,
          updateAvailable:
            candidate !== engines &&
            candidate.artifact(kind)?.id !== engines.directory(kind)?.split(/[\\/]/).at(-1),
        };
      },
      ensure: async (report) =>
        stagedEngines
          .get(kind)!
          .ensure(kind, (state) =>
            report({ ...state, pauseReasons: state.reasons, note: '准备推理引擎' }),
          )
          .then(() => {}),
      pause: () => stagedEngines.get(kind)!.pause(kind),
      resume: () => stagedEngines.get(kind)!.resume(kind),
      activate: async () => {
        const candidate = stagedEngines.get(kind)!;
        oldDirectory = null;
        runningModels = [];
        if (candidate === engines) return () => {};
        oldDirectory = engines.directory(kind);
        if (kind === 'onnx') runningModels = getIntentEngine()?.runningModels?.() ?? [];
        if (kind === 'onnx') await getIntentEngine()?.stop();
        return engines.adopt(candidate, kind);
      },
      cleanup: async () => {
        await engines.cleanPrevious(kind, oldDirectory);
        if (kind === 'onnx' && oldDirectory)
          for (const id of runningModels) await getIntentEngine()?.startModel?.(id);
      },
      remove: async () => {
        const candidate = stagedEngines.get(kind)!;
        if (candidate !== engines) await candidate.remove(kind);
        await original.remove();
      },
    });
  }
  let stagedDress = dress;
  let oldDressDirectory = '';
  if (dress) {
    const original = components.get('dress:index')!;
    components.set('dress:index', {
      ...original,
      installation: () => ({ type: 'dress', manifest: dress.manifest }),
      inspect: async () => {
        await inspected;
        await stagedDress!.inspectStored();
      },
      select: (entry) => {
        if (entry.type !== 'dress') throw new Error('装扮组件不匹配');
        stagedDress = dress.candidate(entry.manifest as DressIndexManifest);
      },
      state: () => {
        const active = original.state();
        return {
          ...active,
          sizeOnDisk: fileBytes([
            ...dressFiles(dress.directory),
            ...dressFiles(stagedDress!.directory),
          ]),
          requiresWeqUpdate:
            !platform.native.ntHelper.getBuildInfo?.().isDev &&
            (!platform.native.ntHelper.reloadDressResourceIndexes ||
              !platform.native.ntHelper.validateDressResourceIndexes),
          blocker:
            !platform.native.ntHelper.reloadDressResourceIndexes ||
            !platform.native.ntHelper.validateDressResourceIndexes
              ? '装扮索引更新需要新版 WeQ 原生模块，请先更新 WeQ'
              : active.blocker,
          updateAvailable: stagedDress!.manifest.tag !== dress.manifest.tag,
          downloadBytes: stagedDress!.snapshot().reduce((sum, state) => {
            const previous = dress.snapshot().find((item) => item.kind === state.kind);
            const oldPart = dress.manifest.parts[state.kind];
            const nextPart = stagedDress!.manifest.parts[state.kind];
            const reusable =
              previous?.status === 'ready' &&
              oldPart.size === nextPart.size &&
              oldPart.sha256 === nextPart.sha256;
            return sum + (state.status === 'ready' || reusable ? 0 : state.totalBytes);
          }, 0),
        };
      },
      ensure: async (report) => {
        await stagedDress!.inspect();
        const initial = stagedDress!
          .snapshot()
          .reduce((sum, state) => sum + state.downloadedBytes, 0);
        const total =
          stagedDress!.snapshot().reduce((sum, state) => sum + state.totalBytes, 0) - initial;
        const unsubscribe = subscribeDressIndexResources(({ store, state }) => {
          if (store !== stagedDress) return;
          report({
            received: Math.max(
              0,
              stagedDress!.snapshot().reduce((sum, item) => sum + item.downloadedBytes, 0) -
                initial,
            ),
            total,
            paused: state.paused,
            pauseReasons: state.pauseReasons,
            source: state.source,
            attempt: state.attempt,
            retryAt: state.retryAt,
            note: '准备装扮索引',
          });
        });
        try {
          for (const kind of DRESS_INDEX_KINDS)
            if (!(await stagedDress!.ensure(kind, true)))
              throw new Error(
                stagedDress!.snapshot().find((state) => state.kind === kind)?.error ??
                  '索引下载失败',
              );
        } finally {
          unsubscribe();
        }
      },
      pause: () => stagedDress!.pause(),
      resume: () => stagedDress!.resume(),
      activate: () => {
        oldDressDirectory = dress.directory;
        return dress.adopt(stagedDress!, platform.native.ntHelper);
      },
      cleanup: () => dress.cleanPrevious(oldDressDirectory),
      remove: async () => {
        await original.remove();
        if (!platform.native.ntHelper.getBuildInfo?.().isDev)
          platform.native.ntHelper.clearDressResourceIndexes?.();
      },
    });
  }
  function withValidation<T>(action: () => T): T {
    return withEnhancementEngineDirectories(
      Object.fromEntries(
        [...stagedEngines].flatMap(([kind, store]) => {
          const directory = store.directory(kind);
          return directory ? [[kind, directory]] : [];
        }),
      ),
      action,
    );
  }
  for (const definition of packs.definitions.filter(
    (pack) => pack.id === 'text' || pack.id === 'intent',
  )) {
    definition.validateShared = async () => {
      if (stagedEngines.get('onnx') === engines) return;
      await packs.list();
      for (const other of packs.definitions.filter(
        (pack) => pack.id !== definition.id && (pack.id === 'text' || pack.id === 'intent'),
      )) {
        await withValidation(async () => {
          if (other.id === 'intent') {
            if (!components.get('model:laya-multilingual')?.state().ready) return;
            return getIntentEngine()?.validateModel?.(
              'laya-multilingual',
              layaBundleStore(layaDir).resolveModelDir('laya-multilingual'),
            );
          }
          for (const model of resources.ocrModels
            .listModels()
            .filter((model) => components.get(`model:${model.id}`)?.state().ready)) {
            const paths = resources.ocrModels.resolveModelPaths(model.id);
            const result = await runOcrEngine({
              image: { width: 64, height: 64, data: Buffer.alloc(64 * 64 * 3, 255) },
              paths: { det: paths.det!, rec: paths.rec, cls: paths.cls, dict: paths.dict },
              mode: model.kind === 'filter' ? 'detect' : 'ocr',
              threads: 1,
            });
            if (!result.ok) throw new Error(result.error ?? '共享引擎无法加载已有识别模型');
          }
        });
      }
      if (
        getIntentEngine()
          ?.listModels?.()
          .some((model) => model.id === 'QWeQ-NineBird-v1' && model.downloaded)
      )
        await withValidation(() => getIntentEngine()?.validateModel?.('QWeQ-NineBird-v1'));
    };
  }
  for (const definition of packs.definitions.filter((pack) => pack.id !== 'dress')) {
    definition.lockActivation = async () => {
      const kinds = definition.components
        .filter((id) => id.startsWith('engine:'))
        .map((id) => id.slice(7) as EnhancementEngineKind);
      const unlock = blockEnhancementEngineUse(kinds);
      while (
        kinds.some((kind) => enhancementEngineBusy(kind)) ||
        (kinds.includes('onnx') && getIntentEngine()?.isBusy?.())
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      return unlock;
    };
  }
  // ready.json 是成套切换的提交点；中断留下的组件活动文件不能覆盖已提交的安装。
  try {
    const saved = JSON.parse(readFileSync(join(root, 'enhancements/ready.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    for (const definition of packs.definitions) {
      const receipt = saved[definition.id];
      if (!receipt) continue;
      if (typeof receipt === 'string') {
        try {
          const legacy = JSON.parse(receipt);
          if (Array.isArray(legacy))
            for (const pair of legacy) {
              if (
                Array.isArray(pair) &&
                (pair[0] === 'engine:onnx' || pair[0] === 'engine:sherpa') &&
                typeof pair[1] === 'string'
              ) {
                const id = pair[1].split(':')[0];
                if (id && !id.startsWith('development-'))
                  engines.restoreInstalled(pair[0] === 'engine:onnx' ? 'onnx' : 'sherpa', id);
              }
            }
        } catch {
          /* 未知旧回执保持原件，后续只检查实际资源。 */
        }
      }
      if (
        definition.id === 'dress' &&
        typeof receipt === 'object' &&
        (receipt as { removed?: unknown }).removed === true
      ) {
        dress?.disable();
        if (!platform.native.ntHelper.getBuildInfo?.().isDev)
          platform.native.ntHelper.clearDressResourceIndexes?.();
      }
      const snapshots =
        typeof receipt === 'object' &&
        Array.isArray((receipt as { components?: unknown }).components)
          ? (receipt as { components: Array<Record<string, unknown>> }).components
          : [];
      for (const id of definition.components.filter((id) => id.startsWith('model:'))) {
        const modelId = id.slice(6);
        const snapshot = snapshots.find((entry) => entry.type === 'model' && entry.id === modelId);
        const store =
          modelId === 'laya-multilingual'
            ? layaBundleStore(layaDir)
            : modelId === 'sensevoice'
              ? resources.voiceTranscribe
              : resources.ocrModels;
        store.restoreRevision(modelId, snapshot ?? { revision: null });
      }
      for (const snapshot of snapshots) {
        if (
          snapshot.type === 'engine' &&
          (snapshot.kind === 'onnx' || snapshot.kind === 'sherpa') &&
          typeof snapshot.id === 'string'
        )
          engines.restoreInstalled(snapshot.kind, snapshot.id);
        if (snapshot.type === 'dress' && dress) dress.restoreManifest(snapshot.manifest);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      getLogger().warn('enhancement installation restore failed', {
        event: 'enhancement-restore-failed',
        error: String(error),
      });
  }
  let bundledDress = dress?.manifest;
  if (resourceRoot) {
    try {
      bundledDress = parseDressIndexManifest(
        JSON.parse(readFileSync(join(resourceRoot, 'dress/index-manifest.json'), 'utf8')),
      );
    } catch {
      /* 保留已知的配套清单。 */
    }
  }
  const legacyModels = [
    ...resources.ocrModels
      .listModels()
      .map((model) => resources.ocrModels.registeredModel(model.id)!),
    ...resources.voiceTranscribe
      .listModels()
      .map((model) => resources.voiceTranscribe.registeredModel(model.id)!),
    layaModelEntry(),
  ];
  packs.observePreparations((id, name) => {
    void trackEnhancementPreparation(packs, id, name).catch(() => {});
  });
  restoreEnhancementTasks(packs, join(root, 'enhancements'));
  const updates = new EnhancementUpdateController(packs, userConfig, target, {
    legacyModels,
    currentVersion: () => getHost().appVersion(),
    nativeCommit: () =>
      platform.native.ntHelper.getDressResourceKeyId?.() ?? bundledDress?.nativeCommit,
    localDress: () => platform.native.ntHelper.getBuildInfo?.().isDev === true,
  });
  return { packs, engines, inspected, updates };
}
