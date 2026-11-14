import semver from 'semver';
import { z } from 'zod';
import {
  ENHANCEMENT_PACK_IDS,
  ENHANCEMENT_RUNTIME,
  parseEnhancementEngineManifest,
  safeEnhancementPath,
  type EnhancementEngineArtifact,
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
const dress = z.object({
  type: z.literal('dress'),
  manifest: z.object({
    schemaVersion: z.literal(1),
    tag: z.string().regex(/^dress-[a-zA-Z0-9._-]+$/),
    nativeCommit: z.string().regex(/^[a-f0-9]{40}$/),
    format: z.literal('ntdr-v1'),
    baseUrl: url,
    parts: z.record(
      z.object({ asset: z.string(), sha256: hash, size: z.number().int().positive() }),
    ),
  }),
});
const engine = z.object({
  type: z.literal('engine'),
  artifact: z.custom<EnhancementEngineArtifact>(),
});
const pack = z.object({
  id: z.enum(ENHANCEMENT_PACK_IDS),
  contentVersion: hash,
  minWeqVersion: version,
  runtime: z.string().min(1),
  unavailable: z.string().max(300).optional(),
  components: z
    .array(z.union([model, engine, dress]))
    .min(1)
    .max(8),
});
const catalog = z.object({
  schemaVersion: z.literal(1),
  target: z.string().regex(/^(darwin|linux|win32)-(arm64|x64)$/),
  packs: z.array(pack).max(4),
});
export type EnhancementRelease = z.infer<typeof pack>;
export type EnhancementReleaseComponent = EnhancementRelease['components'][number];
export type EnhancementCatalog = z.infer<typeof catalog>;
export const PACK_RUNTIMES = {
  text: 'ppocr-v1',
  voice: 'sensevoice-v1',
  intent: 'laya-v1',
  dress: 'ntdr-v1',
} as const;

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
        .max(4),
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
            : entry.runtime !== PACK_RUNTIMES[entry.id]
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
      const id =
        component.type === 'model'
          ? `model:${component.id}`
          : component.type === 'engine'
            ? `engine:${component.artifact?.kind}`
            : 'dress:index';
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
        for (const kind of ['bubble', 'font', 'widget']) {
          const part = component.manifest.parts[kind];
          if (
            !part ||
            part.asset !== `dress-${kind}.dat` ||
            part.size < 22 ||
            part.size > 64 * 1024 ** 2
          )
            throw new Error('装扮类别清单无效');
        }
      }
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
): string | null {
  if (!semver.valid(current) || semver.gt(entry.minWeqVersion, current))
    return `需先更新 WeQ 至 v${entry.minWeqVersion}`;
  if (entry.unavailable) return entry.unavailable;
  if (entry.runtime !== PACK_RUNTIMES[entry.id])
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
  if (index?.type === 'dress' && index.manifest.nativeCommit !== nativeCommit)
    return '此装扮索引需要配套的新版 WeQ 原生模块，请先更新 WeQ';
  return null;
}
