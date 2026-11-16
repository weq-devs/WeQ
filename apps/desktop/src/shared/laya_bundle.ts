import type { ModelEntry } from '@weq/service';

// 意图模型（laya）的上游清单与文件身份。
//
// 这里只放纯常量与纯函数，**不要**引入任何运行时依赖：打包脚本
// （scripts/prepare-enhancement-engines.mjs）会在 electron-builder 的
// beforePack 阶段用 tsx 现场编译这个文件，一旦它拉进 `@weq/service` 那种
// 桶文件（上千个模块），Windows runner 上编译会久到把打包卡住。
// 需要用到 ModelStore 的下载逻辑放在 intent_sense/model_files.ts。

const MULTILINGUAL =
  'onnx-community/laya-multilingual-ONNX/resolve/46b77bbf5642fec5f14e540570228a8cbe8ab81f';
const ENGLISH = 'receptron/laya-onnx/resolve/d42786bdff8a7550316339c5fbf8f46caa83ea1b';

// 固定上游提交及 LFS 内容身份；外部权重保持图内引用的文件名。
export const LAYA_BUNDLE_SOURCES = [
  {
    repo: MULTILINGUAL,
    remote: 'onnx/model_fp16.onnx',
    local: 'laya.onnx',
    size: 3_572_287,
    sha256: '81f641e21289ddb2cd8ac774c1cddebfdb0fa7e4b183e49ad476d2faee46d98a',
  },
  {
    repo: MULTILINGUAL,
    remote: 'onnx/model_fp16.onnx_data',
    local: 'model_fp16.onnx_data',
    size: 643_817_472,
    sha256: '3c9eb52f5f795f76d7a681197228131fac7e92c3e5a4c90b68ec4065699ee4cf',
  },
  {
    repo: MULTILINGUAL,
    remote: 'tokenizer.json',
    local: 'tokenizer/tokenizer.json',
    size: 34_363_188,
    sha256: '609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f',
  },
  {
    repo: MULTILINGUAL,
    remote: 'tokenizer_config.json',
    local: 'tokenizer/tokenizer_config.json',
    size: 502,
    sha256: '424b69444bf7b5809dc2cd2e36d0bd71b8055124dd24274d6db3c655d38205e7',
  },
  {
    repo: ENGLISH,
    remote: 'laya_config.json',
    local: 'laya_config.json',
    size: 355,
    sha256: 'c4fab3dd16b6ffdb432ae99334c77fca31e1b4beb0b81be76ca45f707709706a',
  },
] as const;
export const LAYA_BUNDLE_BYTES = LAYA_BUNDLE_SOURCES.reduce((sum, file) => sum + file.size, 0);

export function layaModelEntry(mirror = false, id = 'laya-multilingual'): ModelEntry {
  const host = mirror ? 'https://hf-mirror.com' : 'https://huggingface.co';
  return {
    id,
    sizeBytes: LAYA_BUNDLE_BYTES,
    files: LAYA_BUNDLE_SOURCES.map((file) => ({
      key: file.local,
      name: file.local,
      url: `${host}/${file.repo}/${file.remote}`,
      sources: mirror
        ? [
            `https://hf-mirror.com/${file.repo}/${file.remote}`,
            `https://huggingface.co/${file.repo}/${file.remote}`,
          ]
        : [`${host}/${file.repo}/${file.remote}`],
      weight: file.size / LAYA_BUNDLE_BYTES,
      sizeBytes: file.size,
      sha256: file.sha256 || undefined,
    })),
  };
}
