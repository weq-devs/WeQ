import { createHash } from 'node:crypto';
import semver from 'semver';
import type { ModelEntry, DressIndexManifest } from '@weq/service';
import {
  ENHANCEMENT_RUNTIME_BASELINE,
  ENHANCEMENT_RUNTIME,
  type EnhancementEngineManifest,
} from '../../shared/enhancement_manifest';
import {
  PACK_RUNTIMES,
  ENHANCEMENT_MODEL_IDS,
  parseEnhancementCatalog,
  type EnhancementRelease,
  type EnhancementReleaseComponent,
  type EnhancementCatalog,
} from '../../shared/enhancement_release';

export function releaseContentVersion(components: EnhancementReleaseComponent[]): string {
  const identity = components.map((component) => {
    if (component.type === 'engine') {
      const item = component.artifact;
      return [
        'engine',
        item.kind,
        item.runtime ?? ENHANCEMENT_RUNTIME[item.kind],
        item.files.map((file) => [file.path, file.size, file.sha256, file.link]),
      ];
    }
    if (component.type === 'model')
      return [
        'model',
        component.id,
        component.files.map((file) => [file.key, file.name, file.sizeBytes, file.sha256]),
      ];
    if (component.type === 'market-emoji') {
      const { name, sizeBytes, sha256 } = component.asset;
      return ['market-emoji', name, sizeBytes, sha256];
    }
    return [
      'dress',
      component.manifest.format === 'ntdr-v2'
        ? component.manifest.keyId
        : component.manifest.nativeCommit,
      component.manifest.format,
      ['bubble', 'font', 'widget'].map((kind) => {
        const part = component.manifest.parts[kind]!;
        return [part.asset, part.size, part.sha256];
      }),
    ];
  });
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function modelReleaseComponent(model: ModelEntry): EnhancementReleaseComponent {
  const id = ENHANCEMENT_MODEL_IDS.find((id) => id === model.id);
  if (!id) throw new Error(`未知增强模型：${model.id}`);
  return {
    type: 'model',
    minWeqVersion: model.minWeqVersion ?? ENHANCEMENT_RUNTIME_BASELINE,
    id,
    files: model.files.map((file) => {
      if (!file.sizeBytes || !file.sha256)
        throw new Error(`模型缺少内容身份：${model.id}/${file.name}`);
      return {
        key: file.key,
        name: file.name,
        url: file.url,
        sources: file.sources,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      };
    }),
  };
}

export function createRelease(
  id: EnhancementRelease['id'],
  components: EnhancementReleaseComponent[],
  minWeqVersion = ENHANCEMENT_RUNTIME_BASELINE,
): EnhancementRelease {
  const component = components.find(
    (component) => component.type === 'dress' || component.type === 'market-emoji',
  );
  const runtime =
    component?.type === 'dress'
      ? component.manifest.format
      : component?.type === 'market-emoji' && component.asset.name === 'market.csv.gz'
        ? 'market-csv-gzip-v1'
        : PACK_RUNTIMES[id];
  const minimums = [
    minWeqVersion,
    ...components.flatMap((component) =>
      component.type === 'engine'
        ? [component.artifact.minWeqVersion ?? ENHANCEMENT_RUNTIME_BASELINE]
        : component.type === 'model'
          ? [component.minWeqVersion ?? ENHANCEMENT_RUNTIME_BASELINE]
          : [],
    ),
  ];
  return {
    id,
    contentVersion: releaseContentVersion(components),
    minWeqVersion: minimums.sort(semver.rcompare)[0]!,
    runtime,
    components,
  };
}

export function createEnhancementCatalog(
  engines: EnhancementEngineManifest,
  models: ModelEntry[],
  dress?: DressIndexManifest,
): EnhancementCatalog {
  const packs: EnhancementRelease[] = [];
  for (const [id, kind, ids] of [
    ['text', 'onnx', ['ppocr-v5-mobile', 'ppocr-v6-det-tiny']],
    ['voice', 'sherpa', ['sensevoice']],
    ['intent', 'onnx', ['laya-multilingual']],
  ] as const) {
    const artifact = engines.engines.find((engine) => engine.kind === kind);
    if (!artifact) continue;
    const components: EnhancementReleaseComponent[] = [
      { type: 'engine', artifact },
      ...ids.map((modelId) => {
        const model = models.find((entry) => entry.id === modelId);
        if (!model) throw new Error(`增强包缺少模型：${modelId}`);
        return modelReleaseComponent(model);
      }),
    ];
    packs.push(
      createRelease(id, components, artifact.minWeqVersion ?? ENHANCEMENT_RUNTIME_BASELINE),
    );
  }
  if (dress) packs.push(createRelease('dress', [{ type: 'dress', manifest: dress }]));
  return parseEnhancementCatalog({ schemaVersion: 1, target: engines.target, packs });
}
