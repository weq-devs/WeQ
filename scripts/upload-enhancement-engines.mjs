import { execFileSync } from 'node:child_process';
import { readFile, copyFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashEnhancementFile } from './prepare-enhancement-engines.mjs';
import { tsImport } from 'tsx/esm/api';
import { findReleaseByTag } from './release-control.mjs';

const directory = join(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/desktop/.artifacts/enhancements',
  `${process.platform}-${process.arch}`,
);
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
if (!tag?.startsWith('v')) throw new Error('缺少增强引擎发布标签');
const release = await findReleaseByTag(tag, async (_method, path) =>
  JSON.parse(
    execFileSync('gh', ['api', `repos/weq-devs/WeQ${path}`, '--jq', 'map({id,tag_name,draft})'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  ),
);
if (release?.draft !== true) throw new Error('只允许向发布草稿上传增强包，不改写已发布版本');
const { parseEnhancementCatalog } = await tsImport(
  '../apps/desktop/src/shared/enhancement_release.ts',
  import.meta.url,
);
const catalog = parseEnhancementCatalog({
  ...manifest,
  packs: manifest.packs.filter((pack) => pack.id !== 'dress'),
});
const assets = [];
for (const engine of manifest.engines) {
  if (!engine.url.startsWith(`https://github.com/weq-devs/WeQ/releases/download/${tag}/`))
    throw new Error('增强引擎发布目标不匹配');
  const path = join(directory, basename(engine.url));
  if ((await hashEnhancementFile(path)) !== engine.sha256)
    throw new Error('增强引擎发布前哈希校验失败');
  assets.push(path);
}
const manifestPath = join(directory, `enhancement-engines-${manifest.target}.json`);
await copyFile(join(directory, 'manifest.json'), manifestPath);
const catalogPath = join(directory, `enhancement-packs-${manifest.target}.json`);
const { writeFile } = await import('node:fs/promises');
await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
execFileSync('gh', ['release', 'upload', tag, manifestPath, catalogPath, ...assets, '--clobber'], {
  stdio: 'inherit',
});
