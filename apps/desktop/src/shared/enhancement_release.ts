import semver from 'semver';
import { z } from 'zod';
import {
  ENHANCEMENT_PACK_IDS,
  ENHANCEMENT_RUNTIME,
  MARKET_EMOJI_ASSET,
  parseEnhancementEngineManifest,
  safeEnhancementPath,
  type EnhancementEngineArtifact,
  type EnhancementPackId,
} from './enhancement_manifest';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().refine((value) => semver.valid(value) !== null);
const url = z
  .string()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash;
  });
const file = z.object({
  key: z.string().min(1),
  name: z.string().refine(safeEnhancementPath),
  url,
  sources: z.array(url).min(1).max(8).optional(),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(4 * 1024 ** 3),
  sha256: hash,
});
export const ENHANCEMENT_MODEL_IDS = [
  'ppocr-v5-mobile',
  'ppocr-v6-det-tiny',
  'sensevoice',
  'laya-multilingual',
] as const;
const model = z.object({
  type: z.literal('model'),
  id: z.enum(ENHANCEMENT_MODEL_IDS),
  minWeqVersion: version.optional(),
  files: z.array(file).min(1).max(16),
});
const dressManifestBase = z.object({
  schemaVersion: z.literal(1),
  tag: z.string().regex(/^dress-[a-zA-Z0-9._-]+$/),
  baseUrl: url,
  parts: z.record(z.object({ asset: z.string(), sha256: hash, size: z.number().int().positive() })),
});
const dress = z.object({
  type: z.literal('dress'),
  manifest: z.discriminatedUnion('format', [
    dressManifestBase.extend({
      format: z.literal('ntdr-v1'),
      nativeCommit: z.string().regex(/^[a-f0-9]{40}$/),
    }),
    dressManifestBase.extend({
      format: z.literal('ntdr-v2'),
      keyId: z.string().regex(/^[a-f0-9]{32}$/),
    }),
  ]),
});
const engine = z.object({
  type: z.literal('engine'),
  artifact: z.custom<EnhancementEngineArtifact>(),
});
const marketEmoji = z.object({
  type: z.literal('market-emoji'),
  asset: z.object({
    name: z.enum([MARKET_EMOJI_ASSET, 'market.csv.gz']),
    url,
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 ** 2),
    sha256: hash,
  }),
});
const pack = z.object({
  id: z.enum(ENHANCEMENT_PACK_IDS),
  contentVersion: hash,
  minWeqVersion: version,
  runtime: z.string().min(1),
  unavailable: z.string().max(300).optional(),
  components: z
    .array(z.union([model, engine, dress, marketEmoji]))
    .min(1)
    .max(8),
});
const catalog = z.object({
  schemaVersion: z.literal(1),
  target: z.string().regex(/^(darwin|linux|win32)-(arm64|x64)$/),
  packs: z.array(pack).max(ENHANCEMENT_PACK_IDS.length),
});
export type EnhancementRelease = z.infer<typeof pack>;
export type EnhancementReleaseComponent = EnhancementRelease['components'][number];
export type EnhancementCatalog = z.infer<typeof catalog>;
export type MarketEmojiAsset = z.infer<typeof marketEmoji>['asset'];
export interface EnhancementUpdateNotice {
  id: EnhancementPackId;
  name: string;
  contentVersion: string;
}
export const PACK_RUNTIMES = {
  text: 'ppocr-v1',
  voice: 'sensevoice-v1',
  intent: 'laya-v1',
  dress: 'ntdr-v1',
  'market-emoji': 'market-csv-v1',
} as const;

function supportsRuntime(id: EnhancementPackId, runtime: string): boolean {
  return (
    runtime === PACK_RUNTIMES[id] ||
    (id === 'dress' && runtime === 'ntdr-v2') ||
    (id === 'market-emoji' && runtime === 'market-csv-gzip-v1')
  );
}

export function enhancementComponentId(component: EnhancementReleaseComponent): string {
  switch (component.type) {
    case 'model':
      return `model:${component.id}`;
    case 'engine':
      return `engine:${component.artifact?.kind}`;
    case 'dress':
      return 'dress:index';
    case 'market-emoji':
      return 'market-emoji:catalog';
  }
}

/** 先读取稳定头部，旧客户端也能说明新版为什么需要先升级 WeQ。 */
export function parseEnhancementCatalogForHost(
  input: unknown,
  current: string,
  target: string,
): EnhancementCatalog {
  const headers = z
    .object({
      schemaVersion: z.number().int().positive(),
      target: z.string(),
      packs: z
        .array(pack.omit({ components: true }).extend({ components: z.array(z.unknown()) }))
        .max(ENHANCEMENT_PACK_IDS.length),
    })
    .parse(input);
  if (headers.target !== target) throw new Error('增强包清单平台与当前宿主不匹配');
  if (new Set(headers.packs.map((entry) => entry.id)).size !== headers.packs.length)
    throw new Error('增强包发布描述重复');
  return {
    schemaVersion: 1,
    target,
    packs: headers.packs.map((entry) => {
      const unavailable =
        entry.unavailable ??
        (headers.schemaVersion !== 1
          ? '当前 WeQ 不支持此增强包清单格式，请先更新 WeQ'
          : !semver.valid(current) || semver.gt(entry.minWeqVersion, current)
            ? `需先更新 WeQ 至 v${entry.minWeqVersion}`
            : !supportsRuntime(entry.id, entry.runtime)
              ? '当前 WeQ 不支持此增强包运行接口，请先更新 WeQ'
              : undefined);
      if (unavailable)
        return {
          id: entry.id,
          contentVersion: entry.contentVersion,
          minWeqVersion: entry.minWeqVersion,
          runtime: entry.runtime,
          unavailable,
          components: [],
        };
      return parseEnhancementCatalog({ schemaVersion: 1, target, packs: [entry] }).packs[0]!;
    }),
  };
}

