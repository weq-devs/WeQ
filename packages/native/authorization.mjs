/** 旧 native manifest 可以没有助手；新助手必须有校验值，不能降级成无校验下载。 */
export const AUTHORIZATION_PROTOCOL = 2;
/**
 * 权限助手接口版本，必须与 nt_helper 的 `common::AUTHORIZATION_INTERFACE` 保持一致。
 *
 * 它和 `AUTHORIZATION_PROTOCOL` 分工不同：protocol 只保证连接能建立，interface 才
 * 代表请求/响应字段与操作语义兼容。接口契约变化时递增这里和 native 侧常量，已安装
 * 的旧助手会因此进入 `needs-repair`，而不是继续被静默使用。
 */
export const AUTHORIZATION_INTERFACE = 1;
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
    // 发布清单目前不透传 `interface`；缺字段时按兼容处理，二进制自报值仍严格比对。
    (info.interface ?? AUTHORIZATION_INTERFACE) !== AUTHORIZATION_INTERFACE ||
    !['attach', 'key-scan', 'capture'].every((name) => info.capabilities?.includes(name))
  )
    throw new Error(`权限助手目标、协议或接口不兼容：${platform}`);
  if (options.expected) {
    // `interface` 是后加的元数据，已发布的旧清单可能没有它；缺失时仍由上面的常量
    // 校验与 validateAuthorizationContract() 保证兼容，不能把缺字段当成不兼容。
    const expectedKeys = ['protocol', 'target'];
    if (options.expected.interface !== undefined) expectedKeys.push('interface');
    if (expectedKeys.some((key) => info[key] !== options.expected[key]))
      throw new Error('权限助手构建信息与发布清单不一致');
  }
  validateNativeBuildInfo(info, options);
}

/**
 * 校验「当前 `.node` 报出的接口版本」与「助手报出的接口版本」一致。
 *
 * 发布 / 打包检查里必须调用；老 `.node` 没有这个字段时，`required` 决定是拒绝还是
 * 保持旧包兼容。
 */
export function validateAuthorizationContract(nativeInfo, helperInfo, { required = false } = {}) {
  const interfaceVersion = nativeInfo?.authorizationInterface;
  if (!Number.isSafeInteger(interfaceVersion) || interfaceVersion <= 0) {
    if (required) throw new Error('普通原生模块缺少权限助手接口版本');
    return;
  }
  if (interfaceVersion !== AUTHORIZATION_INTERFACE)
    throw new Error('普通原生模块与客户端的权限助手接口版本不一致');
  if (helperInfo?.interface !== interfaceVersion)
    throw new Error('权限助手的接口版本与普通原生模块不一致');
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
