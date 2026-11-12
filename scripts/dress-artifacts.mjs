import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

export function validateDressManifest(manifest, nativePin) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.format !== 'ntdr-v1' ||
    !/^dress-[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifest.tag ?? '') ||
    !/^[a-f0-9]{40}$/.test(manifest.nativeCommit ?? '')
  )
    throw new Error('装扮离线索引清单格式不合法');
  if (nativePin && nativePin.commit !== manifest.nativeCommit)
    throw new Error('装扮索引与 native 版本锚的密钥来源不同，请升级配套清单');
  const url = new URL(manifest.baseUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !url.pathname.endsWith(`/releases/download/${manifest.tag}`)
  )
    throw new Error('装扮索引必须使用明确版本的 HTTPS 下载地址');
  if (
    Object.keys(manifest.parts ?? {})
      .sort()
      .join() !== 'bubble,font,widget'
  )
    throw new Error('装扮索引清单必须完整包含气泡、字体与挂件');
  for (const kind of ['bubble', 'font', 'widget']) {
    const meta = manifest.parts[kind];
    if (
      meta?.asset !== `dress-${kind}.dat` ||
      !/^[a-f0-9]{64}$/.test(meta.sha256 ?? '') ||
      !Number.isSafeInteger(meta.size) ||
      meta.size <= 21
    )
      throw new Error(`装扮索引资产不合法：${kind}`);
  }
  return manifest;
}

export function checkDressManifest(root) {
  return validateDressManifest(
    JSON.parse(readFileSync(join(root, 'resources/dress/index-manifest.json'), 'utf8')),
    JSON.parse(readFileSync(join(root, 'native/pinned.json'), 'utf8')),
  );
}

/** Web 和桌面都不将离线大索引或采集状态带入安装包。 */
export function includeSharedResource(source, resourcesRoot) {
  const path = relative(resourcesRoot, source).split(sep);
  if (path[0] === 'daemon') return false;
  return !(
    path[0] === 'dress' &&
    path.length === 2 &&
    (/\.dat$/.test(basename(source)) ||
      /_resources$/.test(basename(source)) ||
      path[1] === 'fetch-state.json')
  );
}

export function verifyPackagedDressResources(resourcesRoot) {
  const directory = join(resourcesRoot, 'dress');
  validateDressManifest(JSON.parse(readFileSync(join(directory, 'index-manifest.json'), 'utf8')));
  if (
    readdirSync(directory).some(
      (name) => /\.dat$/.test(name) || /_resources$/.test(name) || name === 'fetch-state.json',
    )
  )
    throw new Error('安装包不应包含完整装扮索引或采集状态');
}