export function parseEnhancementCatalog(input: unknown): EnhancementCatalog {
  const result = catalog.parse(input);
  const seen = new Set<string>();
  for (const entry of result.packs) {
    if (seen.has(entry.id)) throw new Error('增强包发布描述重复');
    seen.add(entry.id);
    const ids = new Set<string>();
    for (const component of entry.components) {
      const id = enhancementComponentId(component);
      if (ids.has(id)) throw new Error('增强包组件重复');
      ids.add(id);
      if (component.type === 'engine')
        parseEnhancementEngineManifest({
          schemaVersion: 1,
          target: result.target,
          engines: [
            { ...component.artifact, runtime: ENHANCEMENT_RUNTIME[component.artifact.kind] },
          ],
        });
      if (
        component.type === 'engine' &&
        component.artifact.minWeqVersion &&
        (!semver.valid(component.artifact.minWeqVersion) ||
          semver.gt(component.artifact.minWeqVersion, entry.minWeqVersion))
      )
        throw new Error('增强包最低版本低于组件要求');
      if (component.type === 'dress') {
        if (entry.runtime !== component.manifest.format)
          throw new Error('装扮索引格式与运行接口不匹配');
        for (const kind of ['bubble', 'font', 'widget']) {
          const part = component.manifest.parts[kind];
          if (
            !part ||
            part.asset !== `dress-${kind}.dat` ||
            part.size < (component.manifest.format === 'ntdr-v2' ? 50 : 22) ||
            part.size > 64 * 1024 ** 2
          )
            throw new Error('装扮类别清单无效');
        }
      }
      if (
        component.type === 'market-emoji' &&
        (component.asset.name === 'market.csv.gz') !== (entry.runtime === 'market-csv-gzip-v1')
      )
        throw new Error('商城表情目录文件与运行接口不匹配');
      if (component.type === 'model') {
        if (component.minWeqVersion && semver.gt(component.minWeqVersion, entry.minWeqVersion))
          throw new Error('增强包最低版本低于模型要求');
        const keys = new Set(component.files.map((item) => item.key));
        const names = new Set(component.files.map((item) => item.name));
        if (keys.size !== component.files.length || names.size !== component.files.length)
          throw new Error('模型文件重复');
        const required = {
          'ppocr-v5-mobile': ['det', 'rec', 'cls', 'dict'],
          'ppocr-v6-det-tiny': ['det'],
          sensevoice: ['model', 'tokens'],
          'laya-multilingual': [
            'laya.onnx',
            'model_fp16.onnx_data',
            'tokenizer/tokenizer.json',
            'tokenizer/tokenizer_config.json',
            'laya_config.json',
          ],
        }[component.id];
        if (required.some((key) => !keys.has(key))) throw new Error('模型缺少运行所需文件');
      }
    }
    const required = {
      text: ['engine:onnx', 'model:ppocr-v5-mobile', 'model:ppocr-v6-det-tiny'],
      voice: ['engine:sherpa', 'model:sensevoice'],
      intent: ['engine:onnx', 'model:laya-multilingual'],
      dress: ['dress:index'],
      'market-emoji': ['market-emoji:catalog'],
    }[entry.id];
    if (ids.size !== required.length || required.some((id) => !ids.has(id)))
      throw new Error('增强包组件与能力不匹配');
  }
  return result;
}

export function enhancementReleaseBlocker(
  entry: EnhancementRelease,
  current: string,
  nativeCommit?: string,
  nativeKeys?: readonly string[],
): string | null {
  if (!semver.valid(current) || semver.gt(entry.minWeqVersion, current))
    return `需先更新 WeQ 至 v${entry.minWeqVersion}`;
  if (entry.unavailable) return entry.unavailable;
  if (!supportsRuntime(entry.id, entry.runtime))
    return '当前 WeQ 不支持此增强包运行接口，请先更新 WeQ';
  if (
    entry.components.some(
      (component) =>
        component.type === 'engine' &&
        component.artifact.runtime &&
        component.artifact.runtime !== ENHANCEMENT_RUNTIME[component.artifact.kind],
    )
  )
    return '当前 WeQ 不支持此增强引擎运行接口，请先更新 WeQ';
  const index = entry.components.find((component) => component.type === 'dress');
  if (index?.type === 'dress') {
    if (entry.runtime !== index.manifest.format) return '装扮索引格式与运行接口不匹配';
    const supported =
      index.manifest.format === 'ntdr-v2'
        ? nativeKeys?.includes(index.manifest.keyId)
        : nativeKeys !== undefined || index.manifest.nativeCommit === nativeCommit;
    if (!supported) return '此装扮索引需要配套的新版 WeQ 原生模块，请先更新 WeQ';
  }
  return null;
}
