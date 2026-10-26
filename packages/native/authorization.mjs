/** 旧 native manifest 可以没有助手；新助手必须有校验值，不能降级成无校验下载。 */
export const AUTHORIZATION_PROTOCOL = 1;
export const AUTHORIZATION_TARGETS = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};
export const authorizationExecutable = (platform) =>
  platform.startsWith('win32-') ? 'weq-authorization-helper.exe' : 'weq-authorization-helper';

export function validateNativeBuildInfo(
  info,
  { production = false, expected, now = Date.now() / 1000 } = {},
) {
  if (
    production &&
    (info?.isDev !== false ||
      !Number.isSafeInteger(info.buildTime) ||
      info.buildTime <= 0 ||
      !Number.isSafeInteger(info.expireTime) ||
      !Number.isSafeInteger(info.validitySecs) ||
      info.validitySecs <= 0 ||
      info.expireTime - info.buildTime !== info.validitySecs ||
      info.expireTime <= now)
  )
    throw new Error('原生组件不是有效的发布构建');
  if (expected)
    for (const key of ['buildTime', 'expireTime', 'validitySecs', 'isDev'])
      if ((info?.[key] ?? null) !== (expected[key] ?? null))
        throw new Error('原生组件构建信息与发布清单不一致');
}

export function validateAuthorizationBuildInfo(info, platform, options = {}) {
  if (
    !AUTHORIZATION_TARGETS[platform] ||
    info?.target !== AUTHORIZATION_TARGETS[platform] ||
    info.protocol !== AUTHORIZATION_PROTOCOL ||
    !['attach', 'key-scan', 'capture'].every((name) => info.capabilities?.includes(name))
  )
    throw new Error(`权限助手目标或协议不兼容：${platform}`);
  if (options.expected && ['protocol', 'target'].some((key) => info[key] !== options.expected[key]))
    throw new Error('权限助手构建信息与发布清单不一致');
  validateNativeBuildInfo(info, options);
}

export function authorizationArtifact(manifest, platform, directory, { required = false } = {}) {
  const meta = manifest.authorization?.[platform];
  if (meta == null) {
    if (required) throw new Error(`发布清单缺少必需的权限助手：${platform}`);
    return null;
  }
  const executable = authorizationExecutable(platform);
  if (
    meta.asset !==
      `weq-authorization-helper-${platform}${platform.startsWith('win32-') ? '.exe' : ''}` ||
    !/^[a-f0-9]{64}$/.test(meta.sha256 ?? '') ||
    !Number.isSafeInteger(meta.size) ||
    meta.size <= 0 ||
    meta.size > 64 * 1024 * 1024
  )
    throw new Error(`权限助手清单无效：${platform}`);
  if (required) {
    validateAuthorizationBuildInfo(meta, platform, { production: true });
    if (
      Date.parse(manifest.buildTime) / 1000 !== meta.buildTime ||
      Date.parse(manifest.expiresAt) / 1000 !== meta.expireTime
    )
      throw new Error('权限助手与普通原生模块不是同源有效期');
  }
  return {
    label: `authorization/${platform}`,
    path: `${directory}/${executable}`,
    asset: meta.asset,
    sha256: meta.sha256,
    size: meta.size,
    executable: true,
  };
}
