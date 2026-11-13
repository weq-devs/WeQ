import { execFileSync } from 'node:child_process';
import { readFile, copyFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashEnhancementFile } from './prepare-enhancement-engines.mjs';

const directory = join(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/desktop/.artifacts/enhancements',
  `${process.platform}-${process.arch}`,
);
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
if (!tag?.startsWith('v')) throw new Error('缺少增强引擎发布标签');
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
execFileSync('gh', ['release', 'upload', tag, manifestPath, ...assets, '--clobber'], {
  stdio: 'inherit',
});
