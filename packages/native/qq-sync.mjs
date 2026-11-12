import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 私仓产物的固定分发契约与内容校验。 */
export function qqSyncFiles(bundle) {
  if (bundle?.protocol !== 1 || !/^[a-f0-9]{16}$/.test(bundle.buildId))
    throw new Error('QQ 同步组件协议或构建标识不匹配');
  const expected = {
    'runtime.mjs': 'qq-sync-runtime-win32-x64.mjs',
    'generated/windows/QqSync/current.json': 'qq-sync-current.json',
    [`generated/windows/QqSync/${bundle.buildId}/WeQ.QqSyncHost.exe`]: 'WeQ.QqSyncHost.exe',
    [`generated/windows/QqSync/${bundle.buildId}/WeQ.QqSyncProbe.dll`]: 'WeQ.QqSyncProbe.dll',
  };
  if (
    Object.keys(bundle.files ?? {})
      .sort()
      .join() !== Object.keys(expected).sort().join()
  )
    throw new Error('QQ 同步组件文件清单不匹配');
  return Object.entries(expected).map(([path, asset]) => {
    const meta = bundle.files[path];
    if (
      meta.asset !== asset ||
      !/^[a-f0-9]{64}$/.test(meta.sha256) ||
      !Number.isSafeInteger(meta.size) ||
      meta.size <= 0
    )
      throw new Error('QQ 同步组件文件元数据不合法');
    return { path, asset, sha256: meta.sha256, size: meta.size };
  });
}

export function qqSyncArtifacts(manifest, platform, { required = false } = {}) {
  if (platform !== 'win32-x64') return [];
  const bundle = manifest.qqSync?.[platform];
  if (!bundle) {
    if (required)
      throw new Error(
        '当前原生版本尚未发布 QQ 同步组件，请先发布配套私仓产物并更新 native/pinned.json',
      );
    return [];
  }
  if (
    bundle.asset !== 'qq-sync-win32-x64.json' ||
    !/^[a-f0-9]{64}$/.test(bundle.sha256) ||
    !Number.isSafeInteger(bundle.size) ||
    bundle.size <= 0
  )
    throw new Error('QQ 同步组件分发清单不合法');
  return [
    { path: 'bundle.json', asset: bundle.asset, sha256: bundle.sha256, size: bundle.size },
    ...qqSyncFiles(bundle),
  ].map((entry) => ({
    ...entry,
    path: join('native/qq-sync', entry.path),
    label: `qq-sync/${entry.asset}`,
  }));
}

export function verifyQqSync(root) {
  const bundle = JSON.parse(readFileSync(join(root, 'bundle.json'), 'utf8'));
  for (const entry of qqSyncFiles(bundle)) {
    const bytes = readFileSync(join(root, entry.path));
    if (
      bytes.length !== entry.size ||
      createHash('sha256').update(bytes).digest('hex') !== entry.sha256
    )
      throw new Error('QQ 同步组件内容不匹配，请重新拉取原生产物');
  }
  return join(root, 'runtime.mjs');
}
