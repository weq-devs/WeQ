export const ENHANCEMENT_ENGINE_RECIPES = {
  onnx: {
    revision: 1,
    packages: {
      'onnxruntime-node': '1.30.0',
      'onnxruntime-common': '1.30.0',
      '@receptron/laya': '0.1.2',
      '@huggingface/tokenizers': '0.2.0',
    },
    targets: ['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'],
  },
  sherpa: {
    revision: 1,
    packages: { 'sherpa-onnx-node': '1.13.3' },
    targets: ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'],
  },
} as const;

export type EnhancementEngineKind = keyof typeof ENHANCEMENT_ENGINE_RECIPES;
export const ENHANCEMENT_PACK_IDS = ['text', 'voice', 'intent', 'dress'] as const;
export type EnhancementPackId = (typeof ENHANCEMENT_PACK_IDS)[number];

export interface EnhancementEngineFile {
  path: string;
  size: number;
  sha256: string;
  /** 同包内完全相同的动态库只传输、存储一次，安装时建立硬链接。 */
  link?: string;
}

export interface EnhancementEngineArtifact {
  kind: EnhancementEngineKind;
  id: string;
  compatibility: string;
  target: string;
  url: string;
  sha256: string;
  downloadBytes: number;
  installedBytes: number;
  files: EnhancementEngineFile[];
}

export interface EnhancementEngineManifest {
  schemaVersion: 1;
  target: string;
  engines: EnhancementEngineArtifact[];
}

export function enhancementEngineCompatibility(kind: EnhancementEngineKind): string {
  const recipe = ENHANCEMENT_ENGINE_RECIPES[kind];
  return `r${recipe.revision}-${Object.values(recipe.packages).join('-')}`;
}

export function safeEnhancementPath(path: string): boolean {
  return (
    !!path &&
    !/[\\:\0]/.test(path) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

export function parseEnhancementEngineManifest(value: unknown): EnhancementEngineManifest {
  const manifest = value as EnhancementEngineManifest | null;
  if (
    manifest?.schemaVersion !== 1 ||
    typeof manifest.target !== 'string' ||
    !/^(darwin|linux|win32)-(arm64|x64)$/.test(manifest.target) ||
    !Array.isArray(manifest.engines)
  )
    throw new Error('增强引擎清单格式无效');
  const kinds = new Set<string>();
  for (const artifact of manifest.engines) {
    if (
      !artifact ||
      !Object.hasOwn(ENHANCEMENT_ENGINE_RECIPES, artifact.kind) ||
      kinds.has(artifact.kind) ||
      artifact.compatibility !== enhancementEngineCompatibility(artifact.kind) ||
      artifact.target !== manifest.target ||
      typeof artifact.id !== 'string' ||
      !/^[a-zA-Z0-9._-]+$/.test(artifact.id) ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.downloadBytes) ||
      artifact.downloadBytes <= 0 ||
      artifact.downloadBytes > 256 * 1024 * 1024 ||
      !Number.isSafeInteger(artifact.installedBytes) ||
      artifact.installedBytes <= 0 ||
      artifact.installedBytes > 512 * 1024 * 1024 ||
      !Array.isArray(artifact.files) ||
      !artifact.files.length ||
      artifact.files.length > 2000
    )
      throw new Error('增强引擎版本或体积无效');
    const url = new URL(artifact.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('增强引擎下载地址无效');
    const files = new Map(artifact.files.map((file) => [file.path, file]));
    if (files.size !== artifact.files.length) throw new Error('增强引擎文件重复');
    let installedBytes = 0;
    for (const file of artifact.files) {
      if (
        typeof file.path !== 'string' ||
        !safeEnhancementPath(file.path) ||
        !file.path.startsWith('node_modules/') ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      )
        throw new Error('增强引擎文件清单无效');
      if (file.link !== undefined) {
        const source = files.get(file.link);
        if (
          !source ||
          source.link ||
          source.path === file.path ||
          source.sha256 !== file.sha256 ||
          source.size !== file.size
        )
          throw new Error('增强引擎共享文件无效');
      } else installedBytes += file.size;
    }
    if (installedBytes !== artifact.installedBytes) throw new Error('增强引擎安装体积不匹配');
    kinds.add(artifact.kind);
  }
  return manifest;
}
