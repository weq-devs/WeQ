/** 旧 native manifest 可以没有助手；新助手必须有校验值，不能降级成无校验下载。 */
export function authorizationArtifact(manifest, platform, directory) {
  const meta = manifest.authorization?.[platform];
  if (!meta) return null;
  const executable = platform.startsWith('win32-')
    ? 'weq-authorization-helper.exe'
    : 'weq-authorization-helper';
  if (
    !/^[a-zA-Z0-9][\w.-]*$/.test(meta.asset ?? '') ||
    !/^[a-f0-9]{64}$/.test(meta.sha256 ?? '') ||
    !Number.isSafeInteger(meta.size) ||
    meta.size <= 0 ||
    meta.size > 64 * 1024 * 1024
  )
    throw new Error(`权限助手清单无效：${platform}`);
  return {
    label: `authorization/${platform}`,
    path: `${directory}/${executable}`,
    asset: meta.asset,
    sha256: meta.sha256,
    size: meta.size,
    executable: true,
  };
}
